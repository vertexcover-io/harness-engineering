# plan.html — the human review surface

Path: `.harness/<name>/plan.html`. One self-contained file, no external requests. Everything
the approval must cover appears in the authored HTML. The agent-facing markdown rides inside
the same file as payload blocks, which the browser does not render — the reviewer never sees
them, so the human layer must stand alone.

## Build from the shell

Copy `scripts/plan-shell.html` (resolve the path from this skill's own directory) to
`.harness/<name>/plan.html`, then fill its `SLOT:` comments — extraction refuses
unfilled slots. Fill incrementally, one save per section (order in SKILL.md step 7): the
live server reloads the user's tab on every save, and any `SLOT:` comment still in the body
renders as a spinner, so a half-built page reads as "in progress", never as broken. The
shell carries the machinery —
theme, left nav, scroll-spy, xref tooltips, drill-downs, case-list builder, the slot
spinners — and it is not
edited outside the slots. Regenerating machinery by hand is the failure mode this shell exists
to prevent: wasted tokens and broken JS.

Write for a developer who has read nothing else.

## The altitude rule

Above the fold: what gets built, why, and what each phase unlocks — short sentences, cards,
tables. One click down (`<details>`): contracts, all test cases, code snippets, the full
decision table. Code appears above the fold **never**; inside a drill-down, at most two short
snippets per phase, each showing a subtle point — not a change list.

## Section contract

The shell's `SLOT:content` comment lists the section order. Rules the slots don't carry:

- **Banner** (`.callout.warn`) — only when a real known-gap or risk exists. State what is
  unverified, why, and what fixes it. Never pad; no banner is a valid state.
- **Requirements** — one card per acceptance criterion, `id` on each so xrefs can jump to it.
  Cite the PRD's own ids.
- **Design** — the decisions table uses three columns: *What we do · Instead of · Because*.
  Every row gets `id="D<n>"`. Mark inferred decisions *(inferred — confirm)*. The page holds
  the final state only — how a decision was reached lives in `design.md`, never here.
- **Phases** — each phase card carries: one goal sentence · an `.unlock` box ("After this
  lands…") · a drill-down with a *File / Job / The rule to know* table · a `.tests-line` of
  xref spans naming the groups/cases that prove it.
- **Tests** — one card per level (Unit / Integration / E2E / QA Agent) carrying its count.
  The all-cases drill-down (`id="all-cases"`, body `id="case-groups"`) is generated from
  `CASES`; group `CASES` by those same levels, every case one line.
- **UI features** — when the feature has a user-facing surface, the phase card embeds the
  mockup/screenshot inline (data: URI) or links the Figma/app URL. An API-only feature omits
  this without comment.

## The xref system

Every internal id a reader meets must resolve on hover and jump on click. That covers
requirement ids, decision ids, flow/edge-case ids, error codes, and test cases. Mechanics:

1. Fill `X` with every id family the page uses: `"ID": ["one-line tooltip", "target-id-or-empty"]`.
2. Fill `CASES` with every test case; the engine registers those ids itself.
3. Extend `RX` (the `SLOT:xref-regex`) to match this feature's id families. Longest
   alternatives first; test-case patterns before bare letter+digit patterns.
4. Ids referenced in chips or `.tests-line` are written as pre-marked spans:
   `<span class="x" data-x="TCG-A">Group A (5)</span>`.

An id with no `X` entry renders as plain text — scan the finished page for un-tooltipped ids
before presenting it.

## The bespoke widget — one, optional

When the feature has a mechanism a reader understands faster by poking it — a retry-outcome
table, a state machine, a routing rule — build **one** small interactive widget in the
`SLOT:widget` area, using the `.explorer` frame. Give it a one-line setup box stating the
scenario in plain words. Skip the widget when no such mechanism exists; a decorative widget
is noise. This is the one place free-form JS is welcome — keep it under ~40 lines.

## The payload blocks

The markdown the coders receive is embedded at the bottom of the page:

```html
<script type="text/markdown" data-file="plan.md"> … </script>
<script type="text/markdown" data-file="phases/phase-1.md"> … </script>
```

- One block per file; paths relative to the spec dir. Content follows `plan-sections.md`.
- **The sync rule:** every number, name, signature, and path shown in the human layer comes
  from a payload block or from the PRD it cites. The human layer may summarize; it may never
  contradict or invent. No reader can check this — the payloads are invisible on the page — so
  the two layers drift unless you verify each figure against its block yourself.
- A literal `</script>` inside a payload is written `<\/script>`.
