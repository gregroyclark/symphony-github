import type { ServiceConfig } from "../config/service-config.js";
import type { NormalizedIssue, BlockerRef } from "../domain.js";
import { GitHubApiError } from "../errors.js";
import { hasLabel, normalizeLabel, truncate } from "../utils.js";
import { createGitHubAuthProvider, type GitHubAuthProvider } from "./auth.js";

interface GitHubIssueLabel {
  name?: string;
}

interface GitHubIssue {
  id: number;
  number: number;
  html_url?: string;
  state: "open" | "closed";
  title: string;
  body?: string | null;
  labels?: Array<string | GitHubIssueLabel>;
  pull_request?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
}

export class GitHubIssueClient {
  private readonly auth: GitHubAuthProvider;
  private readonly owner: string;
  private readonly repo: string;
  private readonly apiBaseUrl: string;
  private readonly apiVersion: string;

  constructor(
    private readonly config: ServiceConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.owner = config.tracker.owner;
    this.repo = config.tracker.repo;
    this.apiBaseUrl = config.tracker.apiBaseUrl;
    this.apiVersion = config.tracker.apiVersion;
    this.auth = createGitHubAuthProvider(
      config.tracker.auth,
      config.tracker.apiBaseUrl,
      config.tracker.apiVersion,
      fetchImpl
    );
  }

