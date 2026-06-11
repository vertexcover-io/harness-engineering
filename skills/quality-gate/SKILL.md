---
name: quality-gate
description: "Post-stage verification with hard pass/fail thresholds. Every claim backed by verbatim command output — no check may be silently absent, skipped, or weakened. Runs after TDD, refactor, and before PR. Reads baseline metrics from .harness/runtime/<SPEC_NAME>/baseline.json."
user-invocable: false
---

# Quality Gate: Tool-Based Verification

Every claim in this report is backed by verbatim command output. No check may be silently absent, skipped, weakened, or overridden by a sub-agent.

**Announce at start:** "Running quality gate checks against baseline metrics."

---

## Inputs

The quality gate receives these parameters from the orchestrator:

- **Baseline file:** `.harness/runtime/<SPEC_NAME>/baseline.json`
- **Spec dir:** `.harness/features/<SPEC_NAME>/` (committed — spec.md, plan.md)
- **Harness dir:** `.harness/runtime/<SPEC_NAME>/` (gitignored — phase-*.md, e2e-report.json, gate reports)
- **Stage:** `post-tdd` | `post-refactor` | `pre-pr`

---

## Evidence Capture

Every check command runs with: `<command> 2>&1; echo "EXIT_CODE=$?"`

For each check, the report includes:
1. **Command run** — copy-pasteable
2. **Exit code** — extracted from `EXIT_CODE=`
3. **Summary metrics** — pass/fail/skip counts, coverage %, error count. Parse from tool output, do not dump raw output.
4. **Full output only on FAILURE** — if a check fails, include the first 20 lines of error output to help diagnose. If it passes, summary metrics are sufficient.

This keeps gate reports compact — no one reads raw `tsc --noEmit` output when it passes with exit 0.

---

## State Snapshot

At the start of every gate run, capture and include in the report:

```bash
git log --oneline -1 2>&1; echo "EXIT_CODE=$?"
git diff --stat 2>&1; echo "EXIT_CODE=$?"
```

This proves the gate ran against the actual current code state.

---

## Baseline Capture (Stage 0)

Run at pipeline start, immediately after worktree setup. Records the starting state so gates can detect regressions.

**Capture these metrics and write to `.harness/runtime/<SPEC_NAME>/baseline.json`:**

```json
{
  "type_check": { "exit": 0, "errors": 0 },
  "lint": { "exit": 0, "warnings": 3 },
  "test": { "exit": 0, "passed": 42, "failed": 0, "skipped": 2 },
  "coverage": { "percent": 85.5 },
  "timestamp": "2026-03-13T..."
}
```

If a tool is not detected, record `null` for that key — do not omit it.

---

## Auto-Detection Logic

Detect project tooling in this order:

1. **Check CLAUDE.md** for explicit project commands (e.g., `npm run typecheck`, `make lint`)
2. **Check project files:**
   - `package.json` → TypeScript: `tsc --noEmit`, Lint: `eslint .`, Test: `npm test`
   - `pyproject.toml` or `setup.py` → Type: `mypy .`, Lint: `ruff check .`, Test: `pytest`
   - `go.mod` → Type: `go vet ./...`, Lint: `golangci-lint run`, Test: `go test ./...`
   - `Cargo.toml` → Type: `cargo check`, Lint: `cargo clippy`, Test: `cargo test`

3. **Coverage tool detection:**
   - `package.json` with vitest → `vitest --coverage`
   - `package.json` with c8/nyc → `npx c8 npm test` or `npx nyc npm test`
   - `pyproject.toml`/`setup.py` → `pytest --cov`
   - `go.mod` → `go test -cover ./...`
   - `Cargo.toml` → `cargo tarpaulin`

4. **Three-tier results** (NOT a binary found/not-found):
   - `DETECTED` — tool found, command determined
   - `NOT_APPLICABLE` — justified skip (e.g., all changed files are `.md`). Must include justification.
   - `MISSING` — tool not found for a project with source files → **this is a BLOCKED verdict**

5. **Scope to changed packages (monorepos).** If `baseline.json`'s `commands.monorepo` is set
   (turborepo/nx), use `commands.test_changed` (substitute `{BASE}` with `<BASE_BRANCH>`) to run
   typecheck/lint/test against only the **changed packages and their dependents**, not the whole repo —
   e.g. `turbo run test:unit lint typecheck --filter='...[<BASE_BRANCH>]'`. Turbo's `...[base]` filter
   includes downstream dependents, so regressions in affected packages are still caught, and unchanged
   packages become cache hits (near-zero time). Single-package repos (`monorepo: null`) run the whole
   project via the plain `commands` as before.

---

## Gate Checks

### Check 1: Type Checker

- Run the detected type check command
- **Pass:** Exit code 0
- **Fail:** Non-zero exit code
- Report: exit code, error count, specific errors

### Check 2: Linter

- Run the detected lint command
- **Pass:** Exit code 0 OR no new warnings compared to baseline
- **Fail:** New warnings introduced (count > baseline)
- Report: exit code, warning count, delta from baseline

