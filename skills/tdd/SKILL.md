---
name: tdd
description: >
  Test-Driven Development workflow. Use for ALL code changes — features, bug fixes, and especially
  refactoring — whenever the project's CLAUDE.md indicates TDD is in use. Check the project's
  CLAUDE.md for TDD signals (mentions of TDD, test-driven, RED-GREEN-REFACTOR, "tests first",
  or similar). If TDD is indicated, this skill MUST be loaded before writing any production code.
  Even if the user doesn't explicitly ask for TDD, trigger this skill for any implementation task
  in a TDD-configured project.
---

## Project-Specific Guidelines

1. If `$ARGUMENTS` is a path to an existing file, read it and prioritize
   its guidelines over the defaults below.
2. Otherwise, check if `.claude/harness/tdd-reference.md` exists in the
   project root. If it does, read it and apply its guidelines.
3. If neither exists, use the defaults below.

User-provided guidelines take precedence on conflicts with defaults.

**Tooling commands (if present).** When dispatched by orchestrate, your preamble carries a
`## Tooling commands` block: use the scoped `test_file` / `lint_file` (substitute `{FILE}`) while
iterating and run the full `test_all` / `lint` **once** each, only to confirm green before declaring
the phase done. Standalone (no injected commands) → use the project's documented runner. Don't
restructure working tests to satisfy a strict lint rule on test files — that's the project's
eslint-config concern.


# Test-Driven Development

TDD is the fundamental practice. Every line of production code must be written in response to a failing test.

**Primary input: a `phase-N.md`** (from the planning skill, at `.harness/runtime/<SPEC_NAME>/`; its
committed overview is `plan.md` under `.harness/features/<SPEC_NAME>/`). Read its four sections and
map them: `## Implementation` = the build steps to execute; `## Test Scenarios` (`### Unit` / `### API`
/ `### E2E`, each `S<n>`) = the RED specs, one test per scenario; `## Commit` = the message to use.
The scenarios are already derived and placed — do not re-decompose the feature.

---

## RED-GREEN-REFACTOR Cycle

### RED: Write Failing Test First

Write one minimal test describing the behavior you want. Run it. Watch it fail.

**Requirements:**
- Test describes one behavior
- Clear name stating what should happen
- Uses real code, not mocks (unless unavoidable)
- Fails for the right reason (feature missing, not a typo or import error)
- The test comes from a scenario in the phase's `## Test Scenarios`; name it after that scenario's id
  (`test_S12_<behavior>`) so the reviewer can trace it

Run only this test's file (the scoped `test_file` command, substituting `{FILE}`) and confirm it
**fails** — not errors — with a message that matches, because the feature is missing.

**Test passes immediately?** If the behavior predates your changes, you're testing existing behavior — fix the test. If the behavior was just introduced in the previous GREEN step (e.g., minimum code naturally covers an edge case), the test is documenting a valid property of new code — keep it as a regression guard.
**Guard / confirm-and-guard phase?** A `test:`-commit phase that adds regression coverage over
*already-generic* code (the planning skill's confirm-and-guard case) legitimately has tests that pass
on the first run — there is no production change to make them fail. That is expected here, not an
abandonment signal: keep them as regression guards. This is the one place a first-run pass is fine.
**Test errors instead of failing?** Fix the error (missing import, syntax), re-run until it fails correctly.
**Edit made no difference — the "impossible" result?** If a change you're certain about doesn't move
the result — the test still fails after you fixed the cause, or *still* fails when you loosen the
assertion to accept anything — **stop suspecting your logic and suspect the running artifact.** You are
almost certainly not executing the code you edited: a stale build/cache, an unsynced consumer copy, or
the wrong process. Prove it before re-reading logic — drop a unique sentinel into the code path (a
nonsense string in the message, a distinctive value), rebuild/sync, and confirm the sentinel appears.
If it doesn't, fix the build/sync — not the code. The words *"this is impossible"* are the tell.

### GREEN: Minimum Code to Pass

Write the simplest code that makes the test pass. Nothing more.

**Using unfamiliar APIs?** Before writing the implementation, look up the library's current documentation using context7 or web search. Don't guess method signatures from memory.

- Don't add features not demanded by a test
- Don't refactor other code
- Don't "improve" beyond what the test requires
- Don't anticipate future needs

Re-run the scoped `test_file` and confirm it passes with clean output. Run the full suite (`test_all`)
**once**, only when the phase's behaviors are all green — to confirm
nothing else broke before declaring the phase done. Do not run `test_all` after every iteration.

**Test still fails?** Fix the implementation code, not the test.
**Other tests broke?** Fix them now before continuing.

### REFACTOR: Assess and Clean Up

After green — and only after green — assess whether the code benefits from cleanup.

Refactoring is not mandatory after every green. Assess whether it adds value:

| Priority | Action | Examples |
|----------|--------|----------|
| Critical | Fix now | Mutations, knowledge duplication, >3 levels nesting |
| High | This session | Magic numbers, unclear names, >30 line functions |
| Nice | Later | Minor naming, single-use helpers |
| Skip | Don't change | Already clean code |

**Rules during refactoring:**
- All tests must stay green throughout
- Don't add new behavior
- Don't add tests for new behaviors (that's the next RED) — consolidating existing tests is allowed and encouraged
- Fix lint findings in a single pass (use the scoped `lint_file`), then run full `lint` ONCE — don't re-run the whole-package linter after every individual fix

