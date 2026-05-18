import os from "node:os";
import path from "node:path";
import { ConfigError } from "../errors.js";
import type { WorkflowDefinition } from "../domain.js";
import { asRecord, asStringArray, resolvePathFrom, uniqueStrings } from "../utils.js";

export type AuthConfig =
  | { type: "token"; token: string | null }
  | {
      type: "app";
      appId: string;
      installationId: string;
      privateKey: string | null;
      privateKeyPath: string | null;
    };

export interface ServiceConfig {
  workflowPath: string;
  workflowBaseDir: string;
  tracker: {
    kind: "github";
    owner: string;
    repo: string;
    apiBaseUrl: string;
    apiVersion: string;
    auth: AuthConfig;
    labels: {
      ready: string;
      running: string;
      review: string;
      failed: string;
      done: string;
      blocked: string;
    };
    activeLabels: string[];
    terminalLabels: string[];
    autoCreateLabels: boolean;
    commentOnTransitions: boolean;
  };
  polling: {
    intervalMs: number;
  };
  workspace: {
    root: string;
    cleanupTerminal: boolean;
    clone: {
      url: string | null;
      baseBranch: string;
      depth: number;
    };
  };
  hooks: {
    afterCreate: string | null;
    beforeRun: string | null;
    afterRun: string | null;
    beforeRemove: string | null;
    timeoutMs: number;
  };
  agent: {
    maxConcurrentAgents: number;
    maxAttempts: number;
    maxRetryBackoffMs: number;
    continuationDelayMs: number;
    dryRun: boolean;
  };
  codex: {
    command: string;
    args: string[];
    turnTimeoutMs: number;
    stallTimeoutMs: number;
  };
  server: {
    port: number | null;
  };
  logging: {
    level: "debug" | "info" | "warn" | "error";
  };
}

export function buildServiceConfig(workflow: WorkflowDefinition): ServiceConfig {
  const raw = asRecord(resolveEnv(workflow.config));
  const tracker = asRecord(raw.tracker);
  const labels = asRecord(tracker.labels);
  const polling = asRecord(raw.polling);
  const workspace = asRecord(raw.workspace);
  const clone = asRecord(workspace.clone);
  const hooks = asRecord(raw.hooks);
  const agent = asRecord(raw.agent);
  const codex = asRecord(raw.codex);
  const server = asRecord(raw.server);
  const logging = asRecord(raw.logging);

  const kind = stringValue(tracker.kind, "github");
  if (kind !== "github") {
    throw new ConfigError(`Unsupported tracker.kind "${kind}". This implementation supports "github".`);
  }

  const defaultLabels = {
    ready: "agent-ready",
    running: "agent-running",
    review: "human-review",
    failed: "agent-failed",
    done: "agent-done",
    blocked: "agent-blocked"
  };

  const resolvedLabels = {
    ready: stringValue(labels.ready, defaultLabels.ready),
    running: stringValue(labels.running, defaultLabels.running),
    review: stringValue(labels.review, defaultLabels.review),
    failed: stringValue(labels.failed, defaultLabels.failed),
    done: stringValue(labels.done, defaultLabels.done),
    blocked: stringValue(labels.blocked, defaultLabels.blocked)
  };

  const owner = requiredString(tracker.owner, "tracker.owner");
  const repo = requiredString(tracker.repo, "tracker.repo");

  const activeLabels = uniqueStrings(
    asStringArray(tracker.active_labels, [resolvedLabels.ready, resolvedLabels.running])
  );
  const terminalLabels = uniqueStrings(
    asStringArray(tracker.terminal_labels, [
      resolvedLabels.review,
      resolvedLabels.failed,
      resolvedLabels.done
    ])
  );

  return {
    workflowPath: workflow.path,
    workflowBaseDir: workflow.baseDir,
    tracker: {
      kind: "github",
      owner,
      repo,
      apiBaseUrl: stringValue(tracker.api_base_url, "https://api.github.com").replace(/\/+$/, ""),
      apiVersion: stringValue(tracker.api_version, "2022-11-28"),
      auth: buildAuthConfig(tracker, workflow.baseDir),
      labels: resolvedLabels,
      activeLabels,
      terminalLabels,
      autoCreateLabels: booleanValue(tracker.auto_create_labels, true),
      commentOnTransitions: booleanValue(tracker.comment_on_transitions, true)
    },
    polling: {
      intervalMs: integerValue(polling.interval_ms, 30_000, "polling.interval_ms")
    },
    workspace: {
      root: resolvePathFrom(
        workflow.baseDir,
        stringValue(workspace.root, path.join(os.tmpdir(), "symphony_github_workspaces"))
      ),
      cleanupTerminal: booleanValue(workspace.cleanup_terminal, false),
      clone: {
        url: nullableString(clone.url),
        baseBranch: stringValue(clone.base_branch, "main"),
        depth: integerValue(clone.depth, 0, "workspace.clone.depth")
      }
    },
    hooks: {
      afterCreate: nullableString(hooks.after_create),
      beforeRun: nullableString(hooks.before_run),
      afterRun: nullableString(hooks.after_run),
      beforeRemove: nullableString(hooks.before_remove),
      timeoutMs: integerValue(hooks.timeout_ms, 60_000, "hooks.timeout_ms")
    },
    agent: {
      maxConcurrentAgents: integerValue(agent.max_concurrent_agents, 1, "agent.max_concurrent_agents"),
      maxAttempts: integerValue(agent.max_attempts, 1, "agent.max_attempts"),
      maxRetryBackoffMs: integerValue(agent.max_retry_backoff_ms, 300_000, "agent.max_retry_backoff_ms"),
      continuationDelayMs: integerValue(agent.continuation_delay_ms, 5_000, "agent.continuation_delay_ms"),
      dryRun: booleanValue(agent.dry_run, false)
    },
    codex: {
      command: stringValue(codex.command, "codex"),
      args: asStringArray(codex.args, [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "-"
      ]),
      turnTimeoutMs: integerValue(codex.turn_timeout_ms, 3_600_000, "codex.turn_timeout_ms"),
      stallTimeoutMs: integerValue(codex.stall_timeout_ms, 300_000, "codex.stall_timeout_ms")
    },
    server: {
      port: nullableInteger(server.port, "server.port")
    },
    logging: {
      level: logLevelValue(logging.level, "info")
    }
  };
}

