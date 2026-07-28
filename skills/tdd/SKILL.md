---
name: tdd
description: >
  Test-Driven Development. Use for any implementation task — features, bug fixes, refactoring —
  whenever the project's CLAUDE.md signals TDD (mentions of TDD, test-driven, RED-GREEN-REFACTOR,
  "tests first"), or when the user asks for test-first work. Load before writing any production
  code. Its references are also the testing standard: skills reviewing or generating tests read
  references/testing.md and references/anti-patterns.md.
---

# Test-Driven Development

Every line of production code is written in response to a failing test.

**Project overrides.** Read `$ARGUMENTS` if it names a file, else
`.claude/harness/tdd-reference.md` if it exists. Either outranks the defaults below on conflict.

**Load the `code-quality` skill before writing anything** — production code and tests alike.
TDD governs the *order* you write in; `code-quality` governs *what you write*.

**References** — read at the point of need:
- `references/testing.md` — what a good test is. The standard for every test you write here.
- `references/anti-patterns.md` — mock and assertion failures to avoid
- `references/integration-e2e.md` — when unit tests aren't enough, and how to write the rest
- `references/hermetic-e2e.md` — e2e suites that provision themselves and fail fast

Dispatched by orchestrate? Your preamble carries the pipeline contracts
(`skills/orchestrate/references/coder-contracts.md`): phase inputs, claims, report artifacts.

---

## Seams — agree where tests go, first

A **seam** is the public boundary you test at: an exported function, an endpoint, a CLI
command. Before writing any test, write down the seams under test and confirm them with the
user (or take them from the plan's test scenarios — they are the seams, already agreed).
No test is written at an unconfirmed seam — that is how testing effort lands on critical paths
instead of every incidental edge.

## RED — write the failing test first

Write one minimal test describing the behavior you want. Run only that test's file. Watch it
**fail** — not error — with a message that matches, because the feature is missing.

- One behavior per test; real code, not mocks (unless a boundary demands it)
- **The title states the claim, not the topic.** Name the concrete input and expected outcome
  so a failure is legible from CI output without opening the file. Match the surrounding
  tests' format.

  ```
  ✗ test_pagination_handles_the_last_page          ← names the topic
  ✓ page 4 of 31 items at 10 per page returns the
    final 1 item - not the empty list an
    off-by-one gives                               ← names the claim
  ```

**Test passes immediately?** If the behavior predates your changes, you're testing existing
behavior — fix the test. If the previous GREEN step's minimum code naturally covers it, keep it
as a regression guard. (Phases that exist to add regression coverage over already-generic code
legitimately pass on first run — that is the one other place a first-run pass is fine.)

**Test errors instead of failing?** Fix the error (missing import, syntax), re-run until it
fails correctly.

**Edit made no difference — the "impossible" result?** If a change you're certain about doesn't
move the result — the test still fails after you fixed the cause, or *still* fails when you
loosen the assertion to accept anything — **stop suspecting your logic and suspect the running
artifact.** You are almost certainly not executing the code you edited: a stale build/cache, an
unsynced consumer copy of a library, or the wrong process. Prove it: drop a unique sentinel
into the code path, rebuild/sync, confirm the sentinel appears. If it doesn't, fix the
build/sync — not the code. The words *"this is impossible"* are the tell.

## GREEN — minimum code to pass

Write the simplest code that makes the test pass. Nothing more: no features no test demands,
no refactoring other code, no anticipating future needs.

**Using unfamiliar APIs?** Look up current documentation (context7 or web search) before
writing the implementation — don't guess signatures from memory.

Re-run the affected test file and confirm it passes. Run the full suite **once**, only when the
task's behaviors are all green — not after every iteration.

**Test still fails?** Fix the implementation, not the test. **Other tests broke?** Fix them now.

## REFACTOR — assess, then clean up

After green — and only after green. Not mandatory every cycle: fix mutations, knowledge
duplication, and deep nesting now; note minor naming for later; leave clean code alone. All
tests stay green throughout; no new behavior.

**Suite consolidation is part of every REFACTOR pass:** merge near-duplicate tests of one
behavior into one parameterized table; delete any test fully subsumed by a stronger one. Test
count may drop — the measure is behavior coverage, not test count.

Fix lint findings in one pass on the touched files; run the full linter once at the end.

For detailed methodology, load the `refactor` skill.

## Repeat

Back to RED for the next behavior — **one seam, one test, one minimal implementation per
cycle.** Never write all the tests first and then all the implementation: bulk-written tests
verify *imagined* behavior and go insensitive to what implementation teaches you. Each test is
a tracer bullet responding to the last cycle.

---

## Bug Fixes

Bugs are the highest-value TDD target — a bug means a behavior wasn't tested.

0. **Investigate**: read the code, trace the reported behavior; don't assume the report is accurate.
1. **RED**: write a test reproducing the bug. Watch it fail with the same symptom.
2. **GREEN**: fix with minimum code. 3. **REFACTOR** if needed.

**Reproduction test passes?** The bug may not exist in current code. Verify the test matches
the reported scenario exactly; if it does, report the bug as not reproducible — don't change
code to satisfy an inaccurate report. Keep the test as a regression guard.

## Refactoring Existing Code

Tests exist: run all (your safety net) → one structural change → run all → repeat. A red test
means you changed behavior — undo, take a smaller step.

No tests (legacy): write **characterization tests** capturing current behavior first, refactor
in small steps keeping them green, then replace them with proper behavior tests
(`references/testing.md`, "Assess testability"). If refactoring reveals a missing behavior
test: stop, RED, GREEN, resume.

## E2E

Any change with an externally-observable effect — UI, API, CLI, job, consumer — gets an e2e
test exercising that effect end-to-end (real services, no mocks at the boundary), and
**authored ≠ run**: a spec file that never executed green does not count as done. If you cannot
run it, the work is blocked — say so plainly; never silently downgrade the scenario to a unit
test to claim completion.

The suite must be hermetic (`references/hermetic-e2e.md`). A **published library** proves its
e2e leg in the consumer repo that mounts it — and the consumer runs its *installed* copy, so
sync your build into the consumer's `node_modules` first or the run proves nothing (pipeline
details: `skills/orchestrate/references/coder-contracts.md`).

## Test Budget

Done = every agreed seam/scenario has its one passing test at its assigned level. Beck's rule:
**test as little as possible to reach the desired level of confidence** — don't write tests
outside the agreed set unless you can state the unique bug an extra one would catch. Tests
respond to *behavior* changes, never structure changes; a behavior-preserving refactor that
breaks a test means the test was coupled to structure — rewrite or delete it.

---

## Red Flags — stop and start over

Any of these means TDD was abandoned — delete the production code and restart from RED:
code written before its test; a test written after the implementation; a test passing on first
run for new behavior (see the RED exceptions); can't explain why the test failed; "tests
later"; "just this once"; "I already manually tested it"; "keep as reference / adapt existing
code"; "already spent X hours, deleting is wasteful" (sunk cost — the time is spent either way;
keeping code you can't trust is the waste).

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test it | Write the API you wish existed. Write the assertion first. Ask the user. |
| Test too complicated | The design is too complicated. Simplify the interface. |
| Must mock everything | Code is too coupled. Use dependency injection. |
| Test setup is huge | Extract factories/helpers. Still complex? Simplify the design. |

## Final Rule

```
Production code exists → a test existed and failed first
Otherwise → not TDD
```
