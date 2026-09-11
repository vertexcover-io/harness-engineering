# Coder

`set-status coder running`. Resolve the coder skill and model from [config.md](config.md).

Read the DOT phase graph from `plan.md`. Ready phases have no incomplete predecessors.
Dispatch all ready phases in one message; after the wave completes, recompute readiness.
One phase = one dispatch = one commit, with TDD iterations for its behaviors. A phase too large for this is a plan defect
to report as blocked, not a reason to introduce step-level dispatch.

## Dispatch

Read [dispatch-preamble.md](dispatch-preamble.md) and substitute its block for `[PREAMBLE]`.
Use this prompt for each phase, with `Agent`'s model resolved from config:

```text
[PREAMBLE]

Invoke <SKILL:coder> with:
- IMPLEMENT_MODE: pipeline-phase
- Mode argument: <MODE_ARG>
- Task: <TASK_CONTEXT>
- Design record: <DESIGN_PATH, omit when planning produced none>
- Plan: <PLAN_PATH>
- Phase file: <PHASE_DIR>/phase-<PHASE_N>.md
- E2E runner report: <HARNESS_DIR>/phase-<PHASE_N>-e2e.json
- PACKAGES: <this phase's package keys>
- ENVIRONMENT: <ENVIRONMENT>
- Dashboard: HARNESS_DIR=<HARNESS_DIR>, NODE_ID=<phase-node-id>, DAG_SCRIPT=<DAG_SCRIPT>

Return files created/modified, test counts, and completed or blocked with the reason.
```

Set each phase node running before dispatch. After each return, read and parse that phase's
runner report yourself; record executed/failed counts, or the phase's skip note.
A worker error or `BLOCKED` stops further dispatch; report the phase or checkout, error,
and next action. Missing completion status, absent/invalid required evidence, a failed E2E
report, or zero executed tests stops the stage as `STAGE_CONTRACT_FAILED`.
Write the phase report, mark the phase done, and continue the graph.
After every phase completes, `write-report coder` and `set-status coder done`.

## Resumed runs

The dispatch unit is one `TARGETS[]` checkout. Dispatch all entries in one message, using each
entry's worktree, config, original `plan`, packages, and supplied feedback instead of a phase file.
Pass `IMPLEMENT_MODE=pipeline-review-fix` in place of `pipeline-phase`.
Instantiate the preamble with that entry's own spec directory so its baseline path is local.
Pass its spec directory for artifacts, `NODE_ID=coder`, and the primary dashboard directory.
Omit design, phase-file, and E2E-report variables that do not exist for this route.
Return each feedback item's disposition as well as files, tests, and completion status.
The resumed contract in [resumed-runs.md](resumed-runs.md) replaces phase evidence checks.
An unresolved feedback item or missing disposition blocks completion of that checkout and the run.