function buildAuthConfig(tracker: Record<string, unknown>, baseDir: string): AuthConfig {
  const auth = asRecord(tracker.auth);
  const type = stringValue(auth.type, tracker.app_id || auth.app_id ? "app" : "token");

  if (type === "app") {
    return {
      type: "app",
      appId: requiredString(auth.app_id ?? tracker.app_id, "tracker.auth.app_id"),
      installationId: requiredString(
        auth.installation_id ?? tracker.installation_id,
        "tracker.auth.installation_id"
      ),
      privateKey: nullableString(auth.private_key ?? tracker.private_key),
      privateKeyPath: nullableString(auth.private_key_path ?? tracker.private_key_path)
        ? resolvePathFrom(baseDir, nullableString(auth.private_key_path ?? tracker.private_key_path)!)
        : null
    };
  }

  if (type !== "token") {
    throw new ConfigError(`Unsupported tracker.auth.type "${type}". Use "token" or "app".`);
  }

  return {
    type: "token",
    token: nullableString(auth.token ?? tracker.token)
  };
}

function resolveEnv(value: unknown): unknown {
  if (typeof value === "string") {
    const match = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
    return match ? process.env[match[1]] ?? "" : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveEnv(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveEnv(item)])
    );
  }

  return value;
}

function requiredString(value: unknown, key: string): string {
  const result = nullableString(value);
  if (!result) throw new ConfigError(`Missing required config value: ${key}`);
  return result;
}

function nullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringValue(value: unknown, fallback: string): string {
  return nullableString(value) ?? fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["true", "1", "yes", "on"].includes(value.toLowerCase())) return true;
    if (["false", "0", "no", "off", ""].includes(value.toLowerCase())) return false;
  }
  return fallback;
}

function integerValue(value: unknown, fallback: number, key: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const next = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(next) || next < 0) {
    throw new ConfigError(`Invalid integer config value for ${key}: ${String(value)}`);
  }
  return next;
}

function nullableInteger(value: unknown, key: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return integerValue(value, 0, key);
}

function logLevelValue(value: unknown, fallback: "debug" | "info" | "warn" | "error") {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") return value;
  return fallback;
}
