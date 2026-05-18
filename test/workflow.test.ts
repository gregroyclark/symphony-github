import { describe, expect, it } from "vitest";
import { parseWorkflowDocument } from "../src/config/workflow.js";
import { buildServiceConfig } from "../src/config/service-config.js";
import type { WorkflowDefinition } from "../src/domain.js";

describe("workflow parsing and config", () => {
  it("splits YAML front matter from prompt body", () => {
    const parsed = parseWorkflowDocument(`---
tracker:
  kind: github
  owner: example
  repo: project
---
Hello {{ issue.title }}
`);

    expect(parsed.config).toMatchObject({
      tracker: {
        kind: "github",
        owner: "example",
        repo: "project"
      }
    });
    expect(parsed.body.trim()).toBe("Hello {{ issue.title }}");
  });

  it("resolves env-backed GitHub tracker settings", () => {
    process.env.TEST_GH_OWNER = "octocat";
    process.env.TEST_GH_REPO = "hello-world";
    process.env.TEST_GH_TOKEN = "ghp_test";

    const workflow: WorkflowDefinition = {
      path: "/tmp/WORKFLOW.md",
      baseDir: "/tmp",
      config: {
        tracker: {
          kind: "github",
          owner: "$TEST_GH_OWNER",
          repo: "$TEST_GH_REPO",
          token: "$TEST_GH_TOKEN"
        },
        workspace: {
          root: "./workspaces"
        }
      },
      promptTemplate: "prompt",
      mtimeMs: 1
    };

    const config = buildServiceConfig(workflow);
    expect(config.tracker.owner).toBe("octocat");
    expect(config.tracker.repo).toBe("hello-world");
    expect(config.workspace.root).toBe("/tmp/workspaces");
    expect(config.tracker.auth).toEqual({
      type: "token",
      token: "ghp_test"
    });
  });
});
