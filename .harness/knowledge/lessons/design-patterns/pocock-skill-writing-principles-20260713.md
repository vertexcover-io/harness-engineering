---
title: "Matt Pocock's skill-writing principles: predictability, the two loads, the hierarchy ladder, leading words, and the six failure modes"
date: 2026-07-13
category: design-patterns
tags: [skill-authoring, prompt-engineering, progressive-disclosure, leading-words, context-load, predictability]
component: skills
severity: design
status: documented
applies_to: ["skills/**/SKILL.md", "skills/**/references/**", ".harness/knowledge/**"]
stage: [plan, code, review]
evidence_count: 1
last_validated: 2026-07-13
related: ["docs/skills-audit-mattpocock.md"]
---

# Matt Pocock's Skill-Writing Principles

## Problem

We author and edit agent skills (23 SKILL.md files + reference docs) with no shared vocabulary for *why* one skill behaves consistently and another drifts. "Make it Pocock-clean" had been an informal lens. The actual principle-set lives in `mattpocock/skills` `writing-great-skills/{SKILL.md,GLOSSARY.md}` — a full domain model, not a style guide. This lesson extracts it so any skill edit can be judged against it.

## Insight

**A skill exists to wrangle determinism out of a stochastic system; the root virtue is Predictability — the agent taking the same _process_ every run, not producing the same _output_.** Every other lever below is judged by whether it serves predictability, not by how clever, complete, or exhaustive the skill reads. (A brainstorming skill should *predictably diverge* — its tokens vary, its behaviour doesn't.)

### The two loads — the single lens for every split/inline/invocation choice

Every skill spends one of two costs; almost every authoring decision is the same trade made in a different place:

- **Context load** — a **model-invoked** skill keeps its `description` in the window *every turn*. It fires autonomously and other skills can reach it, but you pay tokens + attention continuously. Mechanics: omit `disable-model-invocation`; write a model-facing description rich with triggers ("Use when the user wants…, mentions…").
- **Cognitive load** — a **user-invoked** skill (`disable-model-invocation: true`) strips the description. Zero context load, but *you* become the index that must remember it exists. The `description` becomes human-facing: a one-line summary, trigger lists stripped.

Test for keeping a skill model-invoked: *could the model usefully reach for this autonomously?* — **reuse is not the test.** When user-invoked skills multiply past what you can hold in your head, the cure is a **router skill** that names the others and when to reach for each.

### The description does two jobs, and earns harder pruning than the body

State what the skill is, and list the **branches** that should trigger it. Rules: front-load the leading word; **one trigger per branch** (synonyms renaming a single branch are duplication — collapse them); cut identity already stated in the body. Keep it to triggers plus any "when another skill needs…" reach clause.

### The information-hierarchy ladder — rank content by how immediately the agent needs it

1. **In-skill step** — an ordered action in SKILL.md, the primary tier. Each step ends on a **completion criterion**.
2. **In-skill reference** — a definition/rule/fact consulted on demand. Often a legitimately flat peer-set (every rule of a review on one rung) — fine, not a smell.
3. **External reference** — pushed out of SKILL.md into a sibling file, reached by a **context pointer**, loaded only when the pointer fires.

**Progressive disclosure** is the move down that ladder. The **branching test** decides what moves: *inline what every branch needs; push behind a pointer what only some branches reach.* A **context pointer's wording, not its target, decides when and how reliably the agent reaches the material** — a must-have behind a weak pointer is a variance bug; sharpen the wording first, inline only if that fails. **Co-location** is the companion: once a piece sits at its rung, keep its definition, rules, and caveats under one heading so reading one part brings its neighbours.

### Completion criterion — the lever that resists premature completion and sets legwork

The condition telling the agent a unit of work is done. Two properties:
- **Clarity** (can it tell done from not-done?) resists **premature completion**. Needs *steps* to bite.
- **Demand** (how much it requires) sets **legwork** — "every modified model accounted for" forces thorough work where "produce a change list" does not. This axis is *not* step-bound — it can bind a body of flat reference too ("every rule applied"), which is how a step-less skill still carries an exhaustiveness bar.

Strongest criteria are both *checkable* and *exhaustive*.

### Leading words — the signature technique

A **leading word** (Leitwort) is a compact concept already in the model's pretraining that the agent *thinks with* while running the skill: _seam, tracer bullet, red, tight, deep module, vertical slice, fog of war_. Repeated as a token (never as a sentence), it accumulates a distributed definition and anchors a whole region of behaviour in the fewest tokens. It serves predictability twice: in the **body** it anchors execution (same behaviour every time the word appears); in the **description** it anchors invocation (when the same word lives in your prompts/docs/code, the agent links that shared language to the skill and fires it more reliably). Prefer an existing pretrained word — a coined word recruits no priors, so you pay in definition tokens what a real word gives free. Hunt restatements a single word can retire: *"fast, deterministic, low-overhead" → tight*; *"a loop you believe in" → red*.

### The six failure modes — use as an edit checklist

- **Premature completion** — ending a step before it's genuinely done, attention slipping to *being done*. Defence *in order*: sharpen the completion criterion first (cheap, local); only if it's irreducibly fuzzy *and* you observe the rush, hide the post-completion steps by splitting the sequence — and hiding only works across a real context boundary (subagent dispatch / user hand-off), never an inline model-invoked call.
- **Duplication** — the same meaning in more than one place. Costs maintenance + tokens, and inflates a meaning's prominence on the ladder past its real rank. (The accidental inverse of a leading word, which repeats a *token* on purpose, never the meaning.)
- **Sediment** — stale layers that settle because adding feels safe and removing feels risky. The default fate of any skill without a pruning discipline.
- **Sprawl** — simply too long, *even when every line is live and unique*. Cure is the ladder: disclose reference behind pointers, split by branch or sequence.
- **No-op** — a line the model already obeys by default, so you pay load to say nothing. Test: *does it change behaviour versus the default?* Model-relative — settle disputes by running the skill, not by debate. A weak leading word (*be thorough* when the agent already is) is a no-op; the fix is a stronger word (*relentless*), not a different technique.
- **Negation** — steering by prohibition backfires: *don't think of an elephant* names the elephant and makes it *more* available. Prompt the **positive** — state the target so the banned behaviour is never spoken. Keep a prohibition only as a hard guardrail you can't phrase positively, and even then pair it with what to do instead.

### Pruning discipline

Keep each meaning in a **single source of truth**. Check every line for **relevance** (does it still bear on what the skill does?). Then hunt no-ops **sentence by sentence** — when one fails the test, delete the *whole sentence*, don't trim words. Be aggressive.

## Prevention / Reuse

When authoring or editing any skill in this repo, run this checklist:

- **Invocation:** is it model- or user-invoked, and is that the *cheaper* load for how it's actually reached? Description matches (triggers for model-invoked; one-line human summary for user-invoked).
- **Description:** front-loaded leading word, one trigger per branch, no identity that's already in the body.
- **Ladder:** does anything inline belong behind a pointer? Apply the branching test — inline what *every* branch needs; disclose the rest to `references/`. (Our internal exemplar of this done right is `testing/SKILL.md`.)
- **Completion criteria:** each step's exit is *checkable* and, where it matters, *exhaustive*.
- **Leading words:** hunt triads/restatements a single pretrained word can collapse.
- **Six failure modes:** sweep for premature-completion, duplication, sediment, sprawl, no-op, negation. Rewrite negations as positive targets.
- **No-op pass:** sentence by sentence, delete whole sentences that don't change behaviour vs default.

Signal this is recurring: a skill body ≥ 400 lines, or a reviewer saying "make it Pocock-clean" without a shared checklist to point at.

## Related

- `docs/skills-audit-mattpocock.md` — the repo-wide audit + our token-bloat findings (median body 272 lines vs their ~75; the five heavy skills; extract-to-`references/` recommendations)
- Source: `github.com/mattpocock/skills` → `skills/productivity/writing-great-skills/{SKILL.md,GLOSSARY.md}`, `.agents/invocation.md`, `.agents/writing-docs.md`