**Suite consolidation (part of every REFACTOR pass):**
- Merge near-duplicate tests of one behavior into one parameterized table (equivalence partitions + boundaries)
- Delete any test fully subsumed by a stronger or higher-level test
- Record what moved in the phase report: `S3,S4 merged into test_S3; S7 deleted, behavior covered by E2E S12` — the quality gate uses this note to confirm every scenario still maps to a passing test
- Test count may drop. That is expected, not a regression — the gate checks behavior coverage, not test count

For detailed refactoring methodology, load the `refactor` skill.

### Repeat

Back to RED for the next behavior.

---

## TDD for Bug Fixes

Bugs are the highest-value TDD target. A bug means a behavior wasn't tested. The fix is:

0. **Investigate**: Read the relevant code. Trace the reported behavior through the logic. Understand what the code actually does before assuming the bug report is accurate.
1. **RED**: Write a test that reproduces the bug. Watch it fail with the same symptom.
2. **GREEN**: Fix the bug with minimum code. Watch the test pass.
3. **REFACTOR**: Clean up if needed.

The test proves the fix works *and* prevents the bug from returning. Never fix a bug without a failing test first.

**Reproduction test passes?** The bug may not exist in the current code. Verify your test matches the reported scenario exactly. If it does, report that the bug cannot be reproduced — do not introduce unnecessary code changes to satisfy an inaccurate report. Keep the test as a regression guard.

---

## TDD for Refactoring

Refactoring is where TDD provides the most safety. The process differs because you're changing structure, not behavior.

### When Tests Already Exist

1. **Run all tests** — confirm everything passes (your safety net)
2. **Make one structural change** — rename, extract, move, simplify
3. **Run all tests** — confirm everything still passes
4. **Repeat** — one change at a time, tests green after each

If tests break during refactoring, you've changed behavior. Undo and take a smaller step.

### When Tests Don't Exist (Legacy Code)

1. **Write characterization tests** — tests that capture the current behavior, even if the code is messy. These are your safety net.
2. **Run characterization tests** — confirm they pass against the existing code
3. **Refactor in small steps** — keeping characterization tests green
4. **Replace characterization tests** with proper behavior tests once the code is testable

The characterization test protects you while you restructure. It is temporary scaffolding, not the final test suite.

### Refactoring Boundaries

- If refactoring reveals missing behavior tests, stop refactoring, write the test (RED), implement (GREEN), then resume refactoring
- If a refactoring step feels large, break it into smaller steps where tests stay green after each one
- If you can't keep tests green during refactoring, the step is too big

---

## TDD with E2E Tests

