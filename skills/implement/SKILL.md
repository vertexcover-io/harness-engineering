---
name: implement
description: Implement a requested change, plan, phase, or review feedback using test-first development. Runs directly in the current conversation or inside an orchestrate worker.
---

# Implement

Build and test the assigned change, then return the result to the caller.

## 1. Identify the assignment

The caller passes `IMPLEMENT_MODE`. When absent, use `manual`; a phase filename, worktree,
or `.harness/` path alone does not select pipeline behavior.

| Mode | Input | Scope |
|---|---|---|
| `manual` | User request, plan, or phase file | The work the user asked to implement |
| `pipeline-phase` | One `phases/phase-N.md`, overall plan, package/environment, report path | That phase's implementation and test scenarios |
| `pipeline-atomic` | Planning's findings, task, package/environment, report path | The single obvious edit planning handed back; no phase file expected |
| `pipeline-review-fix` | Feedback items, original plan, checkout, package/environment | The supplied feedback; the original plan supplies context, not a new implementation assignment |

Pipeline callers also supply `WORKTREE_PATH` and the run's artifact directory. Work in that
checkout. The orchestrator has already joined its baseline; use those measurements without
capturing a replacement. An unknown mode or missing required input follows **When blocked** below.

`--auto` controls interaction, not assignment scope or permission to commit. Follow the caller's
dashboard settings; in auto mode, issue no dashboard commands.

## 2. Load the working instructions

Read `orchestrate.config.json` at the repo root. Resolve commands and package paths through
`skills/orchestrate/references/config.md`, using the supplied `PACKAGES` and `ENVIRONMENT`.
For manual work, select the configured packages owning the assigned files. Missing config or a
declared command that cannot run is a blocker; an omitted command is `NOT_APPLICABLE`, with a reason.

Load `code-quality` before edits and `tdd` before changing code.

Read the assignment and batch the initial reads of its named files and call sites. Follow
additional dependencies as needed. When building a screen, open the supplied design reference
first; a screen you design yourself can pass every test and still be the wrong screen.
Resolve the behavior to implement and the existing tests that exercise it before editing.

### Reading a phase file

A `phases/phase-N.md` is already decomposed; take it as given rather than re-deriving the feature:

- `## Implementation` — the build steps, in order.
- `## Test Scenarios` — `### Unit`, `### API`, `### E2E`, each scenario numbered `SC<n>`. One test
  per scenario, at the altitude it sits under. Carry the id in the test title (`SC12: …`) so a
  reviewer and the quality gate can trace counts back to scenarios without a second file.
- `## Commit` — the commit message.

plan.md, one level up, carries the overview and `## Design References`.

## 3. Implement and check

Use `tdd` one behavior at a time. A phase can require several RED–GREEN–REFACTOR iterations;
the phase is the assignment and commit unit. Use the assignment's agreed test scenarios and
test levels. For feedback, reproduce the reported problem before changing its implementation.

A scenario is done when a test **at its assigned altitude** ran green. "Already covered by a unit
test" does not satisfy an API or E2E scenario; re-homing one to a cheaper altitude is `BLOCKED`,
not a pass. The scenario set is the test budget (`tdd`, Test Budget).

Run affected tests and typecheck while iterating. Once the assignment is implemented, run the
configured full tests, typecheck, and lint. If later fixes change code, rerun the affected checks.
Record command results and distinguish existing baseline failures from regressions.
Documentation-only changes need artifact validation, not invented production-code tests.

### The E2E leg in a pipeline

`tdd` owns when an e2e test is required and what makes one hermetic. In a pipeline the leg also
owes evidence the quality gate can read:

- **The report.** The runner writes its own JSON to the supplied report path,
  `<HARNESS_DIR>/phase-<N>-e2e.json`. The flag each runner needs is in
  `skills/tdd/references/hermetic-e2e.md`. Nothing in the file is hand-authored: a count you
  compose is a claim, and the gate has no use for it.
- **The flow is given.** The phase's `### E2E` block is the finish-line spec; use it verbatim.
  A cross-slice flow from plan.md's `## Acceptance` is yours only when the phase file names it.
  Before creating a spec file, grep the e2e directory for the surface (route, command, topic,
  selector) and extend the existing spec that covers it; a parallel spec for the same flow is
  `BLOCKED`.
- **The environment is the first task, not a blocker.** Bring the stack up with the steps the
  supplied `ENVIRONMENT` declares. Confirm the behavior under test is switched on in that
  environment; a feature behind a flag goes green because the code never ran. Only when setup
  still cannot run — a missing test hook, a build with no sync path — is the phase `BLOCKED`.
- **Code consumed by another program** proves its leg in that consumer, after syncing your build
  into it: `skills/tdd/references/hermetic-e2e.md`, *Testing through a consumer*. A package that
  declares no `test_all` has no runner; its artifact is proven by the consumer's scenario.
- **Skipping.** Only when the phase changes no externally-observable behavior: a pure internal
  refactor, docs, config with no runtime effect. Migrations, new endpoints or jobs, and anything
  on the request path do not qualify. Write `<HARNESS_DIR>/phase-<N>-e2e-skipped.md` naming the
  reason.

## 4. Complete the selected mode

- **`pipeline-phase`:** the runner-written E2E report or its skip note exists. Commit the phase
  using its `## Commit` message and return to the caller, whose review stage sees the combined change.
- **`pipeline-atomic`:** verify the assigned edit. If an E2E suite runs, save its runner JSON
  at the supplied report path; otherwise report why E2E does not apply. A behavior change still
  follows TDD's E2E requirement. Commit the edit with a message describing the task and return
  to the caller, which proceeds to verification. This route skips the separate review stage.
- **`pipeline-review-fix`:** account for every feedback item with its fix and evidence, or a
  reason no change is needed. Run the relevant regression tests, including E2E where behavior
  requires it. No new phase report is owed, because this route has no new phase assignment.
  Commit the fixes before returning so the review stage's commit-range diff includes them.
- **`manual`:** review the completed work using the project's review skill, defaulting to
  `harness:code-review`, with the assignment as scope. Pass through the user's existing commit
  permissions, including for any review preflight or repair commits. Recheck edits made by review.
  Ask before committing unless the user already authorized it.

Pipeline commits use the caller's existing authorization. Stage only this assignment's changes;
leave unrelated edits intact. If nothing changed, report that instead of making an empty commit.
If a required commit is not authorized, return blocked. Pushing and opening a PR remain the caller's work.

## When blocked

Try the configured setup and investigate failures within the assigned scope. If the remaining
problem needs a decision, missing access, or a change of scope:

- In an interactive manual invocation, ask the user the specific unresolved question.
- In a pipeline invocation or under `--auto`, return `BLOCKED` with the evidence, affected
  scenario/item, and next action. The orchestrator owns the halt; do not wait for user input
  inside a worker or report unfinished work as complete.

## Return

Return `COMPLETED` or `BLOCKED`, files changed, checks run with pass/fail counts and justified
skips, evidence paths, and commit SHA(s) when created. Include a disposition for each supplied
feedback item. `COMPLETED` means this assignment met its checks; it is not a pipeline ship verdict.
Load `writing-style` before writing a human-facing report and run its ship-check before returning.
