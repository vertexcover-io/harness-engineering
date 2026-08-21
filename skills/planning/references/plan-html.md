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
theme, left nav, scroll-spy, xref tooltips, drill-downs, the scenario table, the slot
spinners — and it is not
edited outside the slots. Regenerating machinery by hand is the failure mode this shell exists
to prevent: wasted tokens and broken JS.

Write for a developer who has read nothing else. A reviewer who has to re-read a sentence to
work out what it means will approve the plan without understanding it, or spend the review
decoding wording instead of judging the work. Both lose the review.

## The altitude rule

Above the fold: what gets built, why, and what each phase unlocks — short sentences, cards,
tables. One click down (`<details>`): every step of the work, contracts, code, the full
decision table.

Altitude governs **where** detail sits, never how much survives. Above the fold, code appears
never. A drill-down is a full account of its phase: a reader who opens it can name every file
that changes, what each change is, and the rule that makes it non-obvious — the same account
the coder gets.

## Section contract

The shell's `SLOT:content` comment lists the section order. Rules the slots don't carry:

- **Hero `.links`** — the ticket, PRs and PRD, then one last item recording what produced this
  run: `harness <version> · andromeda <branch@sha> · session <id>`. Plain text, not a link.
  Generate it with `node --experimental-strip-types ../_shared/collect-run-info.ts` and paste the
  line verbatim — the session id is printed in full because a truncated one is a lookup the reader
  has to reconstruct. The script drops any value it cannot read, so a short line is a valid state.
- **Banner** (`.callout.warn`) — only when a real known-gap or risk exists. State what is
  unverified, why, and what fixes it. Never pad; no banner is a valid state.
- **Requirements** — one card per acceptance criterion, `id` on each so xrefs can jump to it.
  Cite the PRD's own ids.
- **Design** — the decisions table uses three columns: *What we do · Instead of · Because*.
  Every row gets `id="D<n>"`. Mark inferred decisions *(inferred — confirm)*. The page holds
  the final state only — how a decision was reached lives in `design.md`, never here.
- **Phases** — each phase card carries: one goal sentence · an `.unlock` box ("After this
  lands…") · a drill-down.

  The drill-down is an `ol.impl`, one `<li>` per step of the payload's `## Implementation`,
  transcribed. `step-card.md` carries the parts, their triggers, and which class renders each —
  read it before writing this section. The shell carries the styling, so no plan invents its
  own.
- **Tests** — one table (`id="matrix"`), the section's whole body, never inside a
  `<details>`. Columns: *Scenarios · Level · Phase*. One row per scenario across the phase
  payloads, in scenario-id order, each **transcribed** from that payload's
  `## Test Scenarios` — `test-scenarios.md` governs the shape and the classes.
- **UI features** — the designs ride inside the steps that build to them, per `step-card.md`.
  An API-only feature omits them without comment.

## The xref system

Every internal id a reader meets must resolve on hover and jump on click. That covers
requirement ids, decision ids, flow/edge-case ids, and error codes. Mechanics:

1. Fill `X` with every id family the page uses: `"ID": ["one-line tooltip", "target-id-or-empty"]`.
2. Extend `RX` (the `SLOT:xref-regex`) to match this feature's id families. Longest
   alternatives first.
3. An id inside a chip is written as a pre-marked span:
   `<span class="x" data-x="D3">D3</span>`.

An id with no `X` entry renders as plain text — scan the finished page for un-tooltipped ids
before presenting it. Scenario ids are the exception: they name a heading in the phase file,
not a target on the page, so they carry no `X` entry and stay plain.

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