**E2E TDD is mandatory for every phase that changes production behavior**, not only for UI or HTTP changes. A backend job, a CLI command, a queue consumer, a scheduled task — if it has an externally-observable effect, the e2e test exercises that effect end-to-end (real services, real I/O, no mocks at the boundary).

The phase is BLOCKED until the E2E test passes and the e2e-report artifact is written.

**Authored ≠ run.** A spec file that was written but never executed does **not** satisfy the phase —
`executed > 0` at the scenario's altitude is the gate (see `references/phase-claims-format.md`:
"Authoring a `.spec.ts` without running it = BLOCKED"). If you author an API/E2E test but cannot run it
(missing test hooks, an unsyncable consumer build, the stack down), the phase is **BLOCKED, not done**:
say so plainly, name the scenario and the concrete reason, and return control. Do not downgrade it to a
unit test, and do not hand-author report numbers — the counts must come from a real runner invocation.

**The environment is the first task of the phase, not a blocker.** A stack that won't start, an
unsynced consumer build, a service that's down — bring it up before concluding anything: read the
project's testing contract (`CLAUDE.md`'s testing/e2e section, a `setup-worktree`-style script) and
follow it. Only *after* you've run that setup and it still can't run — a genuinely missing test hook, a
build that has no documented sync path — is the phase **BLOCKED, not done**.

**Running standalone (no orchestrate gate).** When this skill is invoked directly — not inside the
orchestrate pipeline — there is no downstream `quality-gate` Check 9 to catch a missing/​unrun E2E for
you. You must self-enforce the rule above: an API/E2E scenario that did not run green means you report
the phase as BLOCKED yourself, rather than declaring it done.

1. **RED**: Write a failing e2e test for the user journey. Infrastructure and dev server must be running. Confirm the behavior under test is actually **enabled** in this environment — if it sits behind an env flag or feature gate (a validation that only runs in prod, an entitlement), the harness must turn it on, or the test goes green because the code never ran. A pass whose subject is disabled is a false pass, not a done scenario. Use accessible locators (role, label, text) and condition-based waits — never CSS selectors or hard-coded delays.
2. **GREEN**: Build the feature — use unit/integration TDD cycles for each component until the e2e test passes.
3. **REFACTOR**: Clean up as usual.

**The E2E flow is given, not chosen.** When executing from a `phase-N.md`, its `### E2E` block is the
finish-line spec — use it verbatim; do not invent a journey. Do **not** author E2E for flows in
plan.md's `## System E2E Tests` — those are cross-slice and run after the slices are assembled, not in
this phase. The unit/API tests written along the way are exactly the phase's `### Unit`/`### API`
scenarios — not ad-hoc extras. Before creating a new spec file, grep the e2e directory for the surface
(route, command, topic, selector); if one already covers it, **extend it** — a parallel spec for the
same flow is a BLOCKED condition.

**Published component under test?** When the phase changes a library component that is *rendered or
executed by a separate host app* (not runnable standalone), its E2E leg runs in the **consumer** repo
where it is mounted, and the consumer's installed copy of the library must be rebuilt/synced from the
worktree before that E2E is trusted. See `references/consumer-repo-e2e.md`.

### E2E Report Artifact (mandatory)

After all E2E tests pass, write `.harness/runtime/<SPEC_NAME>/e2e-report.json` (gitignored; consumed
by functional-verify and quality-gate) — numbers derived from the runner's machine output, never
hand-authored:

```json
{
  "phase": "<PHASE_N>", "timestamp": "<ISO>", "passed": 0, "failed": 0,
  "coverage": [{ "scenario": "S12", "description": "<what was tested>", "verdict": "PASS" }],
  "gaps": ["<what this E2E suite did NOT test — flows skipped, edge cases not covered>"]
}
```

`gaps` is as important as `coverage` — it tells functional-verify what to target. Be honest: input
combinations not tried, error paths not exercised, surfaces not touched.

**Escape hatch — use sparingly.** Skip E2E only if the phase changes *no externally-observable
behavior* (pure internal refactor, doc-only, config with no runtime effect). Migrations, new
endpoints/jobs, and any change touching the request path do NOT qualify. Write
`"not_applicable": true, "reason": "<why>"` and be ready to justify it.

