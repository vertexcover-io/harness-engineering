# plan.html — the human review surface

Path: `.harness/<name>/plan.html`. One self-contained file, no external requests. Everything
the approval must cover appears in the authored HTML. The agent-facing markdown rides inside
the same file as payload blocks, which the browser does not render — the reviewer never sees
them, so the human layer must stand alone.

## Contents

- [Build from the shell](#build-from-the-shell)
- [The altitude rule](#the-altitude-rule)
- [Section contract](#section-contract)
- [The xref system](#the-xref-system)
- [The comment layer](#the-comment-layer)
- [The payload blocks](#the-payload-blocks)

## Build from the shell

Copy `scripts/plan-shell.html` (resolve the path from this skill's own directory) to
`.harness/<name>/plan.html` at step 1, then fill its `SLOT:` comments as the work produces
them — extraction refuses unfilled slots. Every section is its own slot, so the page the reviewer
watches shows a spinner exactly where the next part will land and finished sections above it.
SKILL.md steps 1 and 7 carry the order. The shell carries the machinery — theme, left nav,
scroll-spy, xref tooltips, drill-downs, diff colouring, verdict filters, the scenario table, the
slot spinners — and it is not edited outside the slots. Regenerating machinery by hand is the
failure mode this shell exists to prevent: wasted tokens and broken JS.

Write for a developer who has read nothing else. A reviewer who has to re-read a sentence to
work out what it means will approve the plan without understanding it, or spend the review
decoding wording instead of judging the work. Both lose the review.

## The altitude rule

Above the fold: what gets built, why, and what each phase unlocks — short sentences, cards,
tables, and the frames themselves. One click down (`<details>`): every step of the work,
contracts, diffs, the full decision table.

Altitude governs **where** detail sits, never how much survives. Above the fold, code appears
never. A drill-down is a full account of its phase: a reader who opens it can name every file
that changes, what each change is, and the rule that makes it non-obvious — the same account
the coder gets.

## Section contract

Each `SLOT:` comment in the shell names its section's parts. Section numbers are fixed per
section, so a section omitted leaves a gap in the numbering and moves nothing. Rules the slots
don't carry:

- **Every block carries an `id`** — cards, tiles, table rows, callouts, frames, element cards,
  phase cards, `.unlock` boxes, drill-down steps.
- **Hero `.links`** — the ticket, PRs and PRD, then one last item recording what produced this
  run: `harness <version> · andromeda <branch@sha> · session <id>`. Plain text, not a link.
  Generate it with `node --experimental-strip-types ../_shared/collect-run-info.ts` and paste the
  line verbatim — the session id is printed in full because a truncated one is a lookup the reader
  has to reconstruct. The script drops any value it cannot read, so a short line is a valid state.
  The hero lands at step 1; its `.chips` (phase, repo, decision and scenario counts) land at
  step 7, when the numbers exist.
- **Banner** (`.callout.warn`) — only when a real known-gap or risk exists. State what is
  unverified, why, and what fixes it. Never pad; no banner is a valid state.
- **Designs** (`#designs`, 01) — every frame from `design/INDEX.md`, open, as a `.gallery` of
  `.frame`: the image, the screen name, what it settles, the file. It lands the moment the
  design scout returns, before any question is asked, so the reviewer sees the screens the
  plan is about to be judged against. No INDEX, no section.
- **Requirements** (03) — one card per acceptance criterion. Cite the PRD's own ids.
- **Design** (04) — the decisions table uses three columns: *What we do · Instead of · Because*.
  Every row gets `id="D<n>"`. Mark inferred decisions *(inferred — confirm)*. The page holds
  the final state only — how a decision was reached lives in `design.md`, never here.
- **Design system** (05) — filled by a project extension that inventories the components a
  design already has; the shell holds the slot and the styles, the extension holds the shape.
  With no such extension, delete the section.
- **Phases** (06) — each phase card carries, in this order: one goal sentence · a `.builds`
  strip of every frame the phase builds to, open · a `.builds-els` line of the element ids it
  covers, when a project extension produced an element inventory · an `.unlock` box ("After
  this lands…") · the drill-down. A reader sees what the phase looks like before reading how it
  is built; a phase with no frame carries neither strip nor line.

  The drill-down is an `ol.impl`, one `<li>` per step of the payload's `## Implementation`,
  transcribed. `step-card.md` carries the parts, their triggers, and which class renders each —
  read it before writing this section. A step's change is a `pre.diff` block under a
  `.snip-lbl.diff` naming the file and range; the engine colours the lines. The shell carries
  the styling, so no plan invents its own.
- **Tests** (07) — the scenario table (`id="matrix"`), the section's whole body, never inside a
  `<details>`. Columns: *Scenarios · Level · Phase*. One row per scenario across the phase
  payloads, in scenario-id order, each **transcribed** from that payload's
  `## Test Scenarios` — `test-scenarios.md` governs the shape and the classes. It is not
  `plan.md`'s `## Test Matrix`, which has one row per requirement; the page shows scenarios.
- **UI features** — the designs ride in the gallery, in each phase's strip, and inside the steps
  that build to them, per `step-card.md`. An API-only feature omits all three without comment.

## The xref system

Every internal id a reader meets must resolve on hover and jump on click. That covers
requirement ids, decision ids, flow/edge-case ids, element ids, and error codes. Mechanics:

1. Fill `X` with every id family the page uses: `"ID": ["one-line tooltip", "target-id-or-empty"]`.
2. Extend `RX` (the engine's `xref-regex` comment marks it) to match this feature's id families. Longest
   alternatives first.
3. An id inside a chip is written as a pre-marked span:
   `<span class="x" data-x="D3">D3</span>`.

An id with no `X` entry renders as plain text — scan the finished page for un-tooltipped ids
before presenting it. Scenario ids are the exception: they name a heading in the phase file,
not a target on the page, so they carry no `X` entry and stay plain.

## The comment layer

The server injects the comment UI into every page it serves; no plan authors it. Comments live
in `<state-dir>/comments.json`, not in plan.html, so rewriting the page during a revision keeps
them.

## The payload blocks

The markdown the coders receive is embedded at the bottom of the page:

```html
<script type="text/markdown" data-file="plan.md"> … </script>
<script type="text/markdown" data-file="phases/phase-1.md"> … </script>
```

- One block per file; paths relative to the spec dir. Content follows `plan-sections.md`.
- **The sync rule:** every number, name, signature, and path shown in the human layer comes
  from a payload block or from the PRD it cites. Sections above `#phases` condense their
  payload; neither layer contradicts or invents. No reader can check this — the payloads are
  invisible on the page — so verify each figure against its block yourself.
- A literal `</script>` inside a payload is written `<\/script>`.
