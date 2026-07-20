---
name: quality-gate
description: "Post-stage verification with hard pass/fail thresholds. Every claim backed by verbatim command output — no check may be silently absent, skipped, or weakened. Runs after TDD, refactor, and before PR. Reads baseline metrics from .harness/runtime/<SPEC_NAME>/baseline.json."
user-invocable: false
---

# Quality Gate: Tool-Based Verification

This is the gate between "the coder says it's done" and "the feature ships." Every verdict is backed by **evidence** — verbatim command output, never an adjective. No check may be silently absent, skipped, weakened, or overridden by a sub-agent.

**Announce at start:** "Running quality gate checks against baseline metrics."

---

## Inputs

The quality gate receives these parameters from the orchestrator:

- **Baseline file:** `.harness/runtime/<SPEC_NAME>/baseline.json`
- **Spec dir:** `.harness/features/<SPEC_NAME>/` (committed — spec.md, plan.md)
- **Harness dir:** `.harness/runtime/<SPEC_NAME>/` (gitignored — phase-*.md, e2e-report.json, claims.json, gate reports)
- **Stage:** `post-tdd` (the gate runs once, after the TDD stage, before commit)

---

## Evidence

Every check command runs with `<command> 2>&1; echo "EXIT_CODE=$?"`, and every claim in the report
cites the command, its exit code, and parsed summary metrics — never raw dumps. Full formatting rules,
the report template, and the state-snapshot commands live in `references/gate-report-format.md`.

---

## Tooling detection & baseline

Detect the project's toolchain (type / lint / test / coverage) and capture starting metrics to
`baseline.json` per `references/tooling-detection.md`. Each tool resolves to one of three states:

- `DETECTED` — tool found, command determined.
- `NOT_APPLICABLE` — justified skip (e.g. all changed files are `.md`). Must state the justification.
- `MISSING` — tool absent for a project with source files → **BLOCKED verdict**.

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

- Run the **unit** suite **with coverage enabled** in a SINGLE invocation — use `baseline.json`'s
  `commands.coverage_all` (e.g. `vitest run --coverage`, `pytest --cov`, `go test -cover ./...`).
  This is the unit suite only — it must **not** invoke the e2e suite (`e2e.e2e_cmd`), which the coder
  already ran; Check 9 reads that run's report, it is not re-run here.
  Coverage runs the tests, so a plain test run followed by a separate coverage run executes the whole
  suite twice — do NOT do that. This one invocation feeds both Check 3 (pass/fail) and Check 4 (coverage).
- **Behavior coverage procedure:** the spec's `## Verification Matrix` in
  `.harness/features/<SPEC_NAME>/spec.md` has a **`Test Name` column** giving the exact test for each
  REQ/EDGE row. For every row, grep the test files/output for that named test and confirm it passes —
  grep the name the matrix records, do not reconstruct one from the id (test names follow the coder's
  own convention, not a fixed `test_<ID>_` shape). Every matrix REQ/EDGE row must map to a passing
  named test. When the REFACTOR consolidation note says a row's test was merged or moved to another
  level, verify the named surviving test passes.
- **Pass:** Exit code 0 AND every matrix row's named test passes
- **Fail:** Non-zero exit code OR any matrix row's named test is missing or failing
- Test count is NOT compared — consolidation may legitimately reduce it. The budget is the matrix.
- Report: exit code, pass/fail/skip counts, matrix rows covered/missing

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

- Read each `phase-N.md` in `.harness/runtime/<SPEC_NAME>/`. A phase's `## Test Scenarios` section
  (its `S<n>` scenarios) is its definition of done — there is no separate "Done When" section.
- For each scenario, cite specific evidence it is satisfied:
  - The passing test that proves it (`proven_by` / test name)
  - A file that exists
  - Command output that proves completion
- **Pass:** Every scenario has verifiable evidence
- **Fail:** Any scenario lacks evidence
- Scenarios that require human judgment → flagged as `UNVERIFIABLE` (INFO, not BLOCKED)
- Report: each scenario with its evidence or UNVERIFIABLE status

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

