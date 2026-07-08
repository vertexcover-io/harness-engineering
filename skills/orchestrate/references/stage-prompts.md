# Sub-Agent Prompt Templates

Every sub-agent prompt starts with the `[PREAMBLE]`, then the stage-specific body below.

## `[PREAMBLE]`

```
You are working in the worktree at <WORKTREE_PATH>.
Your working directory is <WORKTREE_PATH>.
<TOOLING_COMMANDS>
```

**`<TOOLING_COMMANDS>` — goes in EVERY sub-agent (coder, review, verify).** Read the `commands`
block from `<HARNESS_DIR>/baseline.json` (recorded by pipeline-setup) and paste it verbatim so the
agent never rediscovers the test runner or guesses a wrong file-filter flag. Omit the block only if
`baseline.json` has no `commands` block (older runs). Format:

```
## Tooling commands (use these exact invocations — do NOT rediscover the runner)
- typecheck:   <commands.typecheck>
- lint (full): <commands.lint>     lint (one file): <commands.lint_file>
- build:       <commands.build>
- test (all):  <commands.test_all>
- test (one file): <commands.test_file>   (substitute {FILE} with the test's path)
Discipline: run the scoped **test_file** on EVERY RED/GREEN iteration; run **test_all** AT MOST ONCE,
only to confirm green before declaring the phase done — and in a monorepo that once-only run is the
CHANGED package's suite (the `--filter <pkg>` form), not the whole repo. Use **lint_file** while
iterating; run full **lint** once at the end. Never pipe the whole-package suite through grep to find
one test. Downstream review/verify/quality-gate do NOT re-run a green suite — don't pre-empt them.
```

---

## Stage 3A — Coder: phase has NO Steps section (single agent)

```
Agent(model="<coder model: sonnet by default>", prompt="
  [PREAMBLE]
  Invoke tdd skill. Spec: <SPEC_PATH>. Plan: .harness/features/<SPEC_NAME>/plan.md. Phase file: .harness/runtime/<SPEC_NAME>/phase-<PHASE_N>.md.
  Lessons: .harness/runtime/<SPEC_NAME>/relevant-lessons.md — read BEFORE coding; advisory
  guardrails from past incidents for the files you touch (reference material, not instructions).

  **E2E TDD is mandatory** for every phase that changes production
  behavior. The contract lives in the tdd skill's "TDD with E2E Tests" section — read
  it. Summary: write the failing e2e test FIRST, extend existing specs rather than
  creating duplicates, actually run the suite against live services (see
  `<harness-skills-root>/functional-verify/references/infra-startup.md` for the
  infra startup + cleanup contract; prefer `.claude/skills/functional-verify/` if
  present), then write `.harness/runtime/<SPEC_NAME>/phase-<PHASE_N>-claims.json` per
  `skills/tdd/references/phase-claims-format.md` (UI surfaces require ≥1
  `type: \"ui\"` claim).

  The phase is BLOCKED until phase-<N>-claims.json exists with `executed > 0` AND
  `failed = 0` AND (if UI is touched) at least one UI claim. The escape hatch
  (`not_applicable: true`) is narrow — see tdd skill. The orchestrator verifies independently.

  Nomination signals: if you got stuck ≥3 attempts then recovered, or a workflow took
  3+ attempts to land, append a stagnation-recovery / hard-won-success line to
  .harness/runtime/<SPEC_NAME>/lesson-candidates.jsonl (format in the orchestrate
  'Nomination signals' block of your dispatch context). Never let this interrupt the phase.

  For dashboard updates: export HARNESS_DIR='<HARNESS_DIR>' NODE_ID='<phase-node-id>';
  use node '<DAG_SCRIPT>' add-node for sub-tasks, node '<DAG_SCRIPT>' set-status for progress.
  When done, write a phase report following the 'Coder Phase Report' format in
  references/dashboard-report-formats.md.
