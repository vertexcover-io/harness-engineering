---
name: coverage-guard
description: >
  Enforce minimum test coverage threshold for tarash-gateway. Use this skill after writing
  or modifying code to check that unit test coverage meets the required minimum. If coverage
  is below threshold, generates a test gap spec and invokes the orchestrate skill to
  implement missing tests automatically.
---

## Project-Specific Guidelines

1. If `$ARGUMENTS` is a path to an existing file, read it and prioritize
   its guidelines over the defaults below.
2. Otherwise, check if `.claude/harness/coverage-guard-reference.md` exists in the
   project root. If it does, read it and apply its guidelines.
3. If neither exists, use the defaults below.

User-provided guidelines take precedence on conflicts with defaults.

# Coverage Guard

Enforces a minimum test coverage threshold. When coverage falls below the threshold, generates a spec for missing tests and hands off to the orchestrate pipeline.

**REQUIRED SUB-SKILL:** Load the `testing` skill before analyzing coverage gaps or generating specs. This ensures all test recommendations follow project testing conventions.

---

## Configuration

> **THRESHOLD = 90%** — Edit this single value to change the minimum coverage requirement. All references below use this value.

| Setting | Value |
|---------|-------|
| **Threshold** | `THRESHOLD` (see above) |
| **Package** | `tarash-gateway` |
| **Test command** | `uv run pytest packages/tarash-gateway/tests/unit --cov=tarash.tarash_gateway --cov-report=json --cov-report=term-missing -q` |
| **Coverage JSON** | `coverage.json` (repo root) |
| **Scope** | Unit tests only |

---

## Execution Flow

### Step 1: Load Testing Skill

Before any analysis, invoke the `testing` skill to load test patterns and conventions. This informs all spec generation decisions.

### Step 2: Run Coverage

Run the test command:

```bash
uv run pytest packages/tarash-gateway/tests/unit --cov=tarash.tarash_gateway --cov-report=json --cov-report=term-missing -q
```

If pytest fails (non-zero exit for reasons other than coverage), report the error and **stop**. Do not generate a spec for broken tests.

### Step 3: Parse Results

Read `coverage.json` (written to the repo root by pytest-cov). Extract:
- `totals.percent_covered` — the overall coverage percentage
- Per-file breakdown: `files.<path>.summary.percent_covered`, `missing_lines`, `missing_branches`

### Step 4: Decide

**IF coverage >= `THRESHOLD`:**

Print a summary and stop:

```
## Coverage Report: PASS

| Metric | Value |
|--------|-------|
| Current coverage | XX.XX% |
| Threshold | THRESHOLD |
| Status | PASS |

### Least Covered Files

| File | Coverage | Missing Lines |
|------|----------|---------------|
| path/to/file1.py | XX% | N lines |
| path/to/file2.py | XX% | N lines |
| path/to/file3.py | XX% | N lines |
```

No further action needed.

**IF coverage < `THRESHOLD`:**

Proceed to Step 5.

### Step 5: Analyze Coverage Gaps

From the coverage JSON, identify all files below `THRESHOLD` coverage. For each file:

1. Read the source file to understand what the uncovered code does
2. Identify uncovered functions/methods and their line ranges
3. Identify uncovered branches (if/else, try/except)
4. Determine what behavioral tests would cover the gaps (not mechanical line-by-line tests)
5. Map each uncovered file to its corresponding test file path in `tests/unit/`

### Step 6: Generate Coverage Gap Spec

Write a spec to `dev-docs/specs/YYYY-MM-DD-coverage-gap-spec.md` with this structure:

```markdown
# Coverage Gap Spec

## Coverage Summary

| Metric | Value |
|--------|-------|
| Current coverage | XX.XX% |
| Threshold | THRESHOLD |
| Gap | X.XX percentage points |

## Uncovered Files

Ranked by missing lines (descending):

| File | Coverage | Missing Lines | Missing Branches |
|------|----------|---------------|------------------|
| ... | ... | ... | ... |

## Per-File Analysis

### `path/to/file.py` (XX% covered)

**Uncovered functions:**
- `function_name` (lines X-Y): [description of what it does]

**Uncovered branches:**
- `function_name` line X: [which branch is missed, e.g., "error handling path"]

**Tests to write:**
- Test file: `tests/unit/path/to/test_file.py`
- Behaviors to test:
  - [behavior description 1]
  - [behavior description 2]
- Fixtures needed: [list any fixtures]
- Edge cases: [list edge cases]

(Repeat for each uncovered file)

## Testing Conventions

- Function-based tests (no classes) — per CLAUDE.md
- Behavior-driven naming: `test_<behavior_description>`
- Use fixtures for shared setup
- asyncio_mode="auto" for async tests
- Use `uv run pytest` exclusively
- Follow patterns from the `testing` skill

## Acceptance Criteria

- [ ] Overall coverage meets or exceeds THRESHOLD
- [ ] All new tests pass
- [ ] No existing tests broken
- [ ] Tests follow project conventions (function-based, behavior-driven)
```

### Step 7: Invoke Orchestrate

Pass the spec to the orchestrate skill:

```
/orchestrate dev-docs/specs/YYYY-MM-DD-coverage-gap-spec.md
```

The orchestrate pipeline handles: planning, TDD implementation, quality gate, and commit.

---

## Error Handling

- **pytest fails to run:** Report the error (missing dependencies, syntax errors, etc.) and stop. Do not generate a spec.
- **coverage.json missing or unparseable:** Report the error and stop.
- **No unit tests exist yet:** Report 0% coverage and generate a spec for initial test coverage.

---

## What This Skill Does NOT Do

- Does not write tests itself — delegates to orchestrate
- Does not modify the threshold — edit `THRESHOLD` in the Configuration section above to change it
- Does not run e2e tests — unit coverage only
- Does not auto-trigger — Claude invokes based on CLAUDE.md directive
