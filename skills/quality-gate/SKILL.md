---
name: quality-gate
description: "Post-stage verification with hard pass/fail thresholds. Every claim backed by verbatim command output — no check may be silently absent, skipped, or weakened. Runs after TDD, refactor, and before PR. Captures baseline metrics to docs/spec/<SPEC_NAME>/baseline.json."
---

# Quality Gate: Tool-Based Verification

Every claim in this report is backed by verbatim command output. No check may be silently absent, skipped, weakened, or overridden by a sub-agent.

**Announce at start:** "Running quality gate checks against baseline metrics."

---

## Inputs

The quality gate receives these parameters from the orchestrator:

- **Baseline file:** `docs/spec/<SPEC_NAME>/baseline.json`
- **Plan dir:** `docs/spec/<SPEC_NAME>/`
- **Stage:** `post-tdd` | `post-refactor` | `pre-pr`

---

## Evidence Capture Protocol

Every command executed during the gate MUST follow this pattern:

```
<command> 2>&1; echo "EXIT_CODE=$?"
```

For each command, the report MUST include:
1. **Exact command run** — copy-pasteable
2. **Raw output** — first 50 lines + last 10 lines if output exceeds 60 lines, with `... <N lines truncated> ...` in between
3. **Exit code** — extracted from the `EXIT_CODE=` line

This makes fabrication detectable — real tool output has consistent formatting that's hard to fake.

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

**Capture these metrics and write to `docs/spec/<SPEC_NAME>/baseline.json`:**

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

### Check 3: Test Suite

- Run the detected test command
- **Pass:** Exit code 0 AND test count >= baseline test count (no deleted tests)
- **Fail:** Non-zero exit code OR test count < baseline (tests were deleted)
- Report: exit code, pass/fail/skip counts, delta from baseline

### Check 4: Coverage

- Run the detected coverage command
- Parse coverage percentage from output
- **Pass:** Coverage meets threshold (default 100% for new code, configurable via CLAUDE.md)
- **Fail:** Coverage below threshold
- **MISSING:** No coverage tool detected but tests exist → BLOCKED
- Report: coverage percentage, threshold, delta from baseline

### Check 5: Scope Compliance

- Run `git diff --name-only` against the worktree
- Compare changed files against the plan's file list
- **Pass:** All changed files are listed in the plan
- **Fail:** Files changed that are not in the plan
- Report: list of out-of-scope files (if any)

### Check 6: Plan Compliance

- Read each `phase-N.md` in the plan directory
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

### Check 8: Smoke Test (Optional, Non-blocking)

- Read phase files and plan for a "Smoke Test" section
- If found → run those commands and report results
- If not found → INFO note "No smoke test defined."
- **Non-blocking** — results are informational regardless of outcome
- Report: commands run, output, pass/fail per command

---

## When Gates Run

| Stage | Checks Run | Trigger |
|-------|-----------|---------|
| After TDD (`post-tdd`) | All 7 mandatory + optional smoke | Implementation complete |
| After Refactor (`post-refactor`) | Checks 1-4 (no scope/plan/ignore check) | Refactoring should not change scope |
| Before PR (`pre-pr`) | All 7 mandatory + optional smoke | Final audit before commit |

If any gate returns **BLOCKED**, the pipeline stops at that point. The orchestrator reports what failed and does not proceed to the next stage.

---

## Gate Report Format

Written to `docs/spec/<SPEC_NAME>/gate-report-<stage>-<NNN>.md` (e.g., `gate-report-post-tdd-001.md`). Increment the sequence number based on existing reports in the directory:

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
| 3 | Test Suite | exit=0, 42 passed | exit=0, 47 passed (+5) | PASS |
| 4 | Coverage | 85.5% | 92.3% (+6.8%) | PASS |
| 5 | Scope Compliance | — | 3 files changed, all in plan | PASS |
| 6 | Plan Compliance | — | 5/5 items verified | PASS |
| 7 | Ignore Comment Audit | — | 0 new ignore comments | PASS |
| 8 | Smoke Test | — | 2/2 passed | INFO |

<!-- QG:VERDICT:PASS -->
**Verdict: PASS**

### Evidence

#### Check 1: Type Checker
<!-- QG:CHECK:1:PASS -->
**Command:** `tsc --noEmit 2>&1; echo "EXIT_CODE=$?"`
**Output:**
\```
<verbatim output, truncated per protocol>
EXIT_CODE=0
\```

#### Check 2: Linter
<!-- QG:CHECK:2:PASS -->
**Command:** `eslint . 2>&1; echo "EXIT_CODE=$?"`
**Output:**
\```
<verbatim output>
EXIT_CODE=0
\```

...
```

Machine-parseable markers: `<!-- QG:VERDICT:PASS -->` and `<!-- QG:CHECK:N:PASS -->` for orchestrator extraction.

---

## Verdict Logic

Binary verdicts — no WARN tier:

- **`PASS`** — all 7 mandatory checks pass
- **`BLOCKED`** — any mandatory check fails (with specific reasons listed)
- **`STAGNATION`** — same check failed 3 consecutive times across gate runs (special signal: stop entirely, don't retry)

---

## Stagnation Detection

Read previous gate reports from the spec directory (`gate-report-*.md`).

Compare error signatures: check name + first error line. If the **same check fails 3 consecutive times with the same error signature**, report STAGNATION.

On stagnation: stop the pipeline and report — do not retry further.

Format: "STAGNATION DETECTED: [check] has failed 3 consecutive times with: [error summary]"

This prevents infinite loops where a sub-agent keeps making the same mistake.

---

## Anti-Patterns

- **Weakening thresholds** — "Let's allow 2 type errors since they're minor" — No. Zero is zero.
- **Skipping gates** — "Tests pass so we don't need the linter check" — All checks run, always.
- **Deleting tests to match baseline** — Caught by Check 3 (test count must be >= baseline).
- **Adding ignore comments without justification** — Caught by Check 7. Every ignore comment needs an inline reason.
- **Running gates without capturing verbatim output** — Every claim must have evidence. No exceptions.
- **Marking NOT_APPLICABLE without justification** — Must explain why a tool doesn't apply (e.g., "all changed files are .md").
- **Reporting coverage without running coverage tool** — Coverage percentage must come from tool output, not estimation.
- **Running gates without baseline** — Always capture baseline first. Without it, you can't detect regressions.
