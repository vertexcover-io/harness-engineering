---
name: quality-gate
description: "Post-stage verification with hard pass/fail thresholds. Every claim backed by verbatim command output — no check may be silently absent, skipped, or weakened. Runs after TDD, refactor, and before PR. Reads each package's commands from orchestrate.config.json and its baseline metrics from .harness/<SPEC_NAME>/baseline.json."
user-invocable: false
---

# Quality Gate: Tool-Based Verification

**Writing for a person** (reports, plan copy, README indexes, PR descriptions — not
agent-only files like `design.md`): first read
`${CLAUDE_PLUGIN_ROOT}/skills/_shared/writing-style.md`; before shipping, run its ship-check.
Sub-agents that write documents get that path in their dispatch prompt.

This is the gate between "the coder says it's done" and "the feature ships." Every verdict is backed by **evidence** — verbatim command output, never an adjective. No check may be silently absent, skipped, weakened, or overridden by a sub-agent.

**Announce at start:** "Running quality gate checks against baseline metrics."

**First action: read `orchestrate.config.json` at the repo root.** Every command and package path this skill uses comes from it, resolved per `skills/orchestrate/references/config.md`.

---

## Inputs

The quality gate receives these parameters from the orchestrator:

- **Feature dir:** `.harness/<SPEC_NAME>/` (gitignored — baseline.json, e2e-report.json, claims.json, gate reports)
- **Stage:** `post-tdd` (the gate runs once, after the TDD stage, before commit)
- **`PACKAGES`:** the `orchestrate.config.json` package keys this run touches. Invoked by hand
  without it, take the packages the changed files sit under.

---

## Evidence

Every check command runs with `<command> 2>&1; echo "EXIT_CODE=$?"`, and every claim in the report
cites the command, its exit code, and parsed summary metrics — never raw dumps. Full formatting rules,
the report template, and the state-snapshot commands live in `references/gate-report-format.md`.

---

## Commands & baseline

**Every check below runs once per package in `PACKAGES`**, and the row's verdict is the union: one
package failing fails the check. Commands resolve by the rule in
`skills/orchestrate/references/config.md`, which owns it. `baseline.json` holds what those same
packages scored before this run's work; a package with no baseline entry is **BLOCKED**, never a
zero.

Each tool resolves to one of three states:

- `DECLARED` — the config names a command for it.
- `NOT_APPLICABLE` — justified skip: the config names no such command for this package, or all its changed files are `.md`. Name the package and the reason.
- `MISSING` — the config names a command that does not resolve → **BLOCKED verdict**; the config is stale, not the code.

---

## Gate Checks

### Check 1: Type Checker

- Run each package's `typecheck`
- **Pass:** Exit code 0
- **Fail:** Non-zero exit code
- Report: per package, exit code, error count, specific errors

### Check 2: Linter

- Run each package's `lint`
- **Pass:** Exit code 0 OR no new warnings compared to that package's baseline
- **Fail:** New warnings introduced (count > baseline)
- Report: per package, exit code, warning count, delta from baseline

### Check 3: Test Suite + Behavior Coverage (ONE run, feeds both Check 3 and Check 4)

- Where the package declares `coverage_all`, run it: one invocation of the **unit** suite with
  coverage enabled, feeding both Check 3 (pass/fail) and Check 4 (coverage). Coverage runs the tests,
  so a plain test run followed by a separate coverage run executes the whole suite twice — do NOT do
  that.
- Where it does not, run `test_all` and mark Check 4 `NOT_APPLICABLE` for that package: "declares no
  coverage command". A package without coverage tooling is not a block.
- Either way this is the unit suite only: it must **not** invoke the package's `e2e` command, which
  the coder already ran.
- **Pass:** Exit code 0
- **Fail:** Non-zero exit code
- Test count is NOT compared — consolidation may legitimately reduce it.
- Report: per package, exit code, pass/fail/skip counts

### Check 4: Coverage (diagnostic only — parsed from the Check 3 run, do NOT re-run the suite)

- Parse the coverage percentage from the Check 3 run's output. Do not invoke the suite again.
- **Report only — this check never fails.** Line coverage is a diagnostic, not a gate.
- On a drop vs baseline, emit an INFO line: "Coverage dropped X% → what behavior is missing from the matrix?"
- No package declares `coverage_all` → INFO note, not BLOCKED
- Report: per package, coverage percentage, delta from baseline, verdict INFO

### Check 5 — removed

Compared changed files against "the plan's file list" — a section no plan template ever
defined, so it never enforced anything. The number is retired, not reused; the plan's
create/modify file table serves human review, not this gate.

### Check 6 — removed

Plan-compliance checking moved out of the gate: the plan gate reviews the plan, and Check 9 verifies the e2e evidence. The gate no longer reads plan artifacts.

### Check 7: Comment Audit

One scan, `git diff --unified=0 2>&1 | grep -E '^\+[^+]'`, read two ways.

**Ignore directives — blocking.** Search the added lines for `@ts-ignore`, `@ts-expect-error`,
`# noqa`, `//nolint`, `#[allow(`, `eslint-disable`.

- Report exact file, line, and pattern for each match
- **Pass:** No new ignore directives, OR all of them have inline justification
- **Fail:** Any new ignore directive without inline justification → BLOCKED
- This part alone decides the row's verdict.

**New comments — judge and remove.** From the same added lines, take every one that is a comment.
Read `code-quality`'s **Comments** section and judge each against its three triggers — that
skill is the only definition; do not restate or reinvent them here. Delete the
comments that fail, with `Edit`, and leave the ones that pass.

