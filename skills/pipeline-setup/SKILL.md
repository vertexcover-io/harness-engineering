---
name: pipeline-setup
description: >
  Sets up the development pipeline environment. Creates a git worktree, runs the baseline
  metrics (typecheck, lint, test, coverage) using the commands `orchestrate.config.json`
  declares, derives a spec name, and creates the spec artifact directory. Returns all
  environment variables needed by downstream pipeline stages.
argument-hint: "<TASK_CONTEXT string> [setup|baseline]"
allowed-tools: Bash, Read, Write, Glob, Grep, Skill
user-invocable: false
---

# Pipeline Setup

Prepares the environment for a development pipeline run. This skill is invoked at the start of the orchestrate pipeline (Stage 0) but can also be used standalone for any workflow that needs an isolated worktree with baseline metrics.

**Announce at start:** "Setting up pipeline environment."

---

## Input

The first argument is `TASK_CONTEXT` — the resolved task prompt or spec content that describes what
will be built.

A second argument names one **branch** of the steps below. The two halves run at different times:
the fast half must finish before anything else starts, while the metric runs take minutes and
nothing needs their output until the coder stage.

| Branch | Steps | Runs |
|---|---|---|
| `setup` | 1, 2 | synchronously, in the caller's conversation |
| `baseline` | 3 | in a background sub-agent, alongside later stages |
| _(none)_ | all of them, in order | standalone use — the whole environment in one call |

---

## Steps

### 1. Create Worktree — unless the caller already made one

**If the invocation passes a `WORKTREE_PATH`, adopt it**: `cd` into it, read `BRANCH_NAME` from
`git branch --show-current`, and skip to Step 2. Orchestrate creates the worktree before this
skill runs, because its dashboard must be initialised from inside it; creating a second one there
would split the run's artifacts across two checkouts.

Otherwise create one: use the project's own worktree skill when it has one — check `CLAUDE.md` and
the available skills for one that sets up a worktree — otherwise invoke `using-git-worktrees`. Then
`cd` into the worktree.

Store: `WORKTREE_PATH`, `BRANCH_NAME`

### 2. Create the Feature Directory

One directory holds everything — `.harness/<SPEC_NAME>/` (design.md, plan.html, plan.md, phases/,
baseline.json, manifest.json, e2e-report.json, gate-report-*.md, review/,
probes/, verification/). The whole `.harness/` tree is gitignored (knowledge/ excepted);
reviewers read artifacts out-of-band.

Steps:

1. Derive `SPEC_NAME` from task (slugified, e.g., `add-user-auth`). Delete any `baseline.json`
   already in `.harness/<SPEC_NAME>/` — re-running the same spec name reuses the directory, and a
   previous run's file would satisfy the caller's join instantly with a stale toolchain.
2. Create `.harness/<SPEC_NAME>/verification/{screenshots,traces}/`
3. Create `.harness/<SPEC_NAME>/review/`, `.harness/<SPEC_NAME>/phases/`, and
   `.harness/<SPEC_NAME>/design/` (the DAG dashboard already creates `.harness/<SPEC_NAME>/reports/`).
   The planning skill's design scout writes into `design/` during its own step 1 and creates nothing —
   so this call is what gives those files a home inside the worktree.
4. Write manifest skeleton to `.harness/<SPEC_NAME>/manifest.json`. Fill `run_info` from
   `node --experimental-strip-types <plugin-root>/skills/_shared/collect-run-info.ts --json`,
   verbatim — it records what produced this run, and any value it could not read comes back
   `null`:

```json
{
  "spec_name": "<SPEC_NAME>",
  "branch": "<BRANCH_NAME>",
  "worktree": "<WORKTREE_PATH>",
  "started_at": "<ISO8601>",
  "run_info": { "harness": "1.29.0", "andromeda": "master@a2bd8cc", "session": "<uuid>" },
  "pr_number": null,
  "stages": {}
}
```

Downstream stages append `stages.<stage_name> = { started_at, completed_at, outcome }` entries.

Store: `SPEC_NAME`, `SPEC_DIR` (`.harness/<SPEC_NAME>/`), `BASELINE_PATH`, `MANIFEST_PATH`

### 3. Run Baseline Metrics

Commands come from `orchestrate.config.json` at the **repo root** — `typecheck`, `lint`, and
`coverage_all` where there is one, else `test_all`, scoped to the package the run names. Run what it
names; nothing here discovers a runner.

**No config, no run.** When the file does not exist, halt and tell the caller to run `setup-harness`.

**A command that does not resolve is a config error, not a metric.** Exit 127, a missing script, an
uninstalled binary — halt, name the command and its package, and say the config is stale. A command
that ran and came back red is the opposite: that is the baseline, and it records normally.

Record per tool the exit code and the counts it reports, then write the lot to
`.harness/<SPEC_NAME>/baseline.json` — this step owns that file:

```json
{
  "type_check": { "exit": 0, "errors": 0 },
  "lint": { "exit": 0, "warnings": 3 },
  "test": { "exit": 0, "passed": 42, "failed": 0, "skipped": 2 },
  "coverage": { "percent": 85.5 },
  "timestamp": "2026-03-13T..."
}
```

All five keys, every time: a tool the config does not name records `null` rather than being omitted,
because the caller's join checks for them. Measurements only — the commands that produced them stay
in `orchestrate.config.json` and are never copied here.

---

## Outputs

After completion, the following variables are available for downstream stages:

| Variable | Description |
|----------|-------------|
| `WORKTREE_PATH` | Absolute path to the git worktree |
| `BRANCH_NAME` | Name of the worktree branch |
| `SPEC_NAME` | Slugified task name |
| `SPEC_DIR` | Path to `.harness/<SPEC_NAME>/` (all run artifacts, gitignored) |
| `BASELINE_PATH` | Path to `.harness/<SPEC_NAME>/baseline.json` |
| `MANIFEST_PATH` | Path to `.harness/<SPEC_NAME>/manifest.json` |
