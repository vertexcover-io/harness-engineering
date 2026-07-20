# Gate Report Format

Write the report to `.harness/runtime/<SPEC_NAME>/gate-report-<stage>-<NNN>.md` (e.g.
`gate-report-post-tdd-001.md`). Increment `<NNN>` from the existing reports in that directory.

The orchestrator greps the machine-parseable markers `<!-- QG:VERDICT:… -->` and
`<!-- QG:CHECK:N:… -->` (N = 1–10) — always emit them.

## Report structure

```markdown
## Quality Gate Report — <stage>

**State:** <git hash> at <timestamp>
**Diff:** <N files changed, M insertions, K deletions>

### Toolchain
| Tool | Status | Command |
|------|--------|---------|
| Type Checker | DETECTED | tsc --noEmit |
| Linter | DETECTED | eslint . |
| Test Suite | DETECTED | npm test |
| Coverage | DETECTED | vitest --coverage |

### Results
| # | Check | Baseline | Current | Verdict |
|---|-------|----------|---------|---------|
| 1 | Type Checker | exit=0, errors=0 | exit=0, errors=0 | PASS |
| 2 | Linter | exit=0, warnings=3 | exit=0, warnings=3 | PASS |
| 3 | Test Suite + Behavior Coverage | exit=0, 42 passed | exit=0, 38 passed, 12/12 matrix IDs covered | PASS |
| 4 | Coverage (diagnostic) | 85.5% | 87.3% (+1.8%) | INFO |
| 5 | Scope Compliance | — | 3 files changed, all in plan | PASS |
| 6 | Plan Compliance | — | 5/5 items verified | PASS |
| 7 | Ignore Comment Audit | — | 0 new ignore comments | PASS |
| 8 | Smoke Test | — | 2/2 passed | PASS |
| 9 | E2E Tests | — | 12 passed, 0 failed | PASS |
| 10 | Mutation Spot-Check | — | 4/4 mutants killed | PASS |

<!-- QG:VERDICT:PASS -->
**Verdict: PASS**

### Evidence

#### Check 1: Type Checker
<!-- QG:CHECK:1:PASS -->
**Command:** `tsc --noEmit 2>&1; echo "EXIT_CODE=$?"`
**Exit code:** 0
**Summary:** 0 errors

#### Check 2: Linter
<!-- QG:CHECK:2:PASS -->
**Command:** `eslint . 2>&1; echo "EXIT_CODE=$?"`
**Exit code:** 0
**Summary:** 0 new warnings (baseline: 3, current: 3)

...

#### Check 4: Coverage (diagnostic example)
<!-- QG:CHECK:4:INFO -->
**Command:** parsed from Check 3 run (`pytest --cov`)
**Summary:** 78.2% (baseline: 85.5%, -7.3%)
**INFO:** Coverage dropped 7.3% → what behavior is missing from the matrix? (never blocks on its own)

#### Check 10: Mutation Spot-Check (FAIL example)
<!-- QG:CHECK:10:FAIL -->
**Mutations:**
| Behavior ID | File | Mutation | Killing test | Result |
|-------------|------|----------|--------------|--------|
| REQ-003 | validator.py | inverted `if amount > 0` | test_REQ_003_rejects_negative | KILLED |
| REQ-005 | pricing.py | return constant `0` | — | SURVIVED |

**BLOCKED:** REQ-005's test passed against a mutant returning 0 — the test does not verify the pricing behavior.
```

## Evidence capture rules

Every check command runs with: `<command> 2>&1; echo "EXIT_CODE=$?"`

For each check, the report includes:
1. **Command run** — copy-pasteable
2. **Exit code** — extracted from `EXIT_CODE=`
3. **Summary metrics** — pass/fail/skip counts, coverage %, error count. Parse from tool output; do not dump raw output.
4. **Full output only on FAILURE** — on a fail, include the first 20 lines of error output to diagnose. On a pass, summary metrics are enough.

## State snapshot

At the start of every gate run, capture and include in the report:

```bash
git log --oneline -1 2>&1; echo "EXIT_CODE=$?"
git diff --stat 2>&1; echo "EXIT_CODE=$?"
```

The snapshot ties the report to the exact code state the gate ran against.
