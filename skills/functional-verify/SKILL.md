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

This skill exists because vision LLMs are good at running browsers and bad at honestly grading what they see. The defense is simple: every claim — spec or open-review — must cite evidence a reviewer can re-run (a rect, a quoted string, a computed style, a network response). Bare adjectives like "looks fine" or "feels off" are not evidence.

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

Inline previews returned by `browser_take_screenshot` do NOT count as analysis — `Read` each PNG file path before grading it.

### 4.3 Per-screenshot observations

For every PNG under `verification/ui/`, append an entry to `observations.md` covering two tracks:

1. **Spec-based checks** — for each requirement/acceptance criterion that this screenshot is meant to evidence, state the requirement and the verdict (`MET` / `UNMET` / `CANNOT_ASSESS`) with concrete evidence (rect, text, computed style, network response — not adjectives).
2. **Open visual review (always required)** — describe what you actually see and flag anything that looks wrong, even if the spec doesn't mention it: alignment, spacing, hierarchy, contrast, clipping, overlap, hidden CTAs, broken states, copy/typography issues, inconsistent components, weird empty states, etc. This runs on every screenshot regardless of how the spec checks turned out — passing spec checks do **not** let you skip it. If nothing looks wrong, say so explicitly ("no visual issues found") rather than leaving the section blank.

Ground claims in evidence the reviewer can re-run — a rect from `getBoundingClientRect()`, a quoted string, a computed-style value, a console message, a network response. Adjectives without referents ("looks polished", "feels off") are not evidence. When you need to refer to a specific element, run a quick `browser_evaluate` to get its rect or text rather than describing it loosely.

The block-level verdict is `UNMET` if any spec check is `UNMET` or any open-review finding is a real defect (not a stylistic nit you'd dismiss in review). List every `UNMET` finding in `blocking_findings` so Step 5 picks them up.

### 4.4 Adversarial second pass (mandatory when 4.3 surfaces no findings)

The open visual review in 4.3 is non-skippable — it must run for every screenshot, even when all spec checks pass. If a route's first pass surfaced no `UNMET` findings — neither spec nor open review — do not move on. Re-prompt yourself with the screenshots only (verdict hidden) and this seed:

> "The previous reviewer claims this page is fine. Look again — there is likely at least one defect (alignment, grouping, grid, hierarchy, contrast, copy, broken state, or anything else that would make a designer wince). Find it and ground it in a rect, a quoted string, or a computed style. If after looking carefully you genuinely find nothing, report 'second pass clean' and say what you checked."

Reconcile:

- Findings only in pass 2 → re-ground by rect/evidence; if confirmed, escalate the verdict to `UNMET`.
- "Second pass clean" → leave the verdict as-is and note the second-pass attempt in the entry.

This is the single most reliable defense against the "model wrote MET because nothing jumped out" failure mode.

### 4.5 Console & network

After every navigation: `browser_console_messages level: error`. Any error → record it. Distinguish *new* errors from pre-existing ones by checking if the error reproduces on the main branch route (when feasible) — pre-existing errors should be flagged as such, not silently dropped.

## Step 5 — Generate Proof Report

**Before writing:**

1. Read `verification/ui/observations.md` end-to-end.
2. Confirm every PNG under `verification/ui/` has an entry. If any are missing, go back to 4.3.
3. **Spec coverage check.** Build a coverage table: every REQ-N / EDGE-N in the spec → which scenario covered it → evidence file. Any row without evidence is a gap; either run the missing scenario or list it as "NOT VERIFIED" in the report with the reason. Do not silently skip spec items.
4. Every `UNMET` finding — spec-based or open-review — must appear in the "Visual anomalies & UX observations" section. Silently dropping one is a verification failure.

Write `docs/spec/<SPEC_NAME>/verification/proof-report.md` with these sections:

- **Summary table** — scenario ID, type, description, verdict.
- **API evidence** — curl + truncated responses.
- **UI evidence** — screenshot references; one row per (route, viewport).
- **DB evidence** — queries + results.
- **Visual anomalies & UX observations** — for every `UNMET` finding (spec or open-review): which screenshot, what's wrong, the evidence (rect / quoted text / computed style / network response), whether the second pass surfaced it. If everything was clean after the second pass, write "Second pass clean across N screenshots; per-screenshot notes in observations.md." Do not omit this section.
- **Spec coverage table** — REQ/EDGE → evidence path.
- **Infrastructure note** — what was started, when it was cleaned up, what was already running.

## Step 6 — Honest non-verification

Some things in a spec cannot be verified by this skill — touch-hold gestures the MCP can't emulate, real-device sensors, manual visual diffs against last week's build, no-new-deps assertions that require a code-review pass. List them under a "Not executed" subsection of the report with the reason. Do not paper over them with adjacent passing checks.

## Step 7 — Cleanup

Kill background processes you started in Step 2 (`kill %1`, `docker compose down`). Leave processes that were already running. Leave `verification/` artifacts in place — the orchestrator's Commit & PR stage handles them.

## Token efficiency

- Curl responses ≤50 lines (`head -50`).
- Prefer screenshots over HTML dumps — a PNG is smaller than the DOM in conversation.
- Report scenarios as a one-line-per-row table.
- Don't re-read spec/plan/phase files already loaded by the orchestrator.
- One browser session for all UI scenarios; `browser_close` only at the end.
- Snapshot before screenshot when locating elements (a11y tree < PNG round-trip).
- DB queries use `--csv` or `-t` for compact output.

## Anti-patterns

- Skipping the open visual review when all spec checks pass. The spec doesn't enumerate every UX defect; the open review is the only place those get caught.
- Skipping the second pass because the first pass "felt thorough."
- Naming an alignment, size, or position you didn't actually measure. If you need to claim something about a rect, get it from `getBoundingClientRect()`.
- Treating intentional `truncate` / `line-clamp` as automatically fine. If the truncated content is the headline of a primary card, that is a UX finding even if the CSS is doing what was asked.
- Counting "no horizontal scroll" as proof of correct layout. Reflow passes can coexist with arbitrary alignment defects.
- Bare adjectives as evidence — "looks fine", "feels off", "polished". Either ground the claim or mark it `CANNOT_ASSESS` with the reason.
