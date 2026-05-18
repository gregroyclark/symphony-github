# Symphony GitHub

Symphony GitHub is a local daemon that turns GitHub Issues into always-on coding-agent work. It follows the OpenAI Symphony pattern, but uses GitHub labels instead of Linear states.

Default flow:

```txt
GitHub issue with agent-ready
  -> symphony-github claims it with agent-running
  -> one isolated workspace is created
  -> codex exec receives the rendered WORKFLOW.md prompt
  -> issue moves to human-review or agent-failed
```

This is a trusted-environment tool. The configured agent command runs on your machine inside per-issue workspaces.

## Fastest Setup

Prereqs: Node 20+, Git, a logged-in Codex CLI, and a GitHub token with Issues read/write. If the agent should push branches or open PRs, give the token Contents and Pull requests access too.

```bash
npm install -g github:gerdums/symphony-github
mkdir my-repo-symphony && cd my-repo-symphony
curl -fsSLo WORKFLOW.md https://raw.githubusercontent.com/gerdums/symphony-github/main/WORKFLOW.example.md
cat > .env <<'EOF'
GITHUB_OWNER=OWNER
GITHUB_REPO=REPO
GITHUB_TOKEN=github_pat_or_fine_grained_token
SYMPHONY_REPO_URL=git@github.com:OWNER/REPO.git
EOF
symphony-github validate && symphony-github init-labels && symphony-github run
```

Replace `OWNER`, `REPO`, and `GITHUB_TOKEN`.

Then put work into the queue by adding `agent-ready` to an issue:

```bash
gh issue edit ISSUE_NUMBER --repo OWNER/REPO --add-label agent-ready
```

The daemon auto-creates the managed labels when `init-labels` or `run` starts.

## Commands

```bash
symphony-github validate      # Parse WORKFLOW.md and verify resolved config
symphony-github init-labels   # Create/verify agent-ready, agent-running, etc.
symphony-github status        # Print currently eligible issues
symphony-github once          # Process one poll wave and exit
symphony-github run           # Poll continuously
```

Every command defaults to `./WORKFLOW.md`. Pass another file if needed:

```bash
symphony-github run path/to/WORKFLOW.md
```

The CLI automatically loads `.env` from the current directory and from the directory containing `WORKFLOW.md`. Real environment variables win over `.env` values.

## GitHub Labels

Default labels:

```txt
agent-ready    Issue is eligible for orchestration
agent-running  Symphony GitHub has claimed the issue
human-review   Agent finished and expects human review
agent-failed   Agent exhausted attempts or failed setup
agent-done     Human/project marks work complete
agent-blocked  Do not dispatch
```

You can rename labels in `WORKFLOW.md`.

## Agent Command

The default agent command is:

```yaml
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
```

The rendered issue prompt is sent to stdin. Swap in Claude Code, Aider, OpenCode, or a wrapper script by changing `codex.command` and `codex.args`.

## How Workspaces Are Created

With this `.env` value:

```bash
SYMPHONY_REPO_URL=git@github.com:OWNER/REPO.git
```

each issue gets a clone under `./workspaces/GH-NUMBER`, checked out to a branch like `codex/issue-123-title`.

Without `SYMPHONY_REPO_URL`, Symphony GitHub still creates per-issue directories, but they start empty. For real repo automation, set the clone URL.

## GitHub App Auth

Use GitHub App auth instead of `GITHUB_TOKEN` when you want installation-scoped automation:

```yaml
tracker:
  kind: github
  owner: $GITHUB_OWNER
  repo: $GITHUB_REPO
  auth:
    type: app
    app_id: $GITHUB_APP_ID
    installation_id: $GITHUB_APP_INSTALLATION_ID
    private_key_path: $GITHUB_APP_PRIVATE_KEY_PATH
```

The app needs Issues read/write. If the agent should push branches and create PRs, also grant Contents and Pull requests permissions.

## Install From Source

```bash
git clone git@github.com:gerdums/symphony-github.git
cd symphony-github
npm install
npm run build
node dist/index.js validate WORKFLOW.example.md
```

## What Is Implemented

- GitHub Issues adapter with normalized issue records.
- Label state machine for ready, running, review, failed, done, and blocked.
- PAT and GitHub App installation-token auth.
- Per-issue workspaces with optional cloning and lifecycle hooks.
- Liquid prompt rendering against `issue`, `attempt`, `workspace`, and `github`.
- Configurable agent command, defaulting to `codex exec`.
- Structured JSON logs and optional `/status` HTTP endpoint.
- `validate`, `init-labels`, `status`, `once`, and `run` CLI commands.

## Source References

- OpenAI Symphony spec: https://github.com/openai/symphony/blob/main/SPEC.md
- OpenAI Symphony README: https://github.com/openai/symphony
- GitHub REST Issues API: https://docs.github.com/en/rest/issues/issues
