import { stat } from "node:fs/promises";
import type { ServiceConfig } from "../config/service-config.js";
import { buildServiceConfig } from "../config/service-config.js";
import { loadWorkflow } from "../config/workflow.js";
import type { NormalizedIssue, RuntimeSnapshot, Workspace } from "../domain.js";
import { GitHubIssueClient } from "../github/client.js";
import type { Logger } from "../logger.js";
import { renderPrompt } from "../prompt.js";
import { runAgent } from "../agent/runner.js";
import { sleep, truncate } from "../utils.js";
import { runHook } from "../workspace/hooks.js";
import { WorkspaceManager } from "../workspace/manager.js";
import { labelsForFailed, labelsForReview, labelsForRunning } from "./state-machine.js";

interface RunningEntry {
  issue: NormalizedIssue;
  startedAt: string;
  attempt: number;
  workspace: Workspace;
  promise: Promise<void>;
}

interface RetryEntry {
  issue: NormalizedIssue;
  attempt: number;
  dueAtMs: number;
  error: string | null;
}

export class Orchestrator {
  private config!: ServiceConfig;
  private github!: GitHubIssueClient;
  private workspaceManager!: WorkspaceManager;
  private promptTemplate = "";
  private workflowMtimeMs = 0;
  private stopping = false;
  private readonly running = new Map<string, RunningEntry>();
  private readonly retrying = new Map<string, RetryEntry>();
  private readonly totals = {
    dispatched: 0,
    completed: 0,
    failed: 0
  };

  constructor(
    private readonly workflowPath: string,
    private readonly logger: Logger
  ) {}

  async initialize(): Promise<ServiceConfig> {
    const workflow = await loadWorkflow(this.workflowPath);
    this.config = buildServiceConfig(workflow);
    this.github = new GitHubIssueClient(this.config);
    this.workspaceManager = new WorkspaceManager(this.config);
    this.promptTemplate = workflow.promptTemplate;
    this.workflowMtimeMs = workflow.mtimeMs;
    if (this.config.tracker.autoCreateLabels) {
      await this.github.ensureManagedLabels();
    }
    return this.config;
  }

  async runForever(): Promise<void> {
    await this.initialize();
    this.logger.info("Symphony GitHub started", {
      workflowPath: this.config.workflowPath,
      repo: `${this.config.tracker.owner}/${this.config.tracker.repo}`,
      intervalMs: this.config.polling.intervalMs
    });

    while (!this.stopping) {
      await this.pollOnce();
      await sleep(this.config.polling.intervalMs);
    }

    await this.waitForIdle();
  }

  stop(): void {
    this.stopping = true;
  }

  async pollOnce(): Promise<void> {
    if (!this.config) await this.initialize();
    await this.reloadIfChanged();
    await this.dispatchDueRetries();

    const issues = await this.github.fetchCandidateIssues();
    const candidates = sortIssues(issues).filter(
      (issue) => !this.running.has(issue.id) && !this.retrying.has(issue.id)
    );

    for (const issue of candidates) {
      if (this.availableSlots() <= 0) break;
      this.dispatch(issue, 1, null);
    }
  }

  async runOnceAndWait(): Promise<void> {
    await this.initialize();
    await this.pollOnce();
    await this.waitForIdle();
  }

  async status(): Promise<NormalizedIssue[]> {
    await this.initialize();
    return this.github.fetchCandidateIssues();
  }

  snapshot(): RuntimeSnapshot {
    return {
      workflowPath: this.config.workflowPath,
      tracker: {
        kind: "github",
        owner: this.config.tracker.owner,
        repo: this.config.tracker.repo
      },
      running: [...this.running.values()].map((entry) => ({
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        startedAt: entry.startedAt,
        attempt: entry.attempt,
        workspacePath: entry.workspace.path
      })),
      retrying: [...this.retrying.values()].map((entry) => ({
        issueId: entry.issue.id,
        identifier: entry.issue.identifier,
        attempt: entry.attempt,
        dueAt: new Date(entry.dueAtMs).toISOString(),
        error: entry.error
      })),
      totals: { ...this.totals }
    };
  }

