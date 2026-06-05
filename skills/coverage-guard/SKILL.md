---
name: coverage-guard
description: >
  Coverage diagnostic for tarash-gateway. Use this skill after writing or modifying code
  to see which code is uncovered and which spec behaviors that maps to. Diagnostic only —
  reports and asks the user; never generates specs, never invokes orchestrate, never
  fails a build.
---

## Project-Specific Guidelines

1. If `$ARGUMENTS` is a path to an existing file, read it and prioritize
   its guidelines over the defaults below.
2. Otherwise, check if `.claude/harness/coverage-guard-reference.md` exists in the
   project root. If it does, read it and apply its guidelines.
3. If neither exists, use the defaults below.

User-provided guidelines take precedence on conflicts with defaults.

# Coverage Guard (Diagnostic)

Reports uncovered code mapped to spec behaviors. Line coverage is a diagnostic, never a
gate — the test budget is the spec's verification matrix, and test quality is enforced by
the quality-gate's behavior-coverage and mutation checks.

**REQUIRED SUB-SKILL:** Load the `testing` skill before analyzing coverage gaps. This
ensures any recommendation follows project testing conventions.

---

## Configuration

| Setting | Value |
|---------|-------|
| **Package** | `tarash-gateway` |
| **Test command** | `uv run pytest packages/tarash-gateway/tests/unit --cov=tarash.tarash_gateway --cov-report=json --cov-report=term-missing -q` |
| **Coverage JSON** | `coverage.json` (repo root) |
| **Scope** | Unit tests only |

---

## Execution Flow

### Step 1: Load Testing Skill

Before any analysis, invoke the `testing` skill to load test patterns and conventions.

### Step 2: Run Coverage

Run the test command:

```bash
uv run pytest packages/tarash-gateway/tests/unit --cov=tarash.tarash_gateway --cov-report=json --cov-report=term-missing -q
```

If pytest fails (non-zero exit for reasons other than coverage), report the error and **stop**.

### Step 3: Parse Results

Read `coverage.json` (written to the repo root by pytest-cov). Extract:
- `totals.percent_covered` — the overall coverage percentage
- Per-file breakdown: `files.<path>.summary.percent_covered`, `missing_lines`, `missing_branches`

### Step 4: Map Uncovered Code to Behaviors

For each file with uncovered regions:

1. Read the source to understand what the uncovered code does
2. If a spec exists for the current work, map each uncovered region to the verification-matrix
   behavior(s) it belongs to (by REQ/EDGE ID)
3. Classify regions with no matching behavior as one of:
   - **Candidate for the don't-test list** — getters/mappers/pass-throughs/framework behavior
     (intentionally untested; no action)
   - **Possible missing REQ** — real logic no spec behavior covers (surface to the user)

### Step 5: Report and Ask

Print the diagnostic report:

```markdown
## Coverage Diagnostic

| Metric | Value |
|--------|-------|
| Overall coverage | XX.XX% |

### Uncovered Code by Behavior

| File | Coverage | Uncovered Region | Maps To |
|------|----------|------------------|---------|
| path/to/file.py | XX% | `handle_retry` lines X-Y | possible missing REQ — retry behavior unspecified |
| path/to/dto.py | XX% | field mappers | don't-test list (intentional) |
```

Then ask the user: **"Do any of the 'possible missing REQ' regions represent behavior that
should become a verification-matrix row?"** Let the user decide — do not write tests, specs,
or matrix rows yourself.

---

## Error Handling

- **pytest fails to run:** Report the error (missing dependencies, syntax errors, etc.) and stop.
- **coverage.json missing or unparseable:** Report the error and stop.
- **No unit tests exist yet:** Report 0% coverage and list the source files for the user to triage.

---

## What This Skill Does NOT Do

- Does not generate specs or test-gap documents
- Does not invoke orchestrate or write tests
- Does not enforce a threshold or fail a build — it reports and asks
- Does not run e2e tests — unit coverage only
- Does not auto-trigger — Claude invokes based on CLAUDE.md directive
