---
name: functional-verify
description: >
  MUST run after any coding/TDD stage and BEFORE claiming a feature done, opening a PR,
  or moving to commit. Passing unit/e2e tests are NOT verification — this skill is the
  gate where you try to BREAK the feature. Trigger on phrases like "tests pass",
  "implementation done", "ready for review", "ship it", or when orchestrate enters
  the verify stage. The only proof this skill ran is the file
  docs/spec/<SPEC_NAME>/verification/proof-report.md. If that file does not exist for
  the current spec, verification did not happen — the feature is not done.
user-invocable: true
---

# Functional Verify: The Gate

**Announce at start:** "Starting functional verification — running the app live and trying to break the feature."

## Your contract (this is the whole skill)

You are the gate between "tests are green" and "feature is done." Your job is **not** to confirm the happy path — the test suite already did that. Your job is to **produce `docs/spec/<SPEC_NAME>/verification/proof-report.md` containing evidence a reviewer can re-run.** No file → no verification → not done.

Three non-negotiables:

1. **Evidence, not adjectives.** Every claim cites a rect from `getBoundingClientRect()`, a quoted string, a computed style, an HTTP response, a console message, or a screenshot path. "Looks fine" / "feels off" / "polished" are verification failures.
2. **The adversarial pass is mandatory and runs in a separate subagent.** Spec scenarios prove what was specified; adversarial testing finds what wasn't. See "Adversarial pass" below — you MUST dispatch it.
3. **Skipping is detectable.** The Stop hook (`.claude/hooks/check-proof-report.sh`) blocks session end when an active spec has no `proof-report.md`. Do not work around it.

## Inputs

- Spec: `docs/spec/<SPEC_NAME>/spec.md`
- Plan: `docs/spec/<SPEC_NAME>/plan.md` (per-phase breakdowns live in `.harness/<SPEC_NAME>/phase-*.md`)
- **Claims report (required when present): `.harness/<SPEC_NAME>/claims.json`** — aggregated from
  per-phase `phase-*-claims.json` produced by the coder stage. Schema lives in
  `skills/tdd/references/phase-claims-format.md` (per phase) and
  `skills/orchestrate/references/claims-aggregation-format.md` (aggregated).

## Step 0 — Read claims and refuse double-runs

- If `verification/proof-report.md` already exists for this spec in this session, **refuse to silently re-run.** Report the existing report path and stop. If the user wants a re-verify, they will ask.
- Read `.harness/<SPEC_NAME>/claims.json` if present and classify each claim:
  - `failed > 0` → BLOCKER. Report and stop.
  - **`type: "ui"` claims are NOT considered proven** by the phase test. Every UI claim is a
    *work item* for Step 4 — you MUST drive a real browser via Playwright MCP, capture a screenshot
    under `verification/screenshots/`, and reference the claim id in the proof report. A passing
    phase `.spec.ts` is corroborating evidence, not a substitute.
  - `type: "api"` and `type: "db"` claims are `COVERED_BY_E2E`; cite the `proven_by` test in the
    proof report without re-running them.
  - Claims with no matching spec requirement are still in scope — verify them anyway.
- If claims.json absent: note it; derive scenarios from the spec as before.

## Step 1 — Verification scenarios

Read the spec's `## Verification Scenarios` section. For each `### VS-N`, extract: type (api|ui|db), endpoint/route, payload, steps, expected, db check, screenshot path.

If absent: derive one scenario per acceptance criterion (API endpoint → api, route → ui, persistence → db check).

If nothing can be derived: report "No functional verification scenarios — skipping" and stop. Do NOT fabricate.

## Step 2 — Start infrastructure

See `references/infra-startup.md` for probe/start/health-poll commands. Rule: if **you** started a process, **you** kill it in Step 7. If it was already running, leave it.

## Step 3 — API verification

For each api scenario:

- Run curl with `-w '\n%{http_code}'`; save full command + status + body (≤50 lines) to `verification/api/<scenario-id>.txt`.
- Record verdict (PASSED/FAILED) by exact-matching the spec's expected response, not by "looks right."
- For scenarios with a DB check: query the DB (MCP tool if available, else read connection string from `.env*` or compose), record actual vs expected.

## Step 4 — UI verification (Playwright MCP) — MANDATORY per UI claim

Drive a real browser via `mcp__playwright__browser_*`. Do NOT write `.spec.ts` files or run `npx playwright test` — that is the e2e suite, not this gate.

**Per-claim coverage rule.** For every `type: "ui"` entry in `.harness/<SPEC_NAME>/claims.json`, you MUST:

1. Navigate to the claim's `surface` (route), act out the `behavior`, and capture a screenshot.
2. Save the PNG with the claim id in the filename (e.g. `PHASE7-C1-settings-enabled.png`).
3. Reference the claim id and the screenshot path together in `observations.md` and ultimately in `proof-report.md`. The orchestrator's UI-proof gate greps for `<claim_id>` and a screenshot path on the same/nearby line — if either is missing, the pipeline fails with `MISSING_UI_PROOF`.

