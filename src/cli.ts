import { buildServiceConfig } from "./config/service-config.js";
import { loadWorkflow } from "./config/workflow.js";
import { Orchestrator } from "./orchestrator/orchestrator.js";
import { createLogger } from "./logger.js";
import { startStatusServer } from "./server.js";
import { loadEnvFilesForWorkflow } from "./env.js";
import { GitHubIssueClient } from "./github/client.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? "help";
  const workflowPath = argv[1] ?? "WORKFLOW.md";
  loadEnvFilesForWorkflow(workflowPath);

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "validate") {
    const workflow = await loadWorkflow(workflowPath);
    const config = buildServiceConfig(workflow);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          workflowPath: config.workflowPath,
          tracker: {
            kind: config.tracker.kind,
            owner: config.tracker.owner,
            repo: config.tracker.repo,
            labels: config.tracker.labels
          },
          workspaceRoot: config.workspace.root,
          command: [config.codex.command, ...config.codex.args].join(" ")
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const workflow = await loadWorkflow(workflowPath);
  const config = buildServiceConfig(workflow);
  const logger = createLogger(config.logging.level);
  const orchestrator = new Orchestrator(workflowPath, logger);

  if (command === "status") {
    const issues = await orchestrator.status();
    process.stdout.write(
      `${JSON.stringify(
        issues.map((issue) => ({
          identifier: issue.identifier,
          title: issue.title,
          state: issue.state,
          priority: issue.priority,
          labels: issue.labels,
          url: issue.url
        })),
        null,
        2
      )}\n`
    );
    return;
  }

  if (command === "init-labels") {
    const client = new GitHubIssueClient(config);
    await client.ensureManagedLabels();
    process.stdout.write(
      `Created or verified labels for ${config.tracker.owner}/${config.tracker.repo}: ${Object.values(
        config.tracker.labels
      ).join(", ")}\n`
    );
    return;
  }

  if (command === "once") {
    await orchestrator.runOnceAndWait();
    return;
  }

  if (command === "run") {
    await orchestrator.initialize();
    if (config.server.port !== null && config.server.port > 0) {
      startStatusServer(orchestrator, config.server.port, logger);
    }

    process.on("SIGINT", () => orchestrator.stop());
    process.on("SIGTERM", () => orchestrator.stop());
    await orchestrator.runForever();
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function printHelp(): void {
  process.stdout.write(`symphony-github

Usage:
  symphony-github validate [WORKFLOW.md]
  symphony-github init-labels [WORKFLOW.md]
  symphony-github status [WORKFLOW.md]
  symphony-github once [WORKFLOW.md]
  symphony-github run [WORKFLOW.md]

Commands:
  validate  Parse WORKFLOW.md and print the resolved runtime config summary.
  init-labels  Create or verify the managed GitHub labels.
  status    Fetch eligible GitHub issues and print normalized issue rows.
  once      Poll once, dispatch eligible issues up to concurrency, wait, then exit.
  run       Poll continuously and reload WORKFLOW.md when it changes.
`);
}
