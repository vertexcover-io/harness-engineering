---
name: implement
description: >
  Build the approved plan test-first, one phase at a time, and commit each phase. Runs as the
  pipeline's implement stage, after planning; also use it directly to implement a requested
  change, a plan, one phase, or review feedback.
mode: inline
allowed-tools: [Agent, AskUserQuestion, Bash, Read, Write, Edit, Grep, Glob, Skill]
tier: deep
consumes:
  - artifact: plan
    optional: true
produces:
  - artifact: implementation
protocols: []
scopes: []
---

# Implement

Build and test the assigned change, then report what was built.

## 1. Identify the assignment

RUN below is the run's spec name. The input may hold:

| Field | Meaning |
|---|---|
| `workspace` | the create-workspace stage's output. Work in each repo's `worktreeDir`; without it, work in the current checkout. |
| `phases` | the phase numbers to build. Without it, every phase in the plan. |
| `feedback` | review items to fix. With it, the assignment is those items; the plan supplies context only. Each item is a defect to reproduce; its `fix` is a suggestion, never a reason to change files outside the assignment. An item with `needsDecision: true` is a product question: ask the user what to do before changing code, and record the answer in `implementation.md`, where qa reads it. |

The first that applies is the assignment:

1. `feedback` in the input: fix those items.
2. `.harness/RUN/artifacts/plan.md` exists: build its phases.
3. Otherwise the user's request, or the plan or phase file they name.

## 2. Load the working instructions

Read `orchestrate.config.json` at the repo root. Each package's `commands` holds its
`test_all`, `test_file`, `typecheck` and `lint`; use the packages that own the assigned files.
A missing config or a declared command that cannot run is a blocker. An omitted command is
`NOT_APPLICABLE`, with a reason. The run's baseline, when there is one, is
`.harness/RUN/artifacts/baseline.json`; use it to tell an existing failure from a regression.

Load `code-quality` before edits and `tdd` before changing code.

### Reading the plan

`plan.md` carries the overview, the `## Phases` digraph, `## Design References`, `## ADRs` and
`## Project Docs`. Open every ADR and doc it lists before editing. When a step would go against
an ADR, stop: that is blocked.

A `phases/phase-N.md` is already decomposed; take it as given rather than re-deriving the
feature:

- `## Implementation`: the build steps, in order. Each change is a diff to apply.
- `## Test Scenarios`: `### Unit`, `### Integration`, `### E2E`, each scenario numbered `SCn`.
  One test per scenario, at the level it sits under. Carry the id in the test title
  (`SC12: …`) so a reviewer can trace tests back to scenarios. `### QA Agent` scenarios are not
  yours; the qa stage proves them.
- `## Commit`: the commit message.

## 3. Build, one phase at a time

Order the phases from the `## Phases` digraph: a phase starts only after every phase it depends
on is committed. Never build two phases at once in one worktree.

A plan with one phase is built here, inline. With more, dispatch one sub-agent per phase, one
after another, each given: the paths to its phase file and `plan.md`, the worktree, the
commands, and sections 2 to 4 of this skill. Read each result before starting the next, and
stop at the first `BLOCKED`.

For each phase:

- Use `tdd` one behavior at a time. Use the phase's scenarios and levels as written. For
  feedback, reproduce the reported problem before changing code.
- A scenario is done when a test **at its assigned level** ran green. "Already covered by a
  unit test" does not satisfy an integration or E2E scenario; moving one to a cheaper level is
  `BLOCKED`, not a pass.
- Run affected tests and typecheck while iterating. Once the phase is built, run the full
  tests, typecheck and lint. Documentation-only changes need the artifact checked, not invented
  tests.
- When building a screen, open the frame the step names first.
- Commit the phase with its `## Commit` message. Stage only this phase's changes and leave
  unrelated edits alone. In a run this commit needs no question; standalone, ask before
  committing unless the user already allowed it. Never push.

### The E2E leg

`tdd` owns when an e2e test is required and what makes one hermetic. A phase also owes evidence:

- **The report.** The runner writes its own JSON to `.harness/RUN/artifacts/phase-N-e2e.json`.
  The flag each runner needs is in the `tdd` skill's `references/hermetic-e2e.md`. Nothing in
  the file is hand-written.
- **The flow is given.** The phase's `### E2E` block is the spec; use it as written. Before
  creating a spec file, grep the e2e directory for the surface and extend the spec that covers
  it.
- **The environment is the first task, not a blocker.** Bring the stack up, and confirm the
  behavior under test is switched on. Only when setup still cannot run is the phase `BLOCKED`.
- **Skipping.** Only when the phase changes no behavior seen from outside: an internal
  refactor, docs, config with no runtime effect. Write
  `.harness/RUN/artifacts/phase-N-e2e-skipped.md` naming the reason.

## 4. When blocked

Try the configured setup and investigate within the assigned scope first. When what is left
needs a decision, missing access or a change of scope:

- A sub-agent building a phase returns `BLOCKED` with the evidence, the scenario or step, and
  the next action. It never waits for the user.
- The stage itself asks the user the one open question. When the answer cannot unblock it,
  finish the stage with `--error -` and that evidence. Never report unfinished work as done.

## 5. Report and finish

Load `writing-style`, then write `.harness/RUN/artifacts/implementation.md`:

- one row per phase: `COMPLETED` or `BLOCKED`, its commit SHA, the files changed
- each scenario id and the test that proves it
- each check run, with pass and fail counts, and every justified skip
- the E2E report or skip note per phase
- for feedback, what was done about each item

Finish the stage with `--artifact implementation=artifacts/implementation.md` and one line as
the output: how many phases were built and the last commit. `COMPLETED` means the assignment met
its checks; it is not a verdict that the work can ship.

Standalone, review the finished work with the `code-review` skill, then give the same report in
the reply.
