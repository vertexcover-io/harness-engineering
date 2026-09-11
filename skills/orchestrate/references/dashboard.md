# Dashboard

## Commands

Resolve `DAG_SCRIPT=<plugin-root>/skills/orchestrate/dashboard/dag-update.mjs`, using
`${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}` for the plugin root before changing cwd.
`HARNESS_DIR` is the absolute worktree `.harness/<SPEC_NAME>` directory printed by init.

Every command uses this invocation form; store the script path, not a shell command:
```
Bash("export HARNESS_DIR='<HARNESS_DIR>' && node '<DAG_SCRIPT>' <command> <args>")
```

| Moment | Command and arguments |
|---|---|
| Node starts | `set-status <node> running` |
| Node completes | `write-report <node> '<markdown>'`, then `set-status <node> done` |
| Node skipped | `set-status <node> skipped` |
| Node blocks/fails | `set-status <node> blocked` / `set-status <node> failed` |
| Start server | `serve-start` |
| Successful run ends | `finalize done` |
| Halt ends run | `finalize failed` |

`serve-start` is a foreground call that detaches the server and prints its URL when listening.
Repeated calls reuse the URL and reap finished runs' old servers; finalize stops this run's server.
Pass `HARNESS_DIR`, `NODE_ID`, and `DAG_SCRIPT` to coder sub-agents for child-node updates;
the orchestrator owns top-level transitions. Escape report bodies as literal shell arguments.

## Initialization

Run from the worktree, after it exists:

```
Bash("
  export HARNESS_DIR=$(node '<DAG_SCRIPT>' init '<SPEC_NAME>' '<TASK_CONTEXT summary>' '<BRANCH_NAME>' '<WORKTREE_PATH>')
  node '<DAG_SCRIPT>' add-node setup 'Setup'
  node '<DAG_SCRIPT>' add-node worktree 'Create Worktree' --parent setup
  node '<DAG_SCRIPT>' add-node baseline 'Baseline Metrics' --parent setup --depends-on worktree
  node '<DAG_SCRIPT>' add-node planning 'Design & Plan' --depends-on setup
  node '<DAG_SCRIPT>' add-node coder 'Coder' --depends-on planning
  node '<DAG_SCRIPT>' add-node code-review 'Code Review' --depends-on coder
  node '<DAG_SCRIPT>' add-node verify 'Verify' --depends-on code-review
  node '<DAG_SCRIPT>' add-node quality-gate 'Quality Gate' --depends-on verify
  node '<DAG_SCRIPT>' add-node sync-docs 'Sync Docs' --depends-on quality-gate
  node '<DAG_SCRIPT>' add-node commit-pr 'Commit & PR' --depends-on sync-docs
  node '<DAG_SCRIPT>' add-node retro 'Retro' --depends-on commit-pr
  echo \"$HARNESS_DIR\"
")
```

Store the printed `HARNESS_DIR`.

## Phase nodes

After planning, add one child per phase, with dependencies from the phase graph.
For example, this phase depends on phase-1:
```
Bash("export HARNESS_DIR='<HARNESS_DIR>' && node '<DAG_SCRIPT>' add-node phase-2 'Phase 2: <label>' --parent coder --depends-on phase-1")
```

## Resumed initialization

From the primary worktree, use its rework spec name. Add no phase nodes.

```
Bash("
  export HARNESS_DIR=$(node '<DAG_SCRIPT>' init '<SPEC_NAME>' '<feedback summary>' '<BRANCH_NAME>' '<WORKTREE_PATH>')
  node '<DAG_SCRIPT>' add-node coder 'Apply Feedback'
  node '<DAG_SCRIPT>' add-node code-review 'Code Review' --depends-on coder
  node '<DAG_SCRIPT>' add-node verify 'Verify' --depends-on code-review
  node '<DAG_SCRIPT>' add-node quality-gate 'Quality Gate' --depends-on verify
  node '<DAG_SCRIPT>' add-node sync-docs 'Sync Docs' --depends-on quality-gate
  node '<DAG_SCRIPT>' add-node commit-pr 'Commit & PR' --depends-on sync-docs
  node '<DAG_SCRIPT>' add-node retro 'Retro' --depends-on commit-pr
  echo \"$HARNESS_DIR\"
")
```

## Report bodies

Use these fields for each node's Markdown report. Record actual paths, counts, commands, and
reasons; omit fields that do not apply to the route.

| Node | Report body |
|---|---|
| `worktree` | Worktree path; branch and base branch |
| `baseline` | Baseline path; one row per package with command, exit code, type errors, lint warnings, tests passed/failed/skipped; setup failures |
| `planning` | Design and plan links, phase count and phase names/dependencies; or implement route and recon findings |
| `phase-<N>` | Phase name; summary; files created/modified and changes; tests added/passed; runner-report path and counts or skip reason; decisions and issues |
| `coder` | Completed phases (or resumed checkouts); aggregate files/tests; links to phase reports or feedback dispositions |
| `code-review` | Verdict; assessment; critical/important/minor counts; findings with file:line and cited standards; fixes; full review path |
| `verify` | Verdict; one row per scenario mirroring the proof report, with its evidence reference; one row per reported bug with its disposition and reason; proof-report path; infrastructure started and cleaned up |
| `quality-gate` | Verdict; one row per check with its baseline and current value; gate report path; failures or None |
| `sync-docs` | Documents updated and created, with what changed in each |
| `commit-pr` | Commit SHAs/messages; PR URL/title or reason absent; branch → base; commit/push outcome |
| `retro` | Issue count, MISSED count, ranked findings and report path; or skipped/not produced with reason |
