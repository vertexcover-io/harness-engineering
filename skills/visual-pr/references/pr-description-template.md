# PR description template

Adapted from [HumanLayer visual-pr](https://github.com/humanlayer/skills/tree/main/plugins/visual-pr/skills/visual-pr).

Include relevant ticket, plan, or published artifact links above the sections when available.
Local artifact paths may be named as local paths, but must not be presented as accessible web links.

## Why the change

Exactly one sentence explaining the problem and what becomes possible after this change.

## Special things to note

One to three bullets covering reviewer-relevant migrations, compatibility constraints,
deliberate omissions, or surprising decisions. Use `- None.` when none apply.

## Change outline

Use the smallest combination of visual views that explains the change: behavior, contracts,
data structures, file responsibilities, component relationships, or data flow. Place a short
explanation next to each view. Order them to make the change understandable, and omit irrelevant
views. Prefer before/after diff blocks for an existing structure and a complete block for a new one.

## Validation

Summarize actual checks and functional verification results, including failures, skipped checks,
and known gaps. Distinguish local results from CI. If no evidence is available, say validation
was not provided; never turn a proposed check into a passing result.