- Read phase files and plan for a "Smoke Test" section (e2e is Check 9's job, not this one)
- If found → run those commands and report results
- If not found → INFO note "No smoke test defined."
- **Blocking when defined** — if a phase defines a smoke test command and it fails, verdict is BLOCKED
- **Non-blocking when absent** — if no smoke test is defined, INFO note only
- Report: commands run, output, pass/fail per command

### Check 9: E2E Report Verification

This check **only reads** the coder's e2e artifacts — it does not launch a browser or re-run the e2e suite. The suite ran once, during coding. It reads two files: `e2e-report.json` (the raw run summary) and `claims.json` (the aggregated claim ledger).

- Read `.harness/runtime/<SPEC_NAME>/e2e-report.json`
- If file does not exist and the task has user-facing changes → **BLOCKED**: "E2E tests were not run during coding — no e2e-report.json found". Note: a hermetic runner (`e2e.self_provisioning` in baseline) should **emit this file itself** from the framework's machine output (e.g. Playwright's JSON reporter) — a `failed`/`coverage`/`timestamp` derived from the actual run, not hand-authored. A report whose numbers can't be traced to a runner invocation is not evidence.
- If `not_applicable: true` → `NOT_APPLICABLE` with the reason from the file
- If file exists, verify:
  1. `failed` count is 0 — any E2E failures during coding are a hard block
  2. `coverage` array is non-empty — the report must cover at least one scenario
  3. Each `coverage[].scenario` is a scenario `S<n>` id (not a REQ/EDGE id) — confirm the S-id appears in a phase file's `## Test Scenarios`, and where that scenario's `(traces to …)` tag names a REQ/EDGE, confirm the requirement exists in the spec's matrix
  4. `gaps` field exists and is non-empty — a report with no documented gaps is suspicious; flag as WARNING (not BLOCKED)
  5. Timestamp is within the pipeline run window (not stale from a previous run)
- **Then corroborate against `claims.json`** (aggregated from the coder's `phase-*-claims.json`), when present: aggregated `failed == 0` and `executed > 0`, and every `type: "ui"` claim's `proven_by` names a real test. A `claims.json` that disagrees with `e2e-report.json` (e.g. `failed > 0` in one) is a hard block — the two views of the same run must agree.
- **Pass:** `failed` = 0 in both files, coverage non-empty, every coverage S-id resolves, timestamp current
- **Fail:** `failed` > 0 in either file, or coverage empty, or a coverage S-id doesn't resolve, or e2e-report.json missing for a user-facing task
- Report: failed count (both files), coverage count, gap count, S-id resolution results

### Check 10: Mutation Spot-Check

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

## When It Runs

The gate runs once, at `post-tdd` — after implementation is complete and before commit. All ten checks
run: Checks 1–8 and 10 are mandatory, Check 9 always runs, and Check 4 is diagnostic (never blocks).

If the gate returns **BLOCKED**, the pipeline stops there — the orchestrator reports what failed and does
not proceed.

---

## Gate report

Write the report to `.harness/runtime/<SPEC_NAME>/gate-report-<stage>-<NNN>.md` following
`references/gate-report-format.md` (Toolchain + Results tables, then per-check evidence). It carries
the markers `<!-- QG:VERDICT:… -->` and `<!-- QG:CHECK:N:… -->` (N = 1–10) that the orchestrator
greps — always emit them.

---

## Verdict Logic

Binary verdicts — no WARN tier:

- **`PASS`** — all mandatory checks pass (Checks 1-3, 5-8, and 10, plus Check 9 when e2e is detected; Check 4 is diagnostic and never blocks)
- **`BLOCKED`** — any mandatory check fails (with specific reasons listed)
- **`STAGNATION`** — same check failed 3 consecutive times across gate runs (special signal: stop entirely, don't retry)

---

## Stagnation Detection

Read previous gate reports from `.harness/runtime/<SPEC_NAME>/gate-report-*.md`.

Compare error signatures: check name + first error line. If the **same check fails 3 consecutive times with the same error signature**, report STAGNATION.

On stagnation: stop the pipeline and report — do not retry further.

Format: "STAGNATION DETECTED: [check] has failed 3 consecutive times with: [error summary]"

---

## Anti-Patterns

The checks enforce most discipline on their own. These three are judgment calls no single check catches:

- **Weakening a threshold** — every check runs at full strength, every run. Zero errors means zero, not "zero minus the minor ones."
- **Marking NOT_APPLICABLE without justification** — state why the tool doesn't apply (e.g. "all changed files are `.md`"). An unjustified skip is a MISSING tool, which blocks.
- **Running without a baseline** — capture `baseline.json` first; without it, regressions are invisible, and a reported coverage number must come from the tool run, never an estimate.
