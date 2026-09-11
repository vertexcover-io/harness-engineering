# Design & Plan

1. `set-status planning running`. Invoke the resolved planning skill via `Skill`, with
   `CALLER=orchestrate`, `TASK_CONTEXT`, `SPEC_NAME`, `HARNESS_DIR`, and `MODE_ARG`.
   If planning fails, returns blocked, or the user declines to continue, stop and report the
   reason. A revision at planning's gate stays inside planning.
2. Let planning run its question loop, inline checkpoint, and plan gate. The waiting-status
   hook handles dashboard status around questions. Its step 0 scales the work; let that
   skill decide whether the full plan or implement route fits.
3. When planning returns, with a plan or the implement route, join the baseline using
   [the setup stage's join](stage-setup.md#the-join). This is the only wait on the baseline in the run;
   nothing edits source before it.
4. For a plan, verify `<HARNESS_DIR>/plan.html`, `plan.md`, and
   `phases/phase-*.md` exist. Missing or unreadable output stops the stage as
   `STAGE_CONTRACT_FAILED`, naming the artifact.
   Fire `artifact-created` with kind `plan`, per [events.md](events.md).
5. Read the phase graph from `plan.md`. Add its phase nodes under `coder` with the
   graph's dependencies using [dashboard.md](dashboard.md#phase-nodes).
   `write-report planning`, then `set-status planning done`.

## Implement route

When planning returns atomic work for `implement`, no plan or phase files are expected.
Record the route in the planning report, mark planning done, and set both `coder` and
`code-review` skipped. The baseline is already joined (step 3). Invoke `implement` with `IMPLEMENT_MODE=pipeline-atomic`, the returned recon findings,
`TASK_CONTEXT`, `WORKTREE_PATH`, `HARNESS_DIR`, `PACKAGES`, `ENVIRONMENT`, `MODE_ARG`, and
E2E report path `<HARNESS_DIR>/phase-1-e2e.json`. If implement errors or returns `BLOCKED`,
stop and report the evidence and next action. Enter the verify stage only after `COMPLETED`.

With no phase files, an E2E run uses `phase-1-e2e.json`; without a run, Check 9 is
`NOT_APPLICABLE`. The verify stage still enforces its proof-report contract.

## Carry forward

`PLAN_PATH=<HARNESS_DIR>/plan.md`, `PHASE_DIR=<HARNESS_DIR>/phases`, the phase graph,
and phase count. Carry `DESIGN_PATH` only if planning produced a design record; its short flow
can produce a phase plan without one. For the implement route, carry the recon findings and
mark plan artifacts absent.
