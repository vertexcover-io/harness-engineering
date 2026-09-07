---
name: coverage-guard
description: >
  Coverage diagnostic for a package. Use this skill after writing or modifying code
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

**First action: read `orchestrate.config.json` at the repo root.** Every command and package path this skill uses comes from it, resolved per `skills/orchestrate/references/config.md`.

Reports uncovered code mapped to spec behaviors. Line coverage is a diagnostic, never a
gate — the test budget is the spec's verification matrix, and test quality is enforced by
the quality-gate's behavior-coverage and mutation checks.

**The one rule that governs every recommendation:** coverage gaps are behavior gaps, not line
gaps — the question is never "what line am I missing?", always "what business behavior is
untested?" (The full standard, if needed: `skills/tdd/references/testing.md`.)

---

## Configuration

The package under diagnosis comes from `$ARGUMENTS` or the code just changed; its `coverage_all`
command from `orchestrate.config.json`, resolved per `skills/orchestrate/references/config.md`.

Scope is the unit suite only, and the report is whatever machine-readable file that command writes.

---

## Execution Flow

### Step 1: Run Coverage

Run the package's `coverage_all` in its `path`.

If the runner fails for reasons other than coverage (non-zero exit, no report written), report the
error and **stop**.

### Step 2: Parse Results

Read the coverage report the run wrote. Extract:
- `totals.percent_covered` — the overall coverage percentage
- Per-file breakdown: `files.<path>.summary.percent_covered`, `missing_lines`, `missing_branches`

### Step 3: Map Uncovered Code to Behaviors

For each file with uncovered regions:

1. Read the source to understand what the uncovered code does
2. If a plan exists for the current work, map each uncovered region to the Test Matrix
   behavior(s) it belongs to (by `R#`/`EC#` requirement or `SC<n>` scenario id)
3. Classify regions with no matching behavior as one of:
   - **Candidate for the don't-test list** — getters/mappers/pass-throughs/framework behavior
     (intentionally untested; no action)
   - **Possible missing REQ** — real logic no spec behavior covers (surface to the user)

### Step 4: Report and Ask

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

- **The runner fails to start:** Report the error (missing dependencies, syntax errors, etc.) and stop.
- **The package declares no `coverage_all`:** Report that and stop. Never substitute a command.
- **Coverage report missing or unparseable:** Report the error and stop.
- **No unit tests exist yet:** Report 0% coverage and list the source files for the user to triage.

---

## What This Skill Does NOT Do

- Does not generate specs or test-gap documents
- Does not invoke orchestrate or write tests
- Does not enforce a threshold or fail a build — it reports and asks
- Does not run e2e tests — unit coverage only
- Does not auto-trigger — Claude invokes based on CLAUDE.md directive