  private dispatch(issue: NormalizedIssue, attempt: number, previousError: string | null): void {
    const promise = this.runIssue(issue, attempt, previousError)
      .catch((error) => {
        this.logger.error("Issue worker crashed", {
          issue: issue.identifier,
          error: String(error)
        });
      })
      .finally(() => {
        this.running.delete(issue.id);
      });

    this.running.set(issue.id, {
      issue,
      startedAt: new Date().toISOString(),
      attempt,
      workspace: { path: "", key: "", createdNow: false },
      promise
    });
  }

  private async runIssue(
    issue: NormalizedIssue,
    attempt: number,
    previousError: string | null
  ): Promise<void> {
    this.totals.dispatched += 1;
    this.logger.info("Dispatching issue", {
      issue: issue.identifier,
      title: issue.title,
      attempt,
      previousError
    });

    let workspace: Workspace | null = null;
    try {
      const runningLabels = labelsForRunning(issue, this.config);
      await this.github.transitionLabels(issue.number, runningLabels.add, runningLabels.remove);
      await this.comment(issue, startComment(issue, attempt));

      workspace = await this.workspaceManager.ensureWorkspace(issue);
      const entry = this.running.get(issue.id);
      if (entry) entry.workspace = workspace;

      await runHook({
        name: "after_create",
        script: workspace.createdNow ? this.config.hooks.afterCreate : null,
        issue,
        workspace,
        config: this.config
      });
      await runHook({
        name: "before_run",
        script: this.config.hooks.beforeRun,
        issue,
        workspace,
        config: this.config,
        extraEnv: { SYMPHONY_ATTEMPT: String(attempt) }
      });

      const prompt = await renderPrompt({
        template: this.promptTemplate,
        issue,
        attempt,
        workspace,
        config: this.config
      });
      const result = await runAgent({
        issue,
        workspace,
        prompt,
        attempt,
        config: this.config,
        logger: this.logger
      });

      await runHook({
        name: "after_run",
        script: this.config.hooks.afterRun,
        issue,
        workspace,
        config: this.config,
        extraEnv: {
          SYMPHONY_ATTEMPT: String(attempt),
          SYMPHONY_AGENT_EXIT_CODE: String(result.exitCode ?? ""),
          SYMPHONY_AGENT_SIGNAL: result.signal ?? ""
        }
      });

      if (result.ok) {
        await this.github.transitionLabels(
          issue.number,
          labelsForReview(this.config).add,
          labelsForReview(this.config).remove
        );
        await this.comment(issue, successComment(issue, result.durationMs, result.stdout));
        this.totals.completed += 1;
        this.logger.info("Issue completed", {
          issue: issue.identifier,
          durationMs: result.durationMs
        });
      } else {
        await this.handleFailure(issue, attempt, summarizeRunFailure(result));
      }
    } catch (error) {
      await this.handleFailure(issue, attempt, String(error));
    }
  }

  private async handleFailure(issue: NormalizedIssue, attempt: number, error: string): Promise<void> {
    if (attempt < this.config.agent.maxAttempts) {
      const nextAttempt = attempt + 1;
      const delay = retryDelay(nextAttempt, this.config.agent.maxRetryBackoffMs);
      this.retrying.set(issue.id, {
        issue,
        attempt: nextAttempt,
        dueAtMs: Date.now() + delay,
        error
      });
      await this.comment(issue, retryComment(issue, nextAttempt, delay, error));
      this.logger.warn("Issue scheduled for retry", {
        issue: issue.identifier,
        nextAttempt,
        delay,
        error: truncate(error, 500)
      });
      return;
    }

    await this.github.transitionLabels(
      issue.number,
      labelsForFailed(this.config).add,
      labelsForFailed(this.config).remove
    );
    await this.comment(issue, failedComment(issue, attempt, error));
    this.totals.failed += 1;
    this.logger.error("Issue failed", {
      issue: issue.identifier,
      attempt,
      error: truncate(error, 500)
    });
  }

