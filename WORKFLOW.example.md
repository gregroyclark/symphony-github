---
tracker:
  kind: github
  owner: $GITHUB_OWNER
  repo: $GITHUB_REPO
  token: $GITHUB_TOKEN
  auto_create_labels: true
  comment_on_transitions: true
  labels:
    ready: agent-ready
    running: agent-running
    review: human-review
    failed: agent-failed
    done: agent-done
    blocked: agent-blocked

polling:
  interval_ms: 30000

workspace:
  root: ./workspaces
  clone:
    url: $SYMPHONY_REPO_URL
    base_branch: main
    depth: 0

hooks:
  timeout_ms: 60000
  after_create: |
    echo "Workspace created for ${SYMPHONY_ISSUE_IDENTIFIER} at ${SYMPHONY_WORKSPACE_PATH}"
  before_run: |
    git status --short || true
  after_run: |
    git status --short || true

agent:
  max_concurrent_agents: 1
  max_attempts: 1
  max_retry_backoff_ms: 300000
  continuation_delay_ms: 5000

codex:
  command: codex
  args:
    - exec
    - --json
    - --sandbox
    - workspace-write
    - --ask-for-approval
    - never
    - "-"
  turn_timeout_ms: 3600000
  stall_timeout_ms: 300000

server:
  port: 0
---
You are running inside a Symphony GitHub issue workspace.

Issue:
- Identifier: {{ issue.identifier }}
- URL: {{ issue.url }}
- Title: {{ issue.title }}
- Labels: {{ issue.labels | join: ", " }}
- Attempt: {{ attempt }}

Issue body:
{{ issue.description | default: "" }}

Work the issue end to end in this workspace. Preserve unrelated user changes. When code changes are complete, run relevant validation, create a branch and pull request if appropriate, and leave a concise GitHub issue comment with proof of work.
