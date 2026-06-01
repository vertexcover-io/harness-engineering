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

**Context map (if present).** When given a phase file with a `**Files:**` list, resolve the context-map
slice for those files and read it before writing code (the plugin-root var only expands inside hooks, so
resolve the path at load):
```
SCRIPT=$(echo "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/hooks/_lib/context-map.mjs")
node "$SCRIPT" phase-context <files...>     # stdout = block; stderr = CONTEXT_MAP:{INJECTED|EMPTY|NONE}
```
If stdout has a block, it carries the owning `PACKAGE.md` (purpose + flow traces + gotchas) and the
`standards/*.md` rules that apply — follow them (code is authoritative; the block is advisory). Stderr
`CONTEXT_MAP:NONE`/`EMPTY` → no applicable map, proceed normally. (When dispatched by orchestrate this is
already injected into the preamble; do it yourself only when invoked standalone.)


# Test-Driven Development

TDD is the fundamental practice. Every line of production code must be written in response to a failing test.

---

## RED-GREEN-REFACTOR Cycle

### RED: Write Failing Test First

Write one minimal test describing the behavior you want. Run it. Watch it fail.

**Requirements:**
- Test describes one behavior
- Clear name stating what should happen
- Uses real code, not mocks (unless unavoidable)
- Fails for the right reason (feature missing, not a typo or import error)
- If working from a spec with REQ/EDGE IDs, reference the ID in the test name or a comment

```
# Run the test
$ <test-runner> path/to/test

# Confirm:
# - Test FAILS (not errors)
# - Failure message matches what you expect
# - Fails because the feature is missing
```

**Test passes immediately?** If the behavior predates your changes, you're testing existing behavior — fix the test. If the behavior was just introduced in the previous GREEN step (e.g., minimum code naturally covers an edge case), the test is documenting a valid property of new code — keep it as a regression guard.
**Test errors instead of failing?** Fix the error (missing import, syntax), re-run until it fails correctly.

### GREEN: Minimum Code to Pass

Write the simplest code that makes the test pass. Nothing more.

**Using unfamiliar APIs?** Before writing the implementation, look up the library's current documentation using context7 or web search. Don't guess method signatures from memory.

- Don't add features not demanded by a test
- Don't refactor other code
- Don't "improve" beyond what the test requires
- Don't anticipate future needs

```
# Run the test again
$ <test-runner> path/to/test

# Confirm:
# - Test passes
# - ALL other tests still pass
# - Output is clean (no errors, warnings)
```

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
- Don't add new tests (that's the next RED)

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

**Example:**
```
# Bug: Empty email accepted by registration

# RED - reproduce the bug
test('rejects empty email', () => {
  result = register({ email: '' })
  assert result.error == 'Email required'
})
# Fails: got undefined, expected 'Email required'

# GREEN - fix it
def register(data):
    if not data.email.strip():
        return Error('Email required')
    ...
# Passes

# REFACTOR - extract validation if pattern emerges
```

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

## TDD for New Features

Break the feature into small behavioral increments. Each increment follows the full RED-GREEN-REFACTOR cycle.

**Approach:**
1. List the behaviors the feature needs (start with the simplest)
2. Write a failing test for the first behavior
3. Implement minimum code to pass
4. Assess refactoring
5. Write a failing test for the next behavior
6. Continue until the feature is complete

Each cycle should be small enough that "minimum code to pass" is obvious. If you're unsure what the minimum code is, your test is asking for too much at once — break it into smaller behaviors.

---

## TDD with E2E Tests

**E2E TDD is mandatory for every phase that changes production behavior**, not only for UI or HTTP changes. A backend job, a CLI command, a queue consumer, a scheduled task — if it has an externally-observable effect, the e2e test exercises that effect end-to-end (real services, real I/O, no mocks at the boundary).

The phase is BLOCKED until the E2E test passes and the e2e-report artifact is written.

1. **RED**: Write a failing e2e test for the user journey. Infrastructure and dev server must be running. Use accessible locators (role, label, text) and condition-based waits — never CSS selectors or hard-coded delays.
2. **GREEN**: Build the feature — use unit/integration TDD cycles for each component until the e2e test passes.
3. **REFACTOR**: Clean up as usual.

The e2e test defines the finish line. Unit and integration tests are written as needed to build toward it.

### Before writing a new E2E spec: check for duplicates

A flow is identified by the user-visible surface it exercises — a route path, a CLI command, a queue topic, a UI selector chain. Before creating a new spec file:

1. Grep the project's e2e directory for the surface you're about to test (route literal, command name, selector, topic).
2. If a spec already covers that surface, **extend it** with new `test()` cases for the new behavior. Do not create a parallel spec file.
3. Only create a new spec file when the surface is genuinely new.

Duplicate e2e specs for the same flow are a BLOCKED condition — they double maintenance cost and drift apart over time. The reviewer will flag them.

### E2E Report Artifact (mandatory)

After all E2E tests pass, write `.harness/<SPEC_NAME>/e2e-report.json` (gitignored — pipeline working state consumed by functional-verify and quality-gate):

```json
{
  "phase": "<PHASE_N>",
  "timestamp": "<ISO timestamp>",
  "passed": 0,
  "failed": 0,
  "coverage": [
    {
      "req": "REQ-1",
      "description": "<what was tested>",
      "inputs": ["<input1>", "<input2>"],
      "routes": ["/path/exercised"],
      "endpoints": ["POST /api/resource"],
      "verdict": "PASS"
    }
  ],
  "gaps": ["<what this E2E suite did NOT test — user flows skipped, edge cases not covered>"]
}
```

The `gaps` field is as important as `coverage` — it tells functional-verify what to target. Be honest: list input combinations not tried, error paths not exercised, concurrent scenarios not tested, and surface areas not touched.