### Check 3: Test Suite + Behavior Coverage (ONE run, feeds both Check 3 and Check 4)

- Run the test suite **with coverage enabled** in a SINGLE invocation — prefer `baseline.json`'s
  `commands.coverage_all` (e.g. `vitest run --coverage`, `pytest --cov`, `go test -cover ./...`).
  Coverage runs the tests, so a plain test run followed by a separate coverage run executes the whole
  suite twice — do NOT do that. This one invocation feeds both Check 3 (pass/fail) and Check 4 (coverage).
- **Behavior coverage procedure:** extract every REQ/EDGE ID from the verification matrix in
  `.harness/features/<SPEC_NAME>/spec.md`, then grep the test files/output for each ID via the
  `test_<ID>_` naming convention. Every matrix ID must map to at least one passing test. When the
  REFACTOR consolidation note says an ID's test was merged or moved to another level, verify the
  named surviving test passes.
- **Pass:** Exit code 0 AND every matrix REQ/EDGE ID has a passing test
- **Fail:** Non-zero exit code OR any matrix ID has no passing test
- Test count is NOT compared — consolidation may legitimately reduce it. The budget is the matrix.
- Report: exit code, pass/fail/skip counts, matrix IDs covered/missing

### Check 4: Coverage (diagnostic only — parsed from the Check 3 run, do NOT re-run the suite)

- Parse the coverage percentage from the Check 3 run's output. Do not invoke the suite again.
- **Report only — this check never fails.** Line coverage is a diagnostic, not a gate.
- On a drop vs baseline, emit an INFO line: "Coverage dropped X% → what behavior is missing from the matrix?"
- No coverage tool detected → INFO note, not BLOCKED
- Report: coverage percentage, delta from baseline, verdict INFO

### Check 5: Scope Compliance

- Run `git diff --name-only` against the worktree
- Compare changed files against the plan's file list
- **Pass:** All changed files are listed in the plan
- **Fail:** Files changed that are not in the plan
- Report: list of out-of-scope files (if any)

### Check 6: Plan Compliance

- Read each `phase-N.md` in `.harness/runtime/<SPEC_NAME>/`
- Extract all "Done When" checklist items
- For each item, cite specific evidence:
  - Test name that passes
  - File that exists
  - Command output that proves completion
- **Pass:** All items have verifiable evidence
- **Fail:** Any item lacks evidence
- Items that require human judgment → flagged as `UNVERIFIABLE` (INFO, not BLOCKED)
- Report: each item with its evidence or UNVERIFIABLE status

### Check 7: Ignore Comment Audit

- Run: `git diff --unified=0 2>&1 | grep -E '^\+[^+]'` and search for these patterns:
  - `@ts-ignore`, `@ts-expect-error`
  - `# noqa`
  - `//nolint`
  - `#[allow(`
  - `eslint-disable`
- Report exact file, line, and pattern for each match
- **Pass:** No new ignore comments, OR all new ignore comments have inline justification
- **Fail:** Any new ignore comment without inline justification → BLOCKED
- Report: list of new ignore comments with context

### Check 8: Smoke Test

- Read phase files and plan for a "Smoke Test" or "E2E Verification" section
- If found → run those commands and report results
- If not found → INFO note "No smoke test defined."
- **Blocking when defined** — if a phase defines a smoke test command and it fails, verdict is BLOCKED
- **Non-blocking when absent** — if no smoke test is defined, INFO note only
- Report: commands run, output, pass/fail per command

### Check 9: E2E Report Verification

- Read `.harness/runtime/<SPEC_NAME>/e2e-report.json`
- If file does not exist and the task has user-facing changes → **BLOCKED**: "E2E tests were not run during coding — no e2e-report.json found". Note: a hermetic runner (`e2e.self_provisioning` in baseline) should **emit this file itself** from the framework's machine output (e.g. Playwright's JSON reporter) — a `failed`/`coverage`/`timestamp` derived from the actual run, not hand-authored. A report whose numbers can't be traced to a runner invocation is not evidence.
- If `not_applicable: true` → `NOT_APPLICABLE` with the reason from the file
- If file exists, verify:
  1. `failed` count is 0 — any E2E failures during coding are a hard block
  2. `coverage` array is non-empty — report must cover at least one spec requirement
  3. Each coverage entry maps to a REQ or EDGE ID from the spec — verify the IDs exist in `.harness/features/<SPEC_NAME>/spec.md`
  4. `gaps` field exists and is non-empty — a report with no documented gaps is suspicious; flag as WARNING (not BLOCKED)
  5. Timestamp is within the pipeline run window (not stale from a previous run)
- **Pass:** `failed` = 0, coverage non-empty, all REQ IDs valid, timestamp current
- **Fail:** `failed` > 0, or coverage empty, or REQ IDs don't match spec, or file missing for user-facing task
- Report: failed count, coverage count, gap count, REQ ID validation results

### Check 10: Mutation Spot-Check (`post-tdd` and `pre-pr` only)

