---
name: orchestrate
description: Orchestrate end-to-end development from a task to an open PR through a multi-agent pipeline. Use when the user says orchestrate, run the pipeline, or full workflow; supplies a prompt, ticket, PRD, or design document to take to a PR; or passes --auto for an unattended CI run.
argument-hint: "<prompt, ticket URL, or path/to/document> [--auto]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent, AskUserQuestion
---

# Orchestrate

Take a task from a prompt, ticket, or file to an open PR.
Run nine stages in a git worktree, with a live dashboard.
Planning determines the scope; the later stages implement, review, verify, and ship it.

**Announce at start:** "Using the orchestrate skill to run the full development pipeline."

## Rules across every stage

- After planning approval, continue through the remaining stages; each stage defines when it must stop.
- Questions use `AskUserQuestion` so the developer can answer through the question interface.
- Invoke the stage's configured skill.
- Dispatches carry this run's variables; skills own the rules, keeping each contract in one place.
- Any stage writing documents a person reads loads `writing-style` and runs its ship-check; agent-only `design.md` is exempt.

## Auto mode

Set `MODE_ARG=--auto` when the doctor's `AUTO_MODE=true`, otherwise leave it empty.
Pass `MODE_ARG` to invoked skills. In auto mode, apply these overrides to the stage instructions:

- Skip questions and self-approve planning's checkpoints and plan gate.
- Use the current checkout as `WORKTREE_PATH`, capture its `BRANCH_NAME`, and skip worktree creation.
- Skip every dashboard command; set `HARNESS_DIR=<WORKTREE_PATH>/.harness/<SPEC_NAME>` directly and omit dashboard-only variables from dispatches.
- Produce all applicable design, plan, verification, and report artifacts for auditability.
- Log doctor `DEGRADED` and `BLOCKED` verdicts and continue; a later stage diagnoses a prerequisite it needs.
- Hook halts follow the auto-mode handling in [events.md](references/events.md#acting-on-a-fires-output).

Auto mode changes nothing about shipping. Nobody watching is a reason to stop asking questions,
not a reason to leave the PR unopened, and the two callers that run unattended want opposite
things: a review fixer is already on a PR's branch, while a scheduled repo-health job is called
precisely to open one. The commit-pr stage tells those apart by looking, so neither needs a flag.

## Stages, in order

| Stage | id | Runs | Produces | Open |
|---|---|---|---|---|
| Setup | `setup` | main + background script | worktree, spec dir, manifest, baseline.json | [stage-setup.md](references/stage-setup.md) |
| Design & Plan | `planning` | main | design.md, plan.html, plan.md, phases/ | [stage-planning.md](references/stage-planning.md) |
| Coder | `coder` | one sub-agent per phase | code, tests, phase-N-e2e.json | [stage-coder.md](references/stage-coder.md) |
| Code Review | `code-review` | main | review/review.md | [stage-code-review.md](references/stage-code-review.md) |
| Verify | `verify` | sub-agent | proof-report.html | [stage-verify.md](references/stage-verify.md) |
| Quality Gate | `quality-gate` | sub-agent | the gate report | [stage-quality-gate.md](references/stage-quality-gate.md) |
| Sync Docs | `sync-docs` | main | updated docs | [stage-sync-docs.md](references/stage-sync-docs.md) |
| Commit & PR | `commit-pr` | main | commits, PR URL | [stage-commit-pr.md](references/stage-commit-pr.md) |
| Retro | `retro` | sub-agent | retro/report.md | [stage-retro.md](references/stage-retro.md) |

The id is the stage's name everywhere else: its config key, its dashboard node, and the `--stage`
it fires events with. Open the stage's file when you enter the stage. Do not read ahead.
When the caller supplies `TARGETS[]` and an entry stage, use the resume procedure in
[resumed-runs.md](references/resumed-runs.md) after the doctor's verdict.

## Cross-cutting files

- [config.md](references/config.md) — read when resolving a skill, model, command, environment, or hook field from `orchestrate.config.json`.
- [dashboard.md](references/dashboard.md) — read before any dashboard command; it owns initialization, transitions, report bodies, and finalization.
- [events.md](references/events.md) — read during setup and fire at every moment it names; it owns event commands and their output handling.
- [resumed-runs.md](references/resumed-runs.md) — read when the caller supplies `TARGETS[]`; it owns the shared resume contract.

## Summary

Present after commit-pr completes and retro returns, or when a stage ends the run on failure.
On failure, preserve the worktree and report the stage's error, completed work, and next action.
Fire `run-interrupted` if the worktree exists, and finalize an initialized dashboard as failed.
For a resumable pause, follow the owning stage or events.md instead of finalizing the run.
For a resumed run, list each checkout and its results; mark stages not entered as skipped.

```markdown
**Task:** <TASK_CONTEXT summary>
**Worktree:** <WORKTREE_PATH> (branch: <BRANCH_NAME>)

| Stage | Result |
|---|---|
| Setup | Worktree at <path>, baseline captured |
| Design & Plan | <plan.html path>, <phase_count> phases, or implement route |
| Coder | <files> files, <tests> tests |
| Code Review | <verdict> (<findings> findings) |
| Verify | <PASSED/FAILED>, <N> bugs dispositioned |
| Quality Gate | <PASS/BLOCKED/STAGNATION> |
| Sync Docs | <N> updated, <N> created |
| Commit & PR | <PR_URL, noting whether it was opened or already existed, or not created with reason> |
| Retro | <N> issues (<M> MISSED), <report path>, or not produced with reason |

**Issues:** <failures, stagnation, or None>
```

Finalize using [dashboard.md](references/dashboard.md#commands).
