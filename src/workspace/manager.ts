import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { ServiceConfig } from "../config/service-config.js";
import type { NormalizedIssue, Workspace } from "../domain.js";
import { pathExists, sanitizeWorkspaceKey } from "../utils.js";
import { runShell } from "./hooks.js";

export class WorkspaceManager {
  constructor(private readonly config: ServiceConfig) {}

  async ensureWorkspace(issue: NormalizedIssue): Promise<Workspace> {
    const key = sanitizeWorkspaceKey(issue.identifier);
    const workspacePath = path.resolve(this.config.workspace.root, key);
    if (!isInside(this.config.workspace.root, workspacePath)) {
      throw new Error(`Refusing to create workspace outside root: ${workspacePath}`);
    }

    const existed = await pathExists(workspacePath);
    await mkdir(workspacePath, { recursive: true });

    const workspace = {
      path: workspacePath,
      key,
      createdNow: !existed
    };

    if (!existed) {
      await this.cloneIfConfigured(issue, workspace);
    }

    return workspace;
  }

  async removeWorkspace(workspace: Workspace): Promise<void> {
    if (!isInside(this.config.workspace.root, workspace.path)) {
      throw new Error(`Refusing to remove workspace outside root: ${workspace.path}`);
    }
    await rm(workspace.path, { recursive: true, force: true });
  }

  private async cloneIfConfigured(issue: NormalizedIssue, workspace: Workspace): Promise<void> {
    const cloneUrl = this.config.workspace.clone.url;
    if (!cloneUrl) return;

    const files = await readdir(workspace.path);
    if (files.length > 0) return;

    const depth = this.config.workspace.clone.depth;
    const depthArgs = depth > 0 ? `--depth ${depth}` : "";
    const baseBranch = shellQuote(this.config.workspace.clone.baseBranch);
    const branch = shellQuote(issue.branchName ?? `codex/issue-${issue.number}`);
    const repo = shellQuote(cloneUrl);
    const script = [
      `git clone ${depthArgs} --branch ${baseBranch} ${repo} .`,
      `git checkout -B ${branch}`
    ].join("\n");

    const result = await runShell({
      script,
      cwd: workspace.path,
      timeoutMs: this.config.hooks.timeoutMs,
      env: {}
    });
    if (!result.ok) {
      throw new Error(`Workspace clone failed: ${result.stderr || result.stdout || result.error}`);
    }
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shellQuote(input: string): string {
  return `'${input.replaceAll("'", "'\\''")}'`;
}