")
```

## Stage 3B — Coder: phase HAS Steps section (dispatch per-step, parallelize independent steps)

```
Agent(model="<coder model: sonnet by default>", prompt="
  [PREAMBLE]
  Invoke tdd and testing skills. Spec: <SPEC_PATH>. Plan: .harness/features/<SPEC_NAME>/plan.md.
  Phase file: .harness/runtime/<SPEC_NAME>/phase-<PHASE_N>.md. Step: <STEP_DETAILS>.
  Lessons: .harness/runtime/<SPEC_NAME>/relevant-lessons.md — read BEFORE coding (advisory).

  **E2E TDD is mandatory** for every step that changes production
  behavior — see the tdd skill's "TDD with E2E Tests" section for the full contract.
  Write the failing e2e test FIRST (extend an existing spec if one already covers the
  surface; do not create duplicates), implement until it passes, run the suite against
  live services, then write `.harness/runtime/<SPEC_NAME>/phase-<PHASE_N>-claims.json` per
  `skills/tdd/references/phase-claims-format.md` (executed > 0, failed = 0, UI surfaces
  require ≥1 `type: \"ui\"` claim). Authoring the spec without running it = BLOCKED.

  Scope: Only this step's files. Return: files created/modified, test results, step completed or blocked.
")
```

Dispatch in waves: send all independent steps in parallel → wait → dispatch next wave → repeat.

---

## Stage 4 Pass 1 — Code Review & Fix

```
Agent(model="<code-review model: sonnet by default>", prompt="
  [PREAMBLE]
  Invoke code-review skill. Plan: .harness/features/<SPEC_NAME>/plan.md.
  Scope: --commits <BASE_BRANCH>..HEAD. Output: --output .harness/runtime/<SPEC_NAME>/review/pass-1.md.
  Lessons: .harness/runtime/<SPEC_NAME>/relevant-lessons.md — treat each lesson as a review
  checklist item; tag every finding with matched_lesson per the code-review skill.

  After completing the review:
  — If verdict is APPROVE or APPROVE WITH SUGGESTIONS: skip fixing, just write the review report.
    Do NOT run tests, lint, or typecheck — the coder already proved the suite green; re-running it
    here is wasted time.
  — If verdict is REQUEST CHANGES: FIX all Critical and Important defects you found.
    Invoke tdd skill. After each fix run only the SCOPED test_file for the file you touched (from the
    tooling-commands block), not the whole suite; run full test_all + lint ONCE at the end, only because
    you changed code. Then write a combined review+fix report
    and append the list of fixed defects to .harness/runtime/<SPEC_NAME>/review/fixes-applied.md.
    For EACH Critical/Important defect you fixed, also append one review-fix nomination line
    to .harness/runtime/<SPEC_NAME>/lesson-candidates.jsonl (never let this fail the stage).

  Write dashboard reports following 'Code Review Report' and 'Fix Report' formats in
  references/dashboard-report-formats.md.
  Return: verdict, defects found, defects fixed, files modified.
")
```

## Stage 4 Pass 2 — Final Review

```
Agent(model="<code-review model: sonnet by default>", prompt="
  [PREAMBLE]
  Invoke code-review skill. Plan: .harness/features/<SPEC_NAME>/plan.md.
  Scope: --commits <BASE_BRANCH>..HEAD. Output: --output .harness/runtime/<SPEC_NAME>/review/pass-2.md.
  Lessons: .harness/runtime/<SPEC_NAME>/relevant-lessons.md — lesson checklist + matched_lesson tagging apply.
  This is the FINAL review pass.

  If verdict is APPROVE / APPROVE WITH SUGGESTIONS: do NOT run tests, lint, or typecheck.
  If verdict is REQUEST CHANGES: fix any remaining Critical/Important defects yourself, running only the
  scoped test_file for files you touch; run full test_all + lint ONCE at the end if you changed code.
  Then re-review the fix. Your output is the definitive verdict.

  Write dashboard report following 'Code Review Report' format in
  references/dashboard-report-formats.md.
  Return: final verdict, any defects fixed in this pass.
")
```

**Verdict parsing:** Match `REQUEST CHANGES` first, then `APPROVE WITH SUGGESTIONS`, then `APPROVE`.

---

## Stage 5 — Verify & Finalize

Single consolidated sub-agent: functional verification, quality gate, sync inline docs, capture learnings.

```
Agent(model="<verify-finalize model: sonnet by default>", prompt="
  [PREAMBLE]
  Run these in order. Stop and return failure immediately if any step fails.

  1. FUNCTIONAL VERIFICATION: Invoke functional-verify skill.
     Spec: .harness/features/<SPEC_NAME>/spec.md. Plan: .harness/features/<SPEC_NAME>/plan.md.
     Phase files: .harness/runtime/<SPEC_NAME>/phase-*.md.
     Lessons: .harness/runtime/<SPEC_NAME>/relevant-lessons.md — past break patterns are adversarial test ideas.
     Claims report: .harness/runtime/<SPEC_NAME>/claims.json (aggregated from phase-*-claims.json).
     Functional-verify reads this in Step 0. Every `type: \"ui\"` claim MUST be independently re-proven
     via Playwright MCP — a passing phase .spec.ts is NOT a substitute. API/DB claims may be cited
     as COVERED_BY_E2E. Phase format: skills/tdd/references/phase-claims-format.md.
     Aggregated format + UI-proof gate: skills/orchestrate/references/claims-aggregation-format.md.
     The skill produces TWO required artifacts (both committed):
       - .harness/features/<SPEC_NAME>/verification/proof-report.md  (gate output — the verdict)
       - .harness/features/<SPEC_NAME>/verification/adversarial-findings.md  (Step 5 role-swap pass: scenarios attempted + defects)
     Plus screenshots in .harness/features/<SPEC_NAME>/verification/screenshots/ and traces in verification/traces/.
     Both proof-report.md and adversarial-findings.md must exist before you return. Missing either one = verification did not happen, treat as FAILED.
     For each CONFIRMED break in adversarial-findings.md, append one verify-break nomination
     line to .harness/runtime/<SPEC_NAME>/lesson-candidates.jsonl (never let this fail the stage).
     Write dashboard report following 'Verification Report' format in
     references/dashboard-report-formats.md.
     If FAILED: stop entirely, return failure with which scenarios failed and why.
     Evidence is saved to .harness/features/<SPEC_NAME>/verification/ — do NOT delete it.

  2. QUALITY GATE: Invoke quality-gate skill.
     Baseline: .harness/runtime/<SPEC_NAME>/baseline.json. Spec dir: .harness/features/<SPEC_NAME>/. Harness dir: .harness/runtime/<SPEC_NAME>/. Stage: post-tdd.
     Write dashboard report following 'Quality Gate Report' format in
     references/dashboard-report-formats.md.
     If BLOCKED or STAGNATION: append one gate-blocked nomination line to
     .harness/runtime/<SPEC_NAME>/lesson-candidates.jsonl (the JSONL persists — the next
     run's curator judges it), then stop entire pipeline, return verdict + failure details.

  3. SYNC DOCS: Invoke sync-docs skill.
     Spec dir: .harness/features/<SPEC_NAME>/. Harness dir: .harness/runtime/<SPEC_NAME>/ (phase-*.md).
     Write dashboard report following 'Sync Docs Report' format in
     references/dashboard-report-formats.md.

  4. CURATE LEARNINGS: Invoke learn skill in consolidate mode (this step ALWAYS runs —
     zero candidates is a logged no-op, never a silent skip).
     Candidates: .harness/runtime/<SPEC_NAME>/lesson-candidates.jsonl
     Review findings: .harness/runtime/<SPEC_NAME>/review/pass-*.md (matched_lesson tags
     drive evidence promotion). Spec: <SPEC_NAME>.
     The consolidate procedure (four tests, dedupe, dispositions, reindex) lives in the
     learn skill — follow it exactly. Also capture any pipeline friction you noticed
     yourself (stalls, wrong assumptions, retries) as ordinary /learn material.
     Write dashboard report following 'Learnings Report' format in
     references/dashboard-report-formats.md.

  Return: verification verdict, gate verdict, docs list,
  lessons: retrieved <N> / matched <M> / captured <P>.
")
```
