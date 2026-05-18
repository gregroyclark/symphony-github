import { describe, expect, it } from "vitest";
import { renderPrompt } from "../src/prompt.js";
import type { ServiceConfig } from "../src/config/service-config.js";
import type { NormalizedIssue, Workspace } from "../src/domain.js";

describe("renderPrompt", () => {
  it("renders Liquid variables for issue and workspace", async () => {
    const prompt = await renderPrompt({
      template: "{{ issue.identifier }}: {{ issue.title }} in {{ workspace.path }} for {{ github.owner }}/{{ github.repo }}",
      issue,
      workspace,
      attempt: 2,
      config
    });

    expect(prompt).toBe("GH-7: Fix bug in /tmp/workspaces/GH-7 for acme/project");
  });
});

const issue: NormalizedIssue = {
  id: "7",
  number: 7,
  identifier: "GH-7",
  title: "Fix bug",
  description: null,
  priority: null,
  state: "agent-ready",
  branchName: "codex/issue-7-fix-bug",
  url: null,
  labels: ["agent-ready"],
  blockedBy: [],
  createdAt: null,
  updatedAt: null
};

const workspace: Workspace = {
  path: "/tmp/workspaces/GH-7",
  key: "GH-7",
  createdNow: true
};

const config = {
  tracker: {
    owner: "acme",
    repo: "project",
    labels: {}
  }
} as ServiceConfig;