This is the last stage that reads the diff before it is committed, so a comment that survives here
ships. Removing one cannot change behavior, which is why this check fixes rather than blocks — and
why nothing needs re-running after it acts.

- Report every deletion as `file:line` with the text removed
- **Pass:** always — the failures are gone rather than flagged
- `0 removed` is a result. State it; never omit the line.
- Report: `N new ignore directives · M comments removed`

### Check 8 — removed

Hunted a "Smoke Test" section no template ever defined, so it INFO-passed on every run.
The number is retired, not reused; runnable end-to-end proof is Check 9's job, and
human-observable properties are functional-verify's job, not the gate's.

### Check 9: E2E Report Verification

This check **only reads** the coder's e2e artifacts — it does not launch a browser or re-run the e2e suite. The suite ran once, during coding. It reads two files: `e2e-report.json` (the raw run summary) and `claims.json` (the aggregated claim ledger).

- Read `.harness/<SPEC_NAME>/e2e-report.json`
- If no package in `PACKAGES` declares an `e2e` command → `NOT_APPLICABLE`, naming them: the project has no e2e leg.
- If a package declares `e2e`, the file does not exist, and the task has user-facing changes → **BLOCKED**: "E2E tests were not run during coding — no e2e-report.json found". The runner should **emit this file itself** from its machine output (e.g. Playwright's JSON reporter) — a `failed`/`coverage`/`timestamp` derived from the actual run, not hand-authored. A report whose numbers can't be traced to a runner invocation is not evidence.
- If `not_applicable: true` → `NOT_APPLICABLE` with the reason from the file
- If file exists, verify:
  1. `failed` count is 0 — any E2E failures during coding are a hard block
  2. `coverage` array is non-empty — the report must cover at least one scenario
  3. Each `coverage[].scenario` is a scenario `S<n>` id (not a requirement id)
  4. `gaps` field exists and is non-empty — a report with no documented gaps is suspicious; flag as WARNING (not BLOCKED)
  5. Timestamp is within the pipeline run window (not stale from a previous run)
- **Then corroborate against `claims.json`** (aggregated from the coder's `phase-*-claims.json`), when present: aggregated `failed == 0` and `executed > 0`, and every `type: "ui"` claim's `proven_by` names a real test. A `claims.json` that disagrees with `e2e-report.json` (e.g. `failed > 0` in one) is a hard block — the two views of the same run must agree.
- **Pass:** `failed` = 0 in both files, coverage non-empty, timestamp current
- **Fail:** `failed` > 0 in either file, or coverage empty, or a coverage S-id doesn't resolve, or e2e-report.json missing for a user-facing task
- Report: failed count (both files), coverage count, gap count, S-id resolution results

### Check 10: Mutation Spot-Check

Detects tautological / written-to-pass tests — the only check that proves tests can fail for the right reason.

1. From the code changed in this run, pick 3-5 behaviors. Prefer the riskiest: branching
   logic, validation, calculations.
2. Confirm the working tree is clean for the target files (`git diff --quiet -- <file>` or note the
   exact pre-mutation content). Apply ONE mutation at a time to the production code:
   - Invert a boolean condition (`if (x)` → `if (!x)`)
   - Replace a return value with a constant
   - Introduce an off-by-one (`<=` → `<`, `+ 1` removed)
3. Run the scoped test(s) for that behavior — the owning package's `test_file`, the relevant test
   file substituted for `{FILE}`. Unscoped (no `{FILE}`), read the behavior's own test line rather
   than the exit code.
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
run: Checks 1–3, 6, 7, and 10 are mandatory, Check 9 always runs, and Check 4 is diagnostic (never
blocks). Checks 5 and 8 are retired — their numbers stay unassigned.

If the gate returns **BLOCKED**, the pipeline stops there — the orchestrator reports what failed and does
not proceed.

---

## Gate report

Write the report to `.harness/<SPEC_NAME>/gate-report-<stage>-<NNN>.md` following
`references/gate-report-format.md` (Toolchain + Results tables, then per-check evidence). It carries
the markers `<!-- QG:VERDICT:… -->` and `<!-- QG:CHECK:N:… -->` (N ∈ {1,2,3,4,6,7,9,10}) that the orchestrator
greps — always emit them.

---

## Verdict Logic

Binary verdicts — no WARN tier:

- **`PASS`** — all mandatory checks pass **in every package in `PACKAGES`** (Checks 1-3, 6, 7, and 10, plus Check 9 where a package declares `e2e`; Check 4 is diagnostic and never blocks)
- **`BLOCKED`** — any mandatory check fails (with specific reasons listed)
- **`STAGNATION`** — same check failed 3 consecutive times across gate runs (special signal: stop entirely, don't retry)

---

## Stagnation Detection

Read previous gate reports from `.harness/<SPEC_NAME>/gate-report-*.md`.

Compare error signatures: check name + first error line. If the **same check fails 3 consecutive times with the same error signature**, report STAGNATION.

On stagnation: stop the pipeline and report — do not retry further.

Format: "STAGNATION DETECTED: [check] has failed 3 consecutive times with: [error summary]"

---

## Anti-Patterns

The checks enforce most discipline on their own. These three are judgment calls no single check catches:

- **Weakening a threshold** — every check runs at full strength, every run. Zero errors means zero, not "zero minus the minor ones."
- **Marking NOT_APPLICABLE without justification** — state why the tool doesn't apply (e.g. "all changed files are `.md`"). An unjustified skip is a MISSING tool, which blocks.
- **Running without a baseline** — capture `baseline.json` first; without it, regressions are invisible, and a reported coverage number must come from the tool run, never an estimate.
