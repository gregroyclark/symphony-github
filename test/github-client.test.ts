import { describe, expect, it } from "vitest";
import type { ServiceConfig } from "../src/config/service-config.js";
import { GitHubIssueClient } from "../src/github/client.js";

describe("GitHubIssueClient", () => {
  it("fetches open issues and filters pull requests, inactive labels, and blocked issues", async () => {
    const fetches: string[] = [];
    const client = new GitHubIssueClient(baseConfig(), (async (input: RequestInfo | URL) => {
      fetches.push(String(input));
      return jsonResponse([
        {
          id: 1,
          number: 10,
          state: "open",
          title: "Ready work",
          body: "depends on #9",
          html_url: "https://github.com/acme/project/issues/10",
          labels: [{ name: "agent-ready" }, { name: "P1" }],
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z"
        },
        {
          id: 2,
          number: 11,
          state: "open",
          title: "PR",
          body: "",
          labels: [{ name: "agent-ready" }],
          pull_request: {}
        },
        {
          id: 3,
          number: 12,
          state: "open",
          title: "Blocked",
          body: "",
          labels: [{ name: "agent-ready" }, { name: "agent-blocked" }]
        },
        {
          id: 4,
          number: 13,
          state: "open",
          title: "Unlabeled",
          body: "",
          labels: []
        }
      ]);
    }) as typeof fetch);

    const issues = await client.fetchCandidateIssues();
    expect(fetches[0]).toContain("/repos/acme/project/issues");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      identifier: "GH-10",
      priority: 1,
      state: "agent-ready",
      blockedBy: [{ id: null, identifier: "GH-9", state: null }]
    });
    expect(issues[0].branchName).toContain("codex/issue-10-ready-work");
  });
});

function baseConfig(): ServiceConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    workflowBaseDir: "/tmp",
    tracker: {
      kind: "github",
      owner: "acme",
      repo: "project",
      apiBaseUrl: "https://api.github.test",
      apiVersion: "2022-11-28",
      auth: { type: "token", token: "token" },
      labels: {
        ready: "agent-ready",
        running: "agent-running",
        review: "human-review",
        failed: "agent-failed",
        done: "agent-done",
        blocked: "agent-blocked"
      },
      activeLabels: ["agent-ready", "agent-running"],
      terminalLabels: ["human-review", "agent-failed", "agent-done"],
      autoCreateLabels: true,
      commentOnTransitions: true
    },
    polling: { intervalMs: 30_000 },
    workspace: {
      root: "/tmp/workspaces",
      cleanupTerminal: false,
      clone: { url: null, baseBranch: "main", depth: 0 }
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000
    },
    agent: {
      maxConcurrentAgents: 1,
      maxAttempts: 1,
      maxRetryBackoffMs: 300_000,
      continuationDelayMs: 5_000,
      dryRun: false
    },
    codex: {
      command: "codex",
      args: ["exec", "-"],
      turnTimeoutMs: 3_600_000,
      stallTimeoutMs: 300_000
    },
    server: { port: null },
    logging: { level: "info" }
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}
