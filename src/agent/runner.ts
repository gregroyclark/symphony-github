import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServiceConfig } from "../config/service-config.js";
import type { NormalizedIssue, RunResult, Workspace } from "../domain.js";
import type { Logger } from "../logger.js";
import { issueEnv } from "../workspace/hooks.js";
import { truncate } from "../utils.js";

export async function runAgent(args: {
  issue: NormalizedIssue;
  workspace: Workspace;
  prompt: string;
  attempt: number;
  config: ServiceConfig;
  logger: Logger;
}): Promise<RunResult> {
  if (args.config.agent.dryRun) {
    const symphonyDir = path.join(args.workspace.path, ".symphony");
    await mkdir(symphonyDir, { recursive: true });
    await writeFile(path.join(symphonyDir, `prompt-attempt-${args.attempt}.md`), args.prompt, "utf8");
    return {
      ok: true,
      exitCode: 0,
      signal: null,
      stdout: "dry run: prompt written",
      stderr: "",
      durationMs: 0
    };
  }

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(args.config.codex.command, args.config.codex.args, {
      cwd: args.workspace.path,
      env: {
        ...process.env,
        ...issueEnv(args.issue, args.workspace, args.config),
        SYMPHONY_ATTEMPT: String(args.attempt)
      },
      stdio: ["pipe", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let lastOutputAt = Date.now();
    let settled = false;

    const turnTimer = setTimeout(() => {
      args.logger.warn("Agent turn timeout reached; terminating", {
        issue: args.issue.identifier,
        timeoutMs: args.config.codex.turnTimeoutMs
      });
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, args.config.codex.turnTimeoutMs);

    const stallTimer = setInterval(() => {
      const elapsed = Date.now() - lastOutputAt;
      if (elapsed > args.config.codex.stallTimeoutMs) {
        args.logger.warn("Agent stall timeout reached; terminating", {
          issue: args.issue.identifier,
          stallTimeoutMs: args.config.codex.stallTimeoutMs
        });
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }
    }, Math.min(args.config.codex.stallTimeoutMs, 30_000));

    child.stdin.end(args.prompt);

    child.stdout.on("data", (chunk) => {
      lastOutputAt = Date.now();
      const text = chunk.toString();
      stdout += text;
      logAgentStream(args.logger, "stdout", args.issue.identifier, text);
    });

    child.stderr.on("data", (chunk) => {
      lastOutputAt = Date.now();
      const text = chunk.toString();
      stderr += text;
      logAgentStream(args.logger, "stderr", args.issue.identifier, text);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(turnTimer);
      clearInterval(stallTimer);
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
      clearTimeout(turnTimer);
      clearInterval(stallTimer);
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

function logAgentStream(logger: Logger, stream: "stdout" | "stderr", issue: string, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      logger.debug("Agent JSON event", { issue, stream, event });
    } catch {
      logger.debug("Agent output", { issue, stream, line: truncate(line, 500) });
    }
  }
}
