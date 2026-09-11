# Gate Report Format

Write the report to `.harness/<SPEC_NAME>/gate-report-<stage>-<NNN>.md` (e.g.
`gate-report-post-tdd-001.md`). Increment `<NNN>` from the existing reports in that directory.

Emit `<!-- QG:VERDICT:PASS -->`, `<!-- QG:VERDICT:BLOCKED -->`, or
`<!-- QG:VERDICT:STAGNATION -->` for the overall verdict. Per-check markers use
`<!-- QG:CHECK:N:PASS -->` or `<!-- QG:CHECK:N:BLOCKED -->` for N ∈ {1,2,3,7,9,10}, with
`NOT_APPLICABLE` for a justified skip. Checks 4, 5, 6 and 8 are retired. Custom quality-gate replacements owe the same markers.

## Report structure

```markdown
## Quality Gate Report — <stage>

**State:** <git hash> at <timestamp>
**Diff:** <N files changed, M insertions, K deletions>

### Toolchain
One row per package in `PACKAGES` per tool. `Command` is copied from the config, never composed here.

| Package | Tool | Status | Command |
|---------|------|--------|---------|
| web | Type Checker | DECLARED | \<its `typecheck`\> |
| web | Linter | DECLARED | \<its `lint`\> |
| web | Test Suite | DECLARED | \<its `test_all`\> |
| api | Type Checker | DECLARED | \<its `typecheck`\> |

### Results
One row per check, the verdict being the union across packages. Name the failing package in `Current`.

| # | Check | Baseline | Current | Verdict |
|---|-------|----------|---------|---------|
| 1 | Type Checker | exit=0, errors=0 | exit=0, errors=0 (web, api) | PASS |
| 2 | Linter | exit=0, warnings=3 | exit=0, warnings=3 | PASS |
| 3 | Test Suite + Behavior Coverage | exit=0, 42 passed | exit=0, 38 passed, 12/12 matrix IDs covered | PASS |
| 7 | Comment Audit | — | 0 new ignore directives · 3 comments removed | PASS |
| 9 | E2E Tests | — | 12 passed, 0 failed | PASS |
| 10 | Mutation Spot-Check | — | 4/4 mutants killed | PASS |

<!-- QG:VERDICT:PASS -->
**Verdict: PASS**

### Evidence

One block per package per check; the marker carries the check's union verdict.

#### Check 1: Type Checker — package `web`
<!-- QG:CHECK:1:PASS -->
**Command:** the package's `typecheck`, run as `<command> 2>&1; echo "EXIT_CODE=$?"`
**Exit code:** 0
**Summary:** 0 errors

#### Check 2: Linter — package `web`
<!-- QG:CHECK:2:PASS -->
**Command:** the package's `lint`, run the same way
**Exit code:** 0
**Summary:** 0 new warnings (baseline: 3, current: 3)

...


#### Check 10: Mutation Spot-Check (FAIL example)
<!-- QG:CHECK:10:BLOCKED -->
**Mutations:**
| Behavior ID | File | Mutation | Killing test | Result |
|-------------|------|----------|--------------|--------|
| R3 | validator.py | inverted `if amount > 0` | `SC7: rejects a negative amount` | KILLED |
| R5 | pricing.py | return constant `0` | — | SURVIVED |

**BLOCKED:** R5's test passed against a mutant returning 0 — the test does not verify the pricing behavior.
```

## Evidence capture rules

Every check command runs with: `<command> 2>&1; echo "EXIT_CODE=$?"`

For each check, the report includes:
1. **Command run** — copy-pasteable
2. **Exit code** — extracted from `EXIT_CODE=`
3. **Summary metrics** — pass/fail/skip counts, error count. Parse from tool output; do not dump raw output.
4. **Full output only on FAILURE** — on a fail, include the first 20 lines of error output to diagnose. On a pass, summary metrics are enough.

## State snapshot

At the start of every gate run, capture and include in the report:

```bash
git log --oneline -1 2>&1; echo "EXIT_CODE=$?"
git diff --stat 2>&1; echo "EXIT_CODE=$?"
```

The snapshot ties the report to the exact code state the gate ran against.
