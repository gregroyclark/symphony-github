export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface NormalizedIssue {
  id: string;
  number: number;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
  raw?: unknown;
}

export interface WorkflowDefinition {
  path: string;
  baseDir: string;
  config: Record<string, unknown>;
  promptTemplate: string;
  mtimeMs: number;
}

export interface Workspace {
  path: string;
  key: string;
  createdNow: boolean;
}

export interface RunResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
}

export interface RuntimeSnapshot {
  workflowPath: string;
  tracker: {
    kind: "github";
    owner: string;
    repo: string;
  };
  running: Array<{
    issueId: string;
    identifier: string;
    startedAt: string;
    attempt: number;
    workspacePath: string;
  }>;
  retrying: Array<{
    issueId: string;
    identifier: string;
    attempt: number;
    dueAt: string;
    error: string | null;
  }>;
  totals: {
    dispatched: number;
    completed: number;
    failed: number;
  };
}
