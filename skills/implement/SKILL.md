---
name: implement
description: >
  Build a requested change, an approved plan, one of its phases, or review feedback test-first,
  with independent phases in parallel, and commit each phase. Runs as the pipeline's implement
  stage after planning; also use it directly to build any change.
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

RUN below is the run's name. The input may hold:

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

Read the project's orchestrate config (`orchestrate.config.yaml` or `orchestrate.config.json`
at the repo root). Each package's `commands` holds its
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

## 3. Build the phases in waves

A plan with one phase is built here, inline. With more, build in waves from the `## Phases`
digraph: a wave is every phase whose dependencies are all committed. Dispatch one sub-agent per
phase in the wave, all in one message, in the same worktree. Give each: the paths to its phase
file and `plan.md`, the worktree, the commands, and these parts of this skill: section 2, "For
each phase", "The E2E leg" and section 4, plus the sub-agent rules below when the wave has two
or more phases. The rest of this section is the stage's own work.

Phases in one wave share the worktree, so they must not touch the same file. Planning orders any
two phases that do; still, before dispatching, collect the files each phase's diffs name. When
two phases in a wave share a file, the plan is wrong: build those two one after the other.

A sub-agent in a wave of two or more works around the others:

- It edits only its own phase's files and runs only its own test files, in place of `tdd`'s
  full-suite and full-lint steps. A full test run, typecheck or lint would fail on the other
  phases' half-built work.
- It never runs `git add`, `commit`, `stash`, `checkout` or `reset`, nor a formatter or fixer
  over the whole repo. Those touch the other phases' files.
- It writes its E2E test but does not run it: the phases share one stack.
- It returns `COMPLETED` or `BLOCKED` and every file it created, changed or deleted.

When the wave's sub-agents have all returned:

1. Run the full tests, typecheck and lint once. Fix a failure inline, inside the files of the
   phase it belongs to. A failure you cannot fix there makes that phase `BLOCKED`.
2. Run each phase's E2E leg, one phase at a time. Fix a failure as in step 1; one you cannot
   fix makes that phase `BLOCKED`.
3. Commit each `COMPLETED` phase in phase order, staging only the files its sub-agent returned.
4. When any phase is `BLOCKED`, stop after these commits. Otherwise start the next wave.

A wave of one phase builds that phase whole, checks, E2E and commit included, as below.

For each phase:

- Use `tdd` one behavior at a time. Use the phase's scenarios and levels as written. For
  feedback, reproduce the reported problem before changing code.
- A scenario is done when a test **at its assigned level** ran green. "Already covered by a
  unit test" does not satisfy an integration or E2E scenario; moving one to a cheaper level is
  `BLOCKED`, not a pass.
- Run affected tests and typecheck while iterating. Once the phase is built, run the full
  tests, typecheck and lint. In a wave of two or more, run only the affected tests; the stage
  runs the rest after the wave. Documentation-only changes need the artifact checked, not
  invented tests.
- When building a screen, open the frame the step names first.
- Outside a wave of two or more, commit the phase with its `## Commit` message. Stage only this
  phase's changes and leave unrelated edits alone. In a run this commit needs no question;
  standalone, ask before committing unless the user already allowed it. Never push.

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