**Escape hatch — use sparingly.** A phase may skip E2E only if it changes *no externally-observable behavior*: pure internal refactors with identical outputs, doc-only changes, or config changes with no runtime effect. Migrations, new endpoints, new background jobs, and behavior-preserving changes that still touch the request path do NOT qualify. Write `"not_applicable": true, "reason": "<specific why>"` to the e2e-report and be ready to justify it in code review.

---

## Step-Scoped TDD

When invoked with a specific **step** (a subset of a phase), scope your work to that step only:

- Only touch files listed in the step
- Only write tests for the step's behaviors
- Do not implement beyond the step boundary
- Report completion per-step

The RED-GREEN-REFACTOR cycle is unchanged — steps just narrow the scope.

---

## Coverage Verification

### Default: 100% Coverage Required

When checking coverage, verify all metrics — lines, statements, branches, functions. The question when coverage drops is always **"What business behavior am I not testing?"** not "What line am I missing?" Add tests for behaviors and coverage follows naturally.

### When 100% Isn't Achievable

Some code genuinely can't reach 100% in unit tests (SSR paths, platform-specific branches, generated code). When this happens:

1. Document the gap and the reason in the project README or CLAUDE.md
2. Explain where the missing coverage comes from (integration tests, E2E, etc.)
3. Get explicit approval from the project maintainer

The burden of proof is on the requester. 100% is the default.

---

## Why Order Matters

### "I'll write tests after"

Tests written after code pass immediately. A test that passes immediately proves nothing:
- It might test the wrong thing
- It might test implementation, not behavior
- It might miss edge cases you forgot
- You never saw it catch anything

Test-first forces you to see the failure, proving the test actually validates something.

### "I already manually tested it"

Manual testing is ad-hoc and irreproducible:
- No record of what was tested
- Can't re-run when code changes
- Easy to miss cases under pressure
- "It worked when I tried it" is not evidence

Automated tests are systematic and run the same way every time.

### "Deleting X hours of work is wasteful"

Sunk cost fallacy. The time is already gone. Your choices are:
- Delete and rewrite with TDD — high confidence the code works
- Keep it and add tests after — low confidence, likely bugs, technical debt

The "waste" is keeping code you can't trust.

### "Tests after achieve the same goals"

No. Tests-after answer "What did I build?" Tests-first answer "What should I build?"

Tests-after are biased by your implementation. You test what you built, not what's required. You verify edge cases you remembered, not ones you would have discovered by writing tests first.

### "This is too simple to test"

Simple code breaks. The test takes 30 seconds to write. The debugging session when it breaks takes much longer.

### "I need to explore first"

Fine. Exploration is valuable. But throw away the exploration code and start over with TDD. If you keep it, you're testing after.

### "The test is hard to write"

Listen to the test. Hard to test means hard to use. The difficulty is telling you the design needs work — simplify the interface, break up the function, inject the dependency.

---

## Library Suspect Detection (`LIB_SUSPECT`)

Default failure mode: tunneling on the symptom when the lib itself is the
problem. This classifier surfaces "the lib is wrong" as an explicit hypothesis
instead of burning iterations on doomed retries.

**Trigger** — emit `LIB_SUSPECT` only when **all** hold for the same test:
- Failed ≥ 3 times in a row.
- Every failure's stack trace contains a frame inside the *same* external lib.
- Error class is one of: `auth` (401/403), `schema` (shape mismatch),
  `not-found` (404 on a documented endpoint), `import-error`, or `timeout`
  after retries.

**Action:**
1. Stop the TDD loop on this test — do not retry.
2. Write a short diagnosis to `.harness/<SPEC_NAME>/lib-suspect-<lib>.md`:
   lib + version, top-3 stack frames, error class, what you tried.
3. Emit `<!-- LIB_SUSPECT:<library-name>:<error-class> -->` in your report.
4. Return control. Orchestrate re-invokes `library-probe --lib <name>` to
   walk the fallback chain.

**Guards (don't false-positive):**
- Most failures are in *your* code — flip only when the lib frame is
  consistently in the stack.
- Read the docs (context7) first; your call may be wrong, not the lib.
- Different errors on each retry = flailing, not a lib problem. Slow down.

---

## Red Flags — Stop and Start Over

If any of these are happening, TDD has been abandoned. Delete the production code and restart from RED:

- Code written before test
- Test written after implementation
- Test passes immediately on first run
- Can't explain why the test failed
- Tests to be added "later"
- Rationalizing "just this once"
- "I already manually tested it"
- "Keep as reference" or "adapt existing code"
- "Already spent X hours, deleting is wasteful"
- "This is different because..."

---

## When Stuck

| Problem | Solution |
|---------|----------|
| Don't know how to test it | Write the API you wish existed. Write the assertion first. Ask the user. |
| Test too complicated | The design is too complicated. Simplify the interface. |
| Must mock everything | Code is too coupled. Use dependency injection. |
| Test setup is huge | Extract factories/helpers. Still complex? Simplify the design. |
| Don't know where to start | Start with the simplest behavior. What's the first thing this code should do? |
| Feature too large | Break it into smaller behaviors. Each one gets its own RED-GREEN-REFACTOR. |

---

## Verification Checklist

Before marking work complete:

- [ ] Every new function/method has a test that was watched failing first
- [ ] Each test failed for the expected reason (feature missing, not typo)
- [ ] Wrote minimum code to pass each test
- [ ] All tests pass
- [ ] Output is clean (no errors, warnings)
- [ ] Tests use real code (mocks only when unavoidable)
- [ ] Edge cases and error paths are covered
- [ ] Refactoring assessed after each green

Can't check all boxes? You skipped TDD. Start over.

---

## Final Rule

```
Production code exists → a test existed and failed first
Otherwise → not TDD
```
