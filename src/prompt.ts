import { Liquid } from "liquidjs";
import type { NormalizedIssue, Workspace } from "./domain.js";
import type { ServiceConfig } from "./config/service-config.js";

const engine = new Liquid({
  strictFilters: true,
  strictVariables: false
});

export async function renderPrompt(args: {
  template: string;
  issue: NormalizedIssue;
  attempt: number;
  workspace: Workspace;
  config: ServiceConfig;
}): Promise<string> {
  const { template, issue, attempt, workspace, config } = args;
  return engine.parseAndRender(template, {
    issue,
    attempt,
    workspace: {
      path: workspace.path,
      key: workspace.key,
      created_now: workspace.createdNow
    },
    github: {
      owner: config.tracker.owner,
      repo: config.tracker.repo
    },
    labels: config.tracker.labels
  });
}