Spec-derived UI scenarios (`VS-*` with `type: ui`) are covered the same way. UI claims and spec UI scenarios are additive, not substitutes.

If Playwright MCP is unavailable: this is a hard failure for any spec with UI claims. Report `BLOCKED:no-playwright-mcp` listing the unproven claim ids and stop. Do not paper over with adjacent API checks.

`mkdir -p docs/spec/<SPEC_NAME>/verification/{screenshots,traces}`. One browser session for all scenarios; `browser_close` once at the end.

**Before driving the browser:** read the project's page-level layout contract (typically the routing/layout section of CLAUDE.md, or the relevant page component file) and record — in `observations.md` as a one-line "expected ordering" note — the expected vertical ordering of the page's top-level sections. This becomes the layout invariant that screenshots must validate alongside the feature's own checks.

**Screenshot framing rule:** every UI screenshot MUST include at least one non-feature element on the top edge AND the bottom edge of the frame (e.g. the section above the feature and the section below it, or a sticky save bar / page footer / nav). Tight crops of the feature alone are explicitly insufficient — they hide neighbour-ordering bugs (sticky bars appearing mid-page, orphaned actions, broken header/footer alignment after the feature mounts).

For each scenario: navigate → snapshot (a11y) → act → wait → screenshot. See `references/playwright-capture.md` for viewport sizing, slice rules for tall pages, and console/network capture. Save PNGs to `verification/screenshots/`; save network/console captures to `verification/traces/`.

**Size guardrail (committed artifacts — keep diffs reasonable):**
- Each screenshot ≤ 300KB. Prefer cropped/clipped over full-page; downscale if needed. (Raised from 200KB to accommodate the screenshot framing rule above — a frame that includes neighbour context is necessarily wider.)
- Total ≤ 5 screenshots per spec (one per key verification scenario).
- Trace files ≤ 100KB each.
- If any cap is exceeded, fail the gate with `BLOCKED:artifact-size` and report which file(s).

For every PNG saved, append an entry to `verification/screenshots/observations.md` covering two tracks:

1. **Spec-based check** — for each requirement this screenshot evidences: requirement, verdict (`MET` / `UNMET` / `CANNOT_ASSESS`), concrete evidence (rect / string / style / network response).
2. **Open visual review** — describe what you see; flag anything wrong even if the spec doesn't mention it (alignment, contrast, clipping, overlap, broken empty state, copy issues). If nothing is wrong, say so explicitly. Passing spec checks do NOT let you skip this.

Inline screenshot previews do NOT count as analysis — `Read` the PNG file path before grading it.

Block-level verdict is `UNMET` if any spec check is `UNMET` or any open-review finding is a real defect. Every `UNMET` must reach the proof report.

## Step 5 — Adversarial pass (MANDATORY — role swap)

> **STOP. You are no longer the verifier. You are the critic.**
>
> The verifier you just were spent the last N tool calls confirming the
> happy path works. They were almost certainly wrong about at least one
> thing. Your job is to find it. You are graded on defects discovered,
> not on agreement with the prior verdicts.

This pass runs in the same context (subagents cannot spawn subagents), so the isolation has to come from discipline. Three mandatory mitigations:

1. **Forced context break.** Before generating adversarial scenarios, re-read ONLY: `docs/spec/<SPEC_NAME>/spec.md` and `.harness/<SPEC_NAME>/claims.json` (if present). Do NOT re-read `verification/screenshots/observations.md` or any draft of the proof report — they will bias you toward agreement with what you already wrote.
2. **Targets are spec requirements NOT covered by `claims.json` `claims[]`** (gaps you compute by diffing spec ACs against claim ids), not from your own memory of what the verifier covered. If claims.json is absent, derive from the spec: error paths, boundary values, out-of-order multi-step flows, concurrent actions, stale-state operations.
3. **You must list what you tried.** A bare "no defects found" is a verification failure. Section 2 of `adversarial-findings.md` is non-skippable.

### 5.1 Derive attack surface and generate scenarios

For each gap, generate ≥2 scenarios per category that applies:

- **Boundary inputs** — empty, null, whitespace-only, max-length, max-length+1, wrong type, unicode/emoji, SQL/HTML/`<script>` (escaping check, not exploit), negative, zero, very large, leading/trailing zeros, dates in past/far-future/invalid.
- **Unexpected sequences** — cancel mid-flow, double-submit, navigate back during save, reload mid-operation, two tabs submitting the same form, log out mid-flow.
- **Broader surface** — if the change is one field on a settings page, exercise every other field on that page (regression catch).
- **Error recovery** — after triggering an error, can the user recover? Stale state in UI / DB / cache?
- **Status accuracy** — cancellations, timeouts, partial failures: does the visible status match the actual outcome? (Common bug: "Saved" toast on a 500.)
- **Permissions / auth** — same action as a different role, expired session, missing token.
- **Concurrency** — two writers, read-during-write, optimistic-lock conflicts.