  private async dispatchDueRetries(): Promise<void> {
    const now = Date.now();
    for (const [issueId, retry] of [...this.retrying]) {
      if (retry.dueAtMs > now || this.availableSlots() <= 0) continue;
      this.retrying.delete(issueId);
      const refreshed = await this.github.fetchIssue(retry.issue.number);
      const stillActive = this.config.tracker.activeLabels.some((label) =>
        refreshed.labels.includes(label.toLowerCase())
      );
      const nowTerminal = this.config.tracker.terminalLabels.some((label) =>
        refreshed.labels.includes(label.toLowerCase())
      );
      if (!stillActive || nowTerminal) {
        this.logger.info("Skipping retry because issue is no longer active", {
          issue: retry.issue.identifier,
          state: refreshed.state
        });
        continue;
      }
      this.dispatch(refreshed, retry.attempt, retry.error);
    }
  }

  private availableSlots(): number {
    return Math.max(0, this.config.agent.maxConcurrentAgents - this.running.size);
  }

  private async waitForIdle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.allSettled([...this.running.values()].map((entry) => entry.promise));
    }
  }

  private async reloadIfChanged(): Promise<void> {
    const stats = await stat(this.config.workflowPath);
    if (stats.mtimeMs === this.workflowMtimeMs) return;
    const workflow = await loadWorkflow(this.config.workflowPath);
    this.config = buildServiceConfig(workflow);
    this.github = new GitHubIssueClient(this.config);
    this.workspaceManager = new WorkspaceManager(this.config);
    this.promptTemplate = workflow.promptTemplate;
    this.workflowMtimeMs = workflow.mtimeMs;
    this.logger.info("Workflow reloaded", { workflowPath: workflow.path });
  }

  private async comment(issue: NormalizedIssue, body: string): Promise<void> {
    if (!this.config.tracker.commentOnTransitions) return;
    try {
      await this.github.createComment(issue.number, body);
    } catch (error) {
      this.logger.warn("Unable to create issue comment", {
        issue: issue.identifier,
        error: String(error)
      });
    }
  }
}

function sortIssues(issues: NormalizedIssue[]): NormalizedIssue[] {
  return [...issues].sort((a, b) => {
    const priorityA = a.priority ?? Number.MAX_SAFE_INTEGER;
    const priorityB = b.priority ?? Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return Date.parse(a.updatedAt ?? "") - Date.parse(b.updatedAt ?? "");
  });
}

function retryDelay(attempt: number, maxBackoffMs: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempt - 2), maxBackoffMs);
}

function startComment(issue: NormalizedIssue, attempt: number): string {
  return [
    `Symphony GitHub picked up ${issue.identifier}.`,
    "",
    `Attempt: ${attempt}`,
    issue.branchName ? `Workspace branch: \`${issue.branchName}\`` : null
  ]
    .filter(Boolean)
    .join("\n");
}

function successComment(issue: NormalizedIssue, durationMs: number, stdout: string): string {
  const tail = stdout.trim().split(/\r?\n/).filter(Boolean).slice(-20).join("\n");
  return [
    `Symphony GitHub finished ${issue.identifier} and moved it to human review.`,
    "",
    `Duration: ${Math.round(durationMs / 1000)}s`,
    tail ? `\nAgent output tail:\n\n\`\`\`\n${truncate(tail, 4000)}\n\`\`\`` : ""
  ].join("\n");
}

function retryComment(issue: NormalizedIssue, nextAttempt: number, delayMs: number, error: string): string {
  return [
    `Symphony GitHub will retry ${issue.identifier}.`,
    "",
    `Next attempt: ${nextAttempt}`,
    `Delay: ${Math.round(delayMs / 1000)}s`,
    "",
    "Error:",
    "```",
    truncate(error, 4000),
    "```"
  ].join("\n");
}

function failedComment(issue: NormalizedIssue, attempt: number, error: string): string {
  return [
    `Symphony GitHub failed ${issue.identifier} after ${attempt} attempt(s).`,
    "",
    "Error:",
    "```",
    truncate(error, 4000),
    "```"
  ].join("\n");
}

function summarizeRunFailure(result: {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
}): string {
  return [
    result.error ? `Process error: ${result.error}` : null,
    `Exit code: ${result.exitCode ?? "null"}`,
    result.signal ? `Signal: ${result.signal}` : null,
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : null,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : null
  ]
    .filter(Boolean)
    .join("\n\n");
}