  async fetchCandidateIssues(): Promise<NormalizedIssue[]> {
    const issues = await this.paginate<GitHubIssue>(
      `/repos/${this.owner}/${this.repo}/issues`,
      {
        state: "open",
        sort: "updated",
        direction: "asc",
        per_page: "100"
      }
    );

    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => this.normalizeIssue(issue))
      .filter((issue) => this.hasAnyLabel(issue.labels, this.config.tracker.activeLabels))
      .filter((issue) => !this.hasAnyLabel(issue.labels, this.config.tracker.terminalLabels))
      .filter((issue) => !hasLabel(issue.labels, this.config.tracker.labels.blocked));
  }

  async fetchIssue(number: number): Promise<NormalizedIssue> {
    const issue = await this.request<GitHubIssue>("GET", `/repos/${this.owner}/${this.repo}/issues/${number}`);
    if (!issue) throw new GitHubApiError(`Issue ${number} was not found`, 404, null);
    return this.normalizeIssue(issue);
  }

  async transitionLabels(
    issueNumber: number,
    labelsToAdd: string[],
    labelsToRemove: string[]
  ): Promise<void> {
    if (this.config.tracker.autoCreateLabels) {
      await Promise.all(labelsToAdd.map((label) => this.ensureLabel(label)));
    }

    if (labelsToAdd.length > 0) {
      await this.request("POST", `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels`, {
        body: { labels: labelsToAdd }
      });
    }

    for (const label of labelsToRemove) {
      await this.request(
        "DELETE",
        `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
        { ignoreStatuses: [404] }
      );
    }
  }

  async createComment(issueNumber: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`, {
      body: { body }
    });
  }

  async ensureManagedLabels(): Promise<void> {
    const labels = [
      this.config.tracker.labels.ready,
      this.config.tracker.labels.running,
      this.config.tracker.labels.review,
      this.config.tracker.labels.failed,
      this.config.tracker.labels.done,
      this.config.tracker.labels.blocked
    ];
    await Promise.all(labels.map((label) => this.ensureLabel(label)));
  }

  private async ensureLabel(label: string): Promise<void> {
    await this.request("GET", `/repos/${this.owner}/${this.repo}/labels/${encodeURIComponent(label)}`, {
      ignoreStatuses: [404]
    }).then(async (result) => {
      if (result !== null) return;
      await this.request("POST", `/repos/${this.owner}/${this.repo}/labels`, {
        body: {
          name: label,
          color: labelColor(label),
          description: "Managed by Symphony GitHub"
        },
        ignoreStatuses: [422]
      });
    });
  }

  private normalizeIssue(issue: GitHubIssue): NormalizedIssue {
    const labels = (issue.labels ?? [])
      .map((label) => (typeof label === "string" ? label : label.name ?? ""))
      .filter(Boolean);
    const body = issue.body ?? null;
    const branchLabel = labels.find((label) => normalizeLabel(label).startsWith("branch:"));

    return {
      id: String(issue.id),
      number: issue.number,
      identifier: `GH-${issue.number}`,
      title: issue.title,
      description: body,
      priority: priorityFromLabels(labels),
      state: this.deriveState(issue.state, labels),
      branchName: branchLabel ? branchLabel.slice("branch:".length).trim() : defaultBranchName(issue),
      url: issue.html_url ?? null,
      labels: labels.map(normalizeLabel),
      blockedBy: extractBlockers(body),
      createdAt: issue.created_at ?? null,
      updatedAt: issue.updated_at ?? null,
      raw: issue
    };
  }

  private deriveState(githubState: string, labels: string[]): string {
    if (githubState === "closed") return "closed";
    const known = [
      this.config.tracker.labels.running,
      this.config.tracker.labels.ready,
      this.config.tracker.labels.review,
      this.config.tracker.labels.failed,
      this.config.tracker.labels.done
    ];
    return known.find((label) => hasLabel(labels, label)) ?? "open";
  }

  private hasAnyLabel(issueLabels: string[], wanted: string[]): boolean {
    return wanted.some((label) => hasLabel(issueLabels, label));
  }

  private async paginate<T>(
    route: string,
    query: Record<string, string>
  ): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const rows = await this.request<T[]>("GET", route, {
        query: { ...query, page: String(page) }
      });
      if (!rows) break;
      all.push(...rows);
      if (rows.length < Number(query.per_page ?? 100)) break;
    }
    return all;
  }

  private async request<T = unknown>(
    method: string,
    route: string,
    options: {
      query?: Record<string, string>;
      body?: unknown;
      ignoreStatuses?: number[];
    } = {}
  ): Promise<T | null> {
    const url = new URL(`${this.apiBaseUrl}${route}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": this.apiVersion,
      "User-Agent": "symphony-github"
    };
    const authorization = await this.auth.getAuthorizationHeader();
    if (authorization) headers.Authorization = authorization;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";

    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    if (options.ignoreStatuses?.includes(response.status)) {
      return null;
    }

    const body = await readJsonSafely(response);
    if (!response.ok) {
      throw new GitHubApiError(
        `${method} ${route} failed with HTTP ${response.status}`,
        response.status,
        body
      );
    }
    return body as T;
  }
}

function priorityFromLabels(labels: string[]): number | null {
  for (const label of labels) {
    const normalized = normalizeLabel(label);
    const numeric = normalized.match(/^priority[: -]?(\d+)$/)?.[1] ?? normalized.match(/^p(\d+)$/)?.[1];
    if (numeric) return Number.parseInt(numeric, 10);
  }
  return null;
}

function extractBlockers(body: string | null): BlockerRef[] {
  if (!body) return [];
  const refs = new Map<string, BlockerRef>();
  const patterns = [
    /(?:blocked by|depends on|dependency)\s+#(\d+)/gi,
    /(?:blocked by|depends on|dependency)\s+([A-Z]+-\d+)/gi
  ];

  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const identifier = match[1] ? (match[1].match(/^\d+$/) ? `GH-${match[1]}` : match[1]) : null;
      if (identifier) refs.set(identifier, { id: null, identifier, state: null });
    }
  }
  return [...refs.values()];
}

function defaultBranchName(issue: GitHubIssue): string {
  const slug = issue.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `codex/issue-${issue.number}${slug ? `-${slug}` : ""}`;
}

function labelColor(label: string): string {
  const normalized = normalizeLabel(label);
  if (normalized.includes("ready")) return "0e8a16";
  if (normalized.includes("running")) return "1d76db";
  if (normalized.includes("review")) return "fbca04";
  if (normalized.includes("failed")) return "d73a4a";
  if (normalized.includes("done")) return "5319e7";
  if (normalized.includes("blocked")) return "6a737d";
  return "ededed";
}

async function readJsonSafely(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return truncate(text);
  }
}