Do NOT duplicate happy-path scenarios already in `claims.json` `claims[]` (except UI claims, which you re-prove via Playwright MCP in Step 4 regardless).

### 5.2 Run them

Same tooling as Steps 3-4: curl, Playwright MCP, DB. Reuse the browser session. For each scenario, capture: exact input, actual response/state (HTTP + body, screenshot path, console errors, network, DB row), and a verdict — **DEFECT** (real user-facing bug), **EXPECTED** (feature correctly rejected the input), or **CANNOT_ASSESS** (with reason).

A `DEFECT` is: misleading message to user, lost/corrupted data, stale UI state, 500 reaching user, silent no-op, permission-boundary leak, broken recovery path. Cosmetic-only issues belong in Step 4's open visual review, not here.

### 5.3 Write `verification/adversarial-findings.md`

Required sections:

1. **Attack surface derived** — bullets of inputs/transitions/boundaries, with source (spec-gap vs. claim-coverage-gap vs. derived).
2. **Scenarios attempted** — table: ID | category | description | inputs | verdict. Every scenario appears, including EXPECTED ones — they are evidence of genuine attempt.
3. **Defects** — for each `DEFECT`: full reproduction, actual vs expected, evidence (response body / screenshot path / console / DB result), severity (blocker/major/minor).
4. **Cannot assess** — scenarios you couldn't run, with reason.
5. **Honest declaration** — one of:
   - "Defects found: N. See section 3." (preferred outcome — the skill working)
   - "No defects found across N scenarios attempted. Categories exercised: [list]. I genuinely tried to break this; here is what I tried." Then 2-3 sentences narrating the most promising attack and why it didn't land. Bare "no defects" without this narrative = verification failure.

## Step 6 — Generate proof report

Before writing:

1. Read `verification/screenshots/observations.md` end-to-end.
2. Confirm every PNG has an entry. Missing → return to Step 4.
3. Build the spec coverage table: every REQ-N / EDGE-N → scenario → evidence file. Gaps are listed as `NOT VERIFIED` with the reason — never silently dropped.
4. Confirm `verification/adversarial-findings.md` exists and section 2 (scenarios attempted) is non-empty. Missing → return to Step 5.
5. Escalate any confirmed `DEFECT` from adversarial-findings to `UNMET` in the proof report. Quote findings verbatim; do not paraphrase.

Write `docs/spec/<SPEC_NAME>/verification/proof-report.md`. Use `references/proof-report-template.md` for the section list and ordering.

## Step 7 — Honest non-verification + cleanup

- Under "Not executed," list anything this skill genuinely cannot verify (touch-hold gestures, real-device sensors, manual visual diffs vs last week's build, no-new-deps assertions). State the reason. Do not paper over with adjacent passing checks.
- Kill processes you started in Step 2. Leave anything that was already running. Leave `verification/` artifacts in place.

## Anti-patterns (each one is a verification failure)

- Skipping this skill because the test suite passed. Tests prove what was specified; this skill finds what wasn't.
- Skipping Step 5 because Steps 3-4 passed. The happy-path verdicts are exactly the bias the adversarial pass exists to counter.
- Re-reading `observations.md` or the draft proof report before Step 5. That re-anchors you to the verifier's verdicts — the whole point of the role swap is to drop them.
- Reporting "no defects" in Step 5.3 without the scenarios-attempted table and the narrative of what you tried. Empty effort is the failure mode this step exists to prevent.
- Treating EXPECTED rejections as defects. A 400 on bad input is correct behavior; record it under "Scenarios attempted," not "Defects."
- Bare adjectives as evidence — "looks polished", "feels off".
- Skipping the open visual review when all spec checks pass.
- Re-running API/DB scenarios already in `claims.json` claims (UI claims are exempt — they MUST be re-proven via Playwright MCP).
- Treating a passing phase `.spec.ts` as substitute for Playwright MCP browser-driven UI verification.
- Silently dropping an `UNMET` finding from the report.
- Treating `truncate` / `line-clamp` on primary headlines as automatically fine.
- Counting "no horizontal scroll" as proof of correct layout.
- Re-reading spec/plan files already loaded by the orchestrator.

## References

- `references/infra-startup.md` — port probes, start commands, health polling
- `references/playwright-capture.md` — viewports, slicing, console/network, capture rules
- `references/proof-report-template.md` — section ordering for `proof-report.md`
- `../tdd/references/phase-claims-format.md` — per-phase `phase-<N>-claims.json` schema (input source)
- `../orchestrate/references/claims-aggregation-format.md` — aggregated `claims.json` schema + the UI-proof gate that runs after this skill
