# DAG Dashboard Commands

The dashboard script is `skills/orchestrate/dashboard/dag-update.mjs`, resolved as `DAG_SCRIPT`:

```
!`echo "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/skills/orchestrate/dashboard/dag-update.mjs"`
```

**Invoke via `node` directly** (cross-platform — bash, zsh, PowerShell). Never store the command
in a shell variable:

```
Bash("export HARNESS_DIR='<HARNESS_DIR>' && node '<DAG_SCRIPT>' <command> <args>")
```

`HARNESS_DIR` is the absolute `<WORKTREE_PATH>/.harness/<SPEC_NAME>`, printed by `init`.

## Stage-transition pattern (used at every stage)

- **Before a stage/node starts:** `node '<DAG_SCRIPT>' set-status <node> running`
- **After it completes:** `node '<DAG_SCRIPT>' set-status <node> done`
- **On completion, write its report:** `node '<DAG_SCRIPT>' write-report <node> '<markdown>'`
  (formats live in `references/dashboard-report-formats.md`)
- **Skipped stage:** `node '<DAG_SCRIPT>' set-status <node> skipped`
- **Blocked node (e.g. LIB_SUSPECT):** `node '<DAG_SCRIPT>' set-status <node> blocked`

In `--auto` mode, skip ALL `dag-update` calls — no live dashboard in CI.

## Init block (run once, from inside the worktree)

`init` writes `.harness/<SPEC_NAME>/` relative to cwd, so it MUST run with the worktree as
cwd (otherwise the dashboard lands in the main checkout while claims/phase files land in the
worktree — split-brain).

```
Bash("
  export HARNESS_DIR=$(node '<DAG_SCRIPT>' init '<SPEC_NAME>' '<TASK_CONTEXT summary>' unknown unknown)
  node '<DAG_SCRIPT>' add-node setup 'Setup'
  node '<DAG_SCRIPT>' add-node worktree 'Create Worktree' --parent setup
  node '<DAG_SCRIPT>' add-node baseline 'Baseline Metrics' --parent setup --depends-on worktree
  node '<DAG_SCRIPT>' add-node brainstorm 'Brainstorm' --depends-on setup
  node '<DAG_SCRIPT>' add-node library-probe 'Library Probe' --depends-on brainstorm
  node '<DAG_SCRIPT>' add-node planning 'Planning' --depends-on library-probe
  node '<DAG_SCRIPT>' add-node coder 'Coder' --depends-on planning
  node '<DAG_SCRIPT>' add-node code-review 'Code Review' --depends-on coder
  node '<DAG_SCRIPT>' add-node verify-finalize 'Verify & Finalize' --depends-on code-review
  node '<DAG_SCRIPT>' add-node commit-pr 'Commit & PR' --depends-on verify-finalize
  echo \"$HARNESS_DIR\"
")
```

Store the printed `HARNESS_DIR` for all subsequent calls. Phase nodes are added as children of
`coder` after planning (Stage 2), when phases are known:

```
Bash("export HARNESS_DIR='<HARNESS_DIR>' && node '<DAG_SCRIPT>' add-node phase-1 'Phase 1: <label>' --parent coder && node '<DAG_SCRIPT>' add-node phase-2 'Phase 2: <label>' --parent coder --depends-on phase-1")
```

## Start the server (background job)

`serve` holds its process open until `finalize` kills it via `server.pid` (or it receives
SIGINT/SIGTERM), so it MUST be a separate, backgrounded Bash call — foreground would block the
pipeline:

```
Bash("export HARNESS_DIR='<HARNESS_DIR>' && node '<DAG_SCRIPT>' serve", run_in_background=true)
```

## Sub-agent dashboard updates

Sub-agents get `export HARNESS_DIR='<HARNESS_DIR>' NODE_ID='<node-id>'` in their prompt and use
`add-node` (sub-tasks) and `set-status` (progress); the orchestrator owns the top-level stage
transitions.

## Finalize (end of pipeline)

```
Bash("export HARNESS_DIR='<HARNESS_DIR>' && node '<DAG_SCRIPT>' finalize done")
```
