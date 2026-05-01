---
name: functional-verify
description: >
  Live functional verification. Starts application infrastructure, runs API tests via curl
  and UI tests via Playwright, captures evidence (payloads, responses, screenshots), and
  generates a proof report at docs/spec/<name>/verification/proof-report.md.
  Verification scenarios are read from the spec's "Verification Scenarios" section or
  derived from the plan. Use when verifying that implemented features actually work
  end-to-end, beyond unit/e2e test suites.
user-invocable: true
---

# Functional Verify: Live Application Testing

Verify implemented features by running the application and testing it like a user or API client — not just running the test suite.

**Announce at start:** "Starting functional verification — running the application and testing features live."

This skill exists because vision LLMs are good at running browsers and bad at honestly grading what they see. The structure below is designed against that failure mode: numbers come before nouns, every check has a typed verdict, and every "MET" must cite evidence that a reviewer can re-run. If you find yourself wanting to write `verdict: OK` somewhere — stop. That isn't a value in this rubric.

## Inputs

- Spec: `docs/spec/<SPEC_NAME>/spec.md`
- Plan dir (incl. `phase-*.md`): `docs/spec/<SPEC_NAME>/`

## Step 1 — Verification Scenarios

Read the spec's `## Verification Scenarios` section. For each `### VS-N: <description>` extract: `**Type:**` (api|ui|db), `**Endpoint:**`/`**Route:**`, `**Payload:**`, `**Steps:**`, `**Expected:**`, `**DB check:**`, `**Screenshot at:**`.

If absent, derive one scenario per acceptance criterion: API endpoints → api; pages/routes → ui; data persistence → db check on the related scenario.

If no scenarios can be derived, report "No functional verification scenarios — skipping" and stop. Do NOT fabricate scenarios. Do NOT re-read spec/plan files if already in context.

## Step 2 — Start Infrastructure

Probe common ports and proceed with whatever responds:
```
for p in 3000 3001 8080 8000 5173 4200; do curl -s -o /dev/null -w "$p:%{http_code}\n" http://localhost:$p; done
```

If a required service isn't up, find a startup command in `package.json` (`scripts.dev|start|start:api`), `docker-compose.yml` / `compose.yml`, or `Makefile` (`up|start|dev`). Start in background:
```
npm run dev &> /tmp/functional-verify.log &
# or
docker compose up -d --wait
```

Poll for health up to 30s: `for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:<PORT> && break; sleep 1; done`.

If you started a process here, you are responsible for killing it in Step 7. If a process was already running when you arrived, leave it alone and note that in the proof report.

## Step 3 — API Verification

For each API scenario:
```
curl -s -w '\n%{http_code}' -X <METHOD> http://localhost:<PORT>/<endpoint> \
  -H 'Content-Type: application/json' -d '<PAYLOAD>'
```

Record scenario ID, exact curl, HTTP status, response body (≤50 lines), expected-match, PASSED/FAILED. Save to `docs/spec/<SPEC_NAME>/verification/api/<scenario-id>.txt`.

**DB check** (when the scenario has one): use a connected DB MCP tool if available; otherwise read the connection string from `.env*` or compose. Run the query, compare to expected, record actual/expected/verdict.

## Step 4 — UI Verification (Playwright MCP)

Drive a real browser via `mcp__playwright__browser_*` tools. Do NOT write `.spec.ts`, run `npx playwright test`, or install `@playwright/test`.

If those tools are unavailable, report "Playwright MCP not available — skipping UI verification" and continue with API/DB only.

`mkdir -p docs/spec/<SPEC_NAME>/verification/ui`.

### 4.1 Drive each scenario

- `browser_navigate` → load the route.
- `browser_snapshot` → a11y tree to locate elements (cheaper than a screenshot).
- `browser_click` / `browser_type` / `browser_fill_form` / `browser_select_option` / `browser_press_key` → user actions.
- `browser_wait_for` → wait for text/state changes.
- `browser_console_messages` → check runtime errors after each flow.
- `browser_network_requests` → optional, when verifying API calls fired from UI.