**Step-scoped:** when invoked on a step (a subset of a phase), touch only that step's files and
scenarios; the RED-GREEN-REFACTOR cycle is unchanged, just narrower.

---

## Behavior Coverage (not line coverage)

Done = every scenario in the phase's `## Test Scenarios` was **executed by the runner and observed to
pass at its assigned altitude** (Unit / API / E2E): each `S<n>` has its ONE test, named after the
scenario it proves (`test_S12_...` or a name the reviewer can trace to the id), that actually ran green.

**Passing at altitude is not optional.** A scenario placed under `### API` or `### E2E` is done only
when a test *at that altitude* ran green. "The behavior is already covered by a Unit test" does **not**
satisfy an API/E2E scenario — silently re-homing a scenario to a cheaper altitude to reach done is a
**BLOCKED** condition, not a pass. If you cannot run the API/E2E test, the phase is BLOCKED; report it
and return control (see *TDD with E2E Tests* below). Never quietly fold an unrun API/E2E scenario into
a unit test and call the phase complete.

The phase's scenario set is the test
budget — do not write tests outside it unless you can state the unique bug an extra one would catch.

Line/branch coverage is a diagnostic, never a gate. When it drops, the only question is **"what
behavior is missing from the scenario set?"** — never "what line am I missing?" Filler tests to move a
coverage number are a defect.

**Don't-test list** — code with no defect-detection value, intentionally untested:
- Getters/setters and straight field mappers
- Pass-through wrappers that add no logic
- Framework/library behavior (already tested upstream)
- Generated code
- Mock interactions (asserting a mock was called verifies the test, not the code)

**Beck's rule:** test as little as possible to reach the desired level of confidence.
Tests respond to *behavior* changes, never to *structure* changes — if a
behavior-preserving refactor breaks a test, the test was coupled to structure and
should be rewritten or deleted.

**Runner-less producer repos.** A phase may create an artifact in a repo with no test runner
(`"test": "echo no-test"` — a raw JSON/config or types-only package). Never invent a runner there: the
proving scenario lives in the **consumer** phase that imports the artifact and has a runner, exactly
as the planning skill places it. Coverage of that artifact is the consumer's scenario, not an
uncovered-file gap. A **published library component** proven end-to-end through a host app is the
same shape one altitude up — see `references/consumer-repo-e2e.md`.

---

## Red Flags — Stop and Start Over

Any of these means TDD was abandoned. Delete the production code and restart from RED:
code written before its test; a test written after the implementation; a test that passes on its
first run (for new behavior — see the guard-phase exception in RED); can't explain why the test
failed; "tests later"; "just this once"; "I already manually tested it"; "keep as reference / adapt
existing code"; "already spent X hours, deleting is wasteful."

The reasons are not negotiable: a test written after the code passes immediately and proves nothing —
you never saw it catch anything, and it's biased toward what you built, not what was required.
Test-first is the only thing that forces you to watch the failure.

---

## Library Suspect Detection (`LIB_SUSPECT`)

When a test fails ≥3 times in a row with every failure's stack trace inside the *same* external lib
(error class `auth` / `schema` / `not-found` / `import-error` / `timeout`), stop retrying: the lib,
not your code, may be wrong. Emit `<!-- LIB_SUSPECT:<lib>:<error-class> -->` in your report and
return control — orchestrate re-invokes the `library-probe` skill to walk the fallback chain. Guard
against false positives: most failures are in your code, so flip only when the lib frame is
*consistently* in the stack, read the docs (context7) first, and treat a different error on each
retry as flailing, not a lib problem.

---

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test it | Write the API you wish existed. Write the assertion first. Ask the user. |
| Test too complicated | The design is too complicated. Simplify the interface. |
| Must mock everything | Code is too coupled. Use dependency injection. |
| Test setup is huge | Extract factories/helpers. Still complex? Simplify the design. |

---

## Final Rule

```
Production code exists → a test existed and failed first
Otherwise → not TDD
```
