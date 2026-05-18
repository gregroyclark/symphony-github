import { spawn } from "node:child_process";
import type { NormalizedIssue, Workspace, RunResult } from "../domain.js";
import type { ServiceConfig } from "../config/service-config.js";

export async function runHook(args: {
  name: "after_create" | "before_run" | "after_run" | "before_remove";
  script: string | null;
  issue: NormalizedIssue;
  workspace: Workspace;
  config: ServiceConfig;
  extraEnv?: Record<string, string>;
}): Promise<RunResult | null> {
  if (!args.script) return null;

  return runShell({
    script: args.script,
    cwd: args.workspace.path,
    timeoutMs: args.config.hooks.timeoutMs,
    env: {
      ...issueEnv(args.issue, args.workspace, args.config),
      SYMPHONY_HOOK_NAME: args.name,
      ...(args.extraEnv ?? {})
    }
  });
}

export async function runShell(args: {
  script: string;
  cwd: string;
  timeoutMs: number;
  env: Record<string, string>;
}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", args.script], {
      cwd: args.cwd,
      env: { ...process.env, ...args.env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, args.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error: String(error),
        durationMs: Date.now() - started
      });
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0,
        exitCode,
        signal,
        stdout,
        stderr,
        durationMs: Date.now() - started
      });
    });
  });
}

export function issueEnv(
  issue: NormalizedIssue,
  workspace: Workspace,
  config: ServiceConfig
): Record<string, string> {
  return {
    SYMPHONY_TRACKER_KIND: "github",
    SYMPHONY_GITHUB_OWNER: config.tracker.owner,
    SYMPHONY_GITHUB_REPO: config.tracker.repo,
    SYMPHONY_ISSUE_ID: issue.id,
    SYMPHONY_ISSUE_NUMBER: String(issue.number),
    SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
    SYMPHONY_ISSUE_TITLE: issue.title,
    SYMPHONY_ISSUE_URL: issue.url ?? "",
    SYMPHONY_BRANCH_NAME: issue.branchName ?? "",
    SYMPHONY_WORKSPACE_PATH: workspace.path,
    SYMPHONY_WORKSPACE_KEY: workspace.key
  };
}