Reuse one browser session across scenarios; `browser_close` once at the end.

### 4.2 Capture rules

For each route at each in-scope viewport (375 / 768 / 1280 for responsive specs; otherwise the spec's declared viewports):

1. **Page screenshot** — `browser_take_screenshot` with `fullPage: false`. Save as `<route>-<viewport>.png`.
2. **Slices for tall pages** — when `document.documentElement.scrollHeight > 2 × viewport.h`, capture viewport-scale slices at `scrollY = 0, vh, 2vh, …`. Save as `<route>-<viewport>-slice-NN.png`. Full-page screenshots are too compressed for layout review at scale; slices are the evidence.
3. **Component crops** — for any component repeated ≥2 times in the route (cards, rows, list items), tight-crop two instances using `browser_take_screenshot` with a `target` selector. Save as `<route>-<viewport>-<component>-i0.png` and `-i1.png`. Pick instances by index `0` and `⌊N/2⌋` — never let the model choose the "easiest" instance.
4. **Squint capture** — for each component crop, run `document.documentElement.style.filter = 'blur(6px)'`, screenshot, then revert. Save as `<crop>.blur.png`.

Inline previews returned by `browser_take_screenshot` do NOT count as analysis — `Read` each PNG file path before grading it.

### 4.3 Inventory before prose (mandatory)

Before writing a single sentence about a screenshot, run the controls-inventory `browser_evaluate` from `references/visual-rubric.md` Step A and dump the JSON to `verification/ui/<route>-<viewport>.controls.json`. Every prose claim that follows must reference these `id`s — "the trash icon (id 14)" beats "the trash icon".

This is the most important rule in the skill. Skipping it is the failure mode.

### 4.4 Atomic verdict block per screenshot

For every PNG under `verification/ui/`, append a JSON block to `observations.md` following the schema in `references/visual-rubric.md` Step C. The schema is closed: every check field listed there must appear, with a verdict in `{MET, UNMET, CANNOT_ASSESS}` and `evidence` that a reviewer could re-run.

The set of mandatory checks is:

- `clipping`, `overlap`, `double_nav`, `hidden_cta`, `contrast`, `alignment_row_peers`, `target_size_44`, `grid_8pt`, `common_region`, `squint_blur`, `pairwise_with_iN` (for component crops).

Hard rules:

- `MET` without `evidence` is a verification failure. Evidence means rects, mod arithmetic, computed-style values, or quoted text — not adjectives.
- The block-level `verdict` is `UNMET` if any check is `UNMET`. There is no "minor" carve-out.
- "Looks fine" / "OK" / "Looks good" are not values in the schema. If you cannot evaluate something, it is `CANNOT_ASSESS` with the reason.
- For `alignment_row_peers`: name the row peers by id, list their top-edge or center-line coordinates, and give the delta. If the delta exceeds ε=2 px and they are declared peers, the verdict is `UNMET` and the offending id goes in `blocking_findings`.
- For `target_size_44`: either enumerate every interactive rect or give the count and `min(w, h)`. "All ≥44×44" without numbers is not evidence.
- For `pairwise_with_iN` on component crops: list every control by role/label and answer `IDENTICAL | DIFFERENT | MISSING_IN_CROP_2`. Summaries are not allowed.

### 4.5 Adversarial second pass (mandatory when 4.4 produces all-`MET`)

If every block in `observations.md` for a given route was `MET` on the first pass, do not move on. Re-prompt yourself with the screenshots only (verdict block hidden) and this seed:

> "The previous reviewer claims this page is fine. The page contains at least one alignment, grouping, grid, or proximity defect. Find it. Output the rect of the offending element and the rect of the row peers it should align with. If after rect math you cannot find a defect, report 'second pass clean' with the rect math."

Reconcile:

- Findings only in pass 2 → re-ground by rect; if math confirms, escalate the original block to `UNMET`.
- "Second pass clean" with rect math → leave `MET` and note the second-pass attempt in the block under a `second_pass: clean` field.

This is the single most reliable defense against the "model wrote MET because nothing jumped out" failure mode.

### 4.6 Reference image when available

If a Storybook story, baseline screenshot from a prior run, or a known-good production URL exists, capture it and present `[golden, current]` to the model with the prompt in `references/visual-rubric.md` Step F. Add a `pairwise_with_golden` field to the block.

If no golden exists, skip — do not invent one.

### 4.7 Console & network

After every navigation: `browser_console_messages level: error`. Any error → record it. Distinguish *new* errors from pre-existing ones by checking if the error reproduces on the main branch route (when feasible) — pre-existing errors should be flagged as such, not silently dropped.

## Step 5 — Generate Proof Report

**Before writing:**

1. Read `verification/ui/observations.md` end-to-end.
2. Confirm every PNG under `verification/ui/` has a JSON block. If any are missing, go back to 4.4. The harness should `grep` for orphan PNGs and refuse to write the report otherwise.
3. **Spec coverage check.** Build a coverage table: every REQ-N / EDGE-N in the spec → which scenario covered it → evidence file. Any row without evidence is a gap; either run the missing scenario or list it as "NOT VERIFIED" in the report with the reason. Do not silently skip spec items.
4. Every block with `verdict: UNMET` must appear in the "Visual anomalies & UX observations" section. Silently dropping one is a verification failure.

Write `docs/spec/<SPEC_NAME>/verification/proof-report.md` with these sections:

- **Summary table** — scenario ID, type, description, verdict.
- **API evidence** — curl + truncated responses.
- **UI evidence** — screenshot references; one row per (route, viewport).
- **DB evidence** — queries + results.
- **Visual anomalies & UX observations** — for every `UNMET` block: which screenshot, which check failed, the rect math that failed it, whether the second pass surfaced it. If all blocks were `MET` after the second pass, write "Second pass clean across N screenshots; per-block evidence in observations.md." Do not omit this section.
- **Spec coverage table** — REQ/EDGE → evidence path.
- **Infrastructure note** — what was started, when it was cleaned up, what was already running.

## Step 6 — Honest non-verification

Some things in a spec cannot be verified by this skill — touch-hold gestures the MCP can't emulate, real-device sensors, manual visual diffs against last week's build, no-new-deps assertions that require a code-review pass. List them under a "Not executed" subsection of the report with the reason. Do not paper over them with adjacent passing checks.

## Step 7 — Cleanup

Kill background processes you started in Step 2 (`kill %1`, `docker compose down`). Leave processes that were already running. Leave `verification/` artifacts in place — the orchestrator's Commit & PR stage handles them.

## References

- `references/visual-rubric.md` — the atomic JSON verdict schema, the inventory query, the pairwise prompt, the squint test, the per-failure-mode definitions. Read this before writing any block in `observations.md`.

## Token efficiency

- Curl responses ≤50 lines (`head -50`).
- Prefer screenshots over HTML dumps — a PNG is smaller than the DOM in conversation.
- Report scenarios as a one-line-per-row table.
- Don't re-read spec/plan/phase files already loaded by the orchestrator.
- One browser session for all UI scenarios; `browser_close` only at the end.
- Snapshot before screenshot when locating elements (a11y tree < PNG round-trip).
- DB queries use `--csv` or `-t` for compact output.

## Anti-patterns

- Filling out every field of the rubric without running the underlying queries. The harness checks that cited evidence files exist on disk.
- Picking which component instance to grade. The skill picks for you (index 0 and ⌊N/2⌋).
- Skipping the second pass because the first pass "felt thorough."
- Naming an alignment line that you didn't get from `getBoundingClientRect()`. The model is allowed to invent plausible-sounding lines; the rubric isn't.
- Treating intentional `truncate` / `line-clamp` as automatically `MET`. If the truncated content is the headline of a primary card, that is a UX finding even if the CSS is doing what was asked.
- Counting "no horizontal scroll" as proof of correct layout. Reflow passes can coexist with arbitrary alignment defects.
