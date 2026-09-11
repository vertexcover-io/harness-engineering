---
name: quality-gate
description: "Post-stage verification with hard pass/fail thresholds. Every claim backed by verbatim command output — no check may be silently absent, skipped, or weakened. Runs after TDD, refactor, and before PR. Reads each package's commands from orchestrate.config.json and its baseline metrics from .harness/<SPEC_NAME>/baseline.json."
user-invocable: false
---

# Quality Gate: Tool-Based Verification

Load the `writing-style` skill before you write `gate-report-<stage>-<NNN>.md`. Run its
ship-check before you return a verdict.

This is the gate between "the coder says it's done" and "the feature ships." Every verdict is backed by **evidence** — verbatim command output, never an adjective. No check may be silently absent, skipped, weakened, or overridden by a sub-agent.

**Announce at start:** "Running quality gate checks against baseline metrics."

**First action: read `orchestrate.config.json` at the repo root.** Every command and package path this skill uses comes from it, resolved per `skills/orchestrate/references/config.md`.

---

## Inputs

The quality gate receives these parameters from the orchestrator:

- **Feature dir:** `.harness/<SPEC_NAME>/` (gitignored — baseline.json, phase-*-e2e.json, gate reports)
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

### Check 3: Test Suite + Behavior Coverage

- Run each package's `test_all`. This is the unit suite only: it must **not** invoke the package's `e2e` command, which
  the coder already ran.
- **Pass:** Exit code 0
- **Fail:** Non-zero exit code
- Test count is NOT compared — consolidation may legitimately reduce it.
- Report: per package, exit code, pass/fail/skip counts

### Check 4 — removed

Line coverage as a percentage. No runner's output format was pinned down, so the number was parsed
out of a text table and compared against a baseline parsed the same way. Behaviour coverage is
Check 3's job and does not depend on it. `coverage-guard` remains for anyone who wants the number.

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

This check **only reads** the runner output each coder phase left behind — it does not launch a browser or re-run the e2e suite. The suite ran once per phase, during coding. Every file it reads is machine-written, so there is no summary to take on trust.

- Read every `.harness/<SPEC_NAME>/phase-*-e2e.json`. Each phase in `phases/` owes one, or a `phase-<N>-e2e-skipped.md` naming why.
- If no package in `PACKAGES` declares an `e2e` command → `NOT_APPLICABLE`, naming them: the project has no e2e leg.
- If a package declares `e2e`, a phase has neither file, and the task has user-facing changes → **BLOCKED**: "E2E tests were not run during coding — no phase-N-e2e.json found".
- A `phase-<N>-e2e-skipped.md` → that phase is `NOT_APPLICABLE` with the reason from the file; the remaining phases are still checked.
- **A hand-authored file is not evidence.** These are runner reports (Playwright/vitest/jest JSON). One that does not parse as its runner's schema is **BLOCKED** — an agent wrote it.
- For each report, derive the counts yourself from the runner's result records — never from a top-level total an agent could have edited — and verify:
  1. Executed count is > 0 — a suite authored but never run is a hard block
  2. Failed count is 0 — any E2E failure during coding is a hard block
  3. At least one test title carries a scenario `SC<n>` id, and every id it carries resolves to a scenario heading in the phase file
  4. File mtime is within the pipeline run window (not stale from a previous run)
- **Pass:** executed > 0 and failed = 0 in every report, SC-ids resolve, files current
- **Fail:** failed > 0 in any report, or executed = 0, or an SC-id doesn't resolve, or a phase report missing for a user-facing task
- Report, per phase: executed count, failed count, SC-id resolution results

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

The gate runs once, at `post-tdd` — after implementation is complete and before commit.
Checks 1–3, 7, and 10 are mandatory and Check 9 always runs. Checks 4, 5, 6 and 8 are retired —
their numbers stay unassigned.

If the gate returns **BLOCKED**, the pipeline stops there — the orchestrator reports what failed and does
not proceed.

---

## Gate report

Write the report to `.harness/<SPEC_NAME>/gate-report-<stage>-<NNN>.md` following
`references/gate-report-format.md` (Toolchain + Results tables, then per-check evidence).
That reference owns the verdict and per-check markers; always emit them.

---

## Verdict Logic

Binary verdicts — no WARN tier:

- **`PASS`** — all mandatory checks pass **in every package in `PACKAGES`** (Checks 1-3, 7, and 10, plus Check 9 where a package declares `e2e`)
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