Detects tautological / written-to-pass tests — the only check that proves tests can fail for the right reason.

1. From the spec's verification matrix, pick 3-5 behaviors implemented or changed in this run.
   Prefer the riskiest: branching logic, validation, calculations.
2. Confirm the working tree is clean for the target files (`git diff --quiet -- <file>` or note the
   exact pre-mutation content). Apply ONE mutation at a time to the production code:
   - Invert a boolean condition (`if (x)` → `if (!x)`)
   - Replace a return value with a constant
   - Introduce an off-by-one (`<=` → `<`, `+ 1` removed)
3. Run the scoped test(s) for that behavior (`commands.test_file` with the relevant test file).
4. **Killed** (at least one test fails) → revert and continue. **Survived** (all tests still pass) →
   the behavior's test verifies nothing → **BLOCKED**, naming the file, behavior ID, and surviving mutation.
5. Revert after EVERY mutation: `git checkout -- <file>`, then verify `git diff --quiet` before the
   next mutation and again before finishing the check. Never leave a mutant in the tree.
- **Pass:** every sampled mutation was killed
- **Fail:** any mutation survived
- Report table: Behavior ID | File | Mutation applied | Killing test | KILLED/SURVIVED

---

## When Gates Run

| Stage | Checks Run | Trigger |
|-------|-----------|---------|
| After TDD (`post-tdd`) | Checks 1-8 mandatory + Check 9 always + Check 10 (mutation) | Implementation complete |
| After Refactor (`post-refactor`) | Checks 1-4 (no scope/plan/ignore/smoke/e2e/mutation check) | Refactoring should not change scope |
| Before PR (`pre-pr`) | Checks 1-8 mandatory + Check 9 always + Check 10 (mutation) | Final audit before commit |

If any gate returns **BLOCKED**, the pipeline stops at that point. The orchestrator reports what failed and does not proceed to the next stage.

---

## Gate Report Format

Written to `.harness/runtime/<SPEC_NAME>/gate-report-<stage>-<NNN>.md` (e.g., `gate-report-post-tdd-001.md`). Increment the sequence number based on existing reports in the directory:

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
| 10 | Mutation Spot-Check | — | 0/3 mutants survived, 0 false-positive muts | PASS |
| 11 | Mutation Spot-Check | — | 4/4 mutants killed | PASS |

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
<!-- QG:CHECK:11:FAIL -->
**Mutations:**
| Behavior ID | File | Mutation | Killing test | Result |
|-------------|------|----------|--------------|--------|
| REQ-003 | validator.py | inverted `if amount > 0` | test_REQ_003_rejects_negative | KILLED |
| REQ-005 | pricing.py | return constant `0` | — | SURVIVED |

**BLOCKED:** REQ-005's test passed against a mutant returning 0 — the test does not verify the pricing behavior.
```

Machine-parseable markers: `<!-- QG:VERDICT:PASS -->` and `<!-- QG:CHECK:N:PASS -->` for orchestrator extraction.

---

## Verdict Logic

Binary verdicts — no WARN tier:

- **`PASS`** — all mandatory checks pass (Checks 1-3 and 5-8, Check 9 when e2e is detected, Check 10 at post-tdd/pre-pr; Check 4 is diagnostic and never blocks)
- **`BLOCKED`** — any mandatory check fails (with specific reasons listed)
- **`STAGNATION`** — same check failed 3 consecutive times across gate runs (special signal: stop entirely, don't retry)

---

## Stagnation Detection

Read previous gate reports from `.harness/runtime/<SPEC_NAME>/gate-report-*.md`.

Compare error signatures: check name + first error line. If the **same check fails 3 consecutive times with the same error signature**, report STAGNATION.

On stagnation: stop the pipeline and report — do not retry further.

Format: "STAGNATION DETECTED: [check] has failed 3 consecutive times with: [error summary]"

This prevents infinite loops where a sub-agent keeps making the same mistake.

---

## Anti-Patterns

- **Weakening thresholds** — "Let's allow 2 type errors since they're minor" — No. Zero is zero.
- **Skipping gates** — "Tests pass so we don't need the linter check" — All checks run, always.
- **Tautological / written-to-pass tests** — Caught by Check 10: a surviving mutant means the test verifies nothing.
- **Padding the suite with filler tests for line coverage** — Coverage is diagnostic; the test budget is the spec's verification matrix.
- **Deleting a behavior's only test** — Caught by Check 3 (every matrix REQ/EDGE ID must map to a passing test).
- **Adding ignore comments without justification** — Caught by Check 7. Every ignore comment needs an inline reason.
- **Running gates without capturing verbatim output** — Every claim must have evidence. No exceptions.
- **Marking NOT_APPLICABLE without justification** — Must explain why a tool doesn't apply (e.g., "all changed files are .md").
- **Reporting coverage without running coverage tool** — Coverage percentage must come from tool output, not estimation.
- **Running gates without baseline** — Always capture baseline first. Without it, you can't detect regressions.
