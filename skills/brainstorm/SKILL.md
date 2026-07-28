---
name: brainstorm
description: >
  Grill an idea into an approved design.md. Use for structural change — a new boundary or
  component, an unresolved fork with live alternatives, a user-facing surface with unstated
  behavior, or an external dependency. Also use when the user hands over an existing design or
  plan to interrogate ("grill this", "poke holes"). Work with nothing to decide skips this
  skill entirely — route it to `planning`. Invoked standalone or as orchestrate's first stage.
---

# Brainstorm — grill the idea into a design

The **grill** closes the decision tree: every decision the design turns on is resolved or
consciously **parked**, including the ones the user did not think of. Output is
`.harness/<name>/design.md`, grounded in a **dossier** of verbatim code quotes. `<name>`
comes from the pipeline (`SPEC_NAME`) when orchestrate invokes; standalone, derive a short
kebab-case name from the topic **before dispatching scouts** — they write into the same
directory.

A user arriving with an existing design or plan is the same job — the tree just starts partly
populated: extract its decisions as `D<n>` entries, mark what's already resolved, and grill
the rest.

## Triage — run before anything else

Brainstorm is for **structural** change. Run it when **any** holds:

- an unresolved **fork** — a decision with live alternatives
- a new boundary, component, or contract
- a user-facing surface with unstated behavior
- a non-functional target nobody has named
- an external dependency

**Skip to `planning`** when **all** hold: the change stays inside existing code paths · one
obvious way to do it · acceptance criterion already stated · no new interface.

The skip target is `planning`, never `implement` — "nothing to decide" is not "nothing to
plan". A rename across 30 files skips the grill and still needs a slice graph. Only planning's
own gate can route to `implement`.

The stress test that keeps the gate from being talked past:

> *"Add caching to this endpoint"* — sounds mechanical, but TTL, invalidation, key shape, and
> backing store are four forks. **Grill it.**
> *"Rename `getUserData` to `fetchUser` across the repo"* — no fork, no boundary, criterion
> obvious. **Straight to planning.**

**When the call is genuinely close, grill** — the costs are asymmetric: a short design on
small work is mild ceremony; a skipped design that was warranted builds the wrong thing. Let
the design be three paragraphs.

**Scope check, before the first question:** if the request spans multiple independently-
shippable subsystems, decompose and grill the first one. Don't split when the pieces share
>30% of files and ship together.

## Inputs — cite, never restate

When a PRD, issue, or brief already states something, **cite it and move on**
(`<path>#<section>`). The design holds only what the grill *added*: forks resolved, gaps
found, structure chosen. A design that restates its PRD has added nothing and costs the next
reader two reads of the same content.

## Scouts — dispatch first, never wait

Dispatch both sub-agents **before the first question** — they run during the user's
think-time. **Read `references/scouts.md` for the briefs before dispatching.** Without the
brief's four questions and the intent-withholding rule, the scout returns interpretation
instead of evidence — and evidence is the only thing the grill can ground on.

- **Codebase scout** — always. Writes `.harness/<name>/dossier.md`; returns a 3-5 line gist.
- **External scout** — only on thin local patterns; evaluate the trigger yourself with a
  fast pattern scan (`rg` for the pattern this design needs) before dispatching. Returns
  findings inline as quotes with source URLs — no file; cite the URLs in the sections they
  shape.

The conversation carries only the gist. When the grill needs a specific, read the dossier on
demand — the quotes are already verified.

**Verify before claiming absence:** any claim that something is *absent* — no such table, no
such endpoint — is checked against the code before it is stated, or labeled an unverified
assumption. Absence claims are where confident agents are most often wrong.

## The grill

Ask via `AskUserQuestion` wherever the surface provides it; on surfaces that don't (Codex —
see `references/codex-tools.md` at the repo root), ask in plain text preserving the same
shape. Every menu question carries a recommendation and its one-clause why, recommended
option first, labeled `(Recommended)`; an open-ended question has no options to order — state
the recommendation in its framing when one is meaningful. **Batch up to 4 questions when they
are unrelated** — dependence, not count, is the limit: any question whose answer could
reshape another is asked **alone**, in its own turn.

**Open vs. menu:** use an open-ended question only when you cannot write 3-4 genuinely
distinct, plausibly-correct options without padding. Straining to fill the option slots means
ask it open.

### The written tree

An explicit written list, not a mental model:

```
D<n>: <the decision> — blocks: D<a>, D<b> · blocked-by: D<c> · [open|resolved|parked]
```

Resolve top-down: the decision unblocking the most downstream ones first, never one whose best
form depends on an unanswered upstream. A decision you were forced to write down cannot be
silently forgotten.

### Question sources

Walk the lens catalog — **read `../_shared/lenses.md` before the first lens pass**; without it,
completeness is recalled instead of derived, and the gap the user didn't mention stays
unfound. Each lens states when it fires and what to ask.

### The integration check

Before exiting, combine what the user has said and surface consequences the dialogue never
probed. If stated-X plus stated-Y plus your-default-Z produces a downstream effect the user is
unlikely to have tracked one question at a time, probe it **now**. Open Questions is a safety
net for genuine residuals, not a punt list for consequences you could have asked about.

### Exit condition — checkable, not stamina

- [ ] the actor is identified or marked unknown
- [ ] the desired outcome is stated
- [ ] the in-scope/out-of-scope boundaries that matter are known
- [ ] success criteria or acceptance signals are known, or recorded as assumptions
- [ ] every lens that fired has been probed or parked
- [ ] no integration-check question is pending
- [ ] every `D<n>` is resolved or parked

## Visual companion — for genuinely visual questions

When a question is faster judged by seeing — layouts, wireframes, architecture diagrams,
state machines — offer a browser companion that renders mockups and captures clicks. **Read
`references/visual-companion.md` before the first offer**; offering it wrong (upfront, or for
conceptual questions) turns a tool into a nuisance. The gate in brief:

1. **Offer just-in-time, never upfront**, as its own message, naming the token cost. No visual
   question ever arises → never offer. An ASCII preview inside `AskUserQuestion` options does
   **not** satisfy the offer — the offer is its own prior question.
2. **Per-question, even after acceptance.** A question *about* a UI topic is not automatically
   visual: "what kind of wizard?" is conceptual — terminal; "which of these wizard layouts?"
   is visual — browser.
3. **Unload explicitly.** When the conversation returns to the terminal, push a waiting screen
   so the user isn't staring at a resolved choice.

## Approaches

**2-3 approaches, only when real alternatives exist.** One viable option → two lines of "why
not X, Y" and move on.

- **Granularity is mechanism, not architecture.** Name product-shape distinctions ("pause as a
  rule property" vs "pause as its own entity"), never table names, file paths, or class names —
  those force architectural decisions on brainstorm-depth research.
- **Present all, then recommend.** Leading with the recommendation anchors the user before
  they've seen the alternatives.
- **Anti-genericness.** An approach that would appear in a generic listicle for this problem
  category is sharpened against the dossier or dropped.

Frame each approach as **reuse / extend / build new**. Optionally add one deliberately
higher-upside **challenger** alongside the baseline.

**Stress pass** on the chosen approach: walk `../_shared/lenses.md` again as *review* rather
than generation — the catalog states where findings land.

**YAGNI, last.** Every knob, flag, and option answers: needed now, or hardcode and add when
the need is real? Hardcode by default. A knob survives only when the right value is genuinely
empirical — then defer the value, not the knob.

## Write design.md

**Read `references/design-sections.md` before writing the doc.** Without the section contract
loaded, the design drifts into restating its PRD, burying decisions in prose, and writing one
fact into four sections — the failures the contract exists to prevent.

Two rules worth carrying here because they are the easiest to skip. Forks you closed on the
user's behalf are marked `— inferred` — they are bets, and the highest-value thing a reviewer can
correct. And the design **cites the PRD rather than restating it**: decisions name the story ids
they drive, and a fact stated once is referenced by id everywhere else.

## Self-review — two passes, different in kind

**Pass 1 — fresh-context claim verifier. Always runs — `--auto` included.** It receives the
design's factual claims and the dossier path — never the session history. Budget ~15 targeted
reads; per claim: **confirmed** (`file:line`) · **refuted** · **unverifiable**. The author
confirming its own claims is anchored; the verifier never saw the dialogue.

Interactively, dispatch it at the same moment the approval question goes up (it runs during
the user's think-time) and **fold the verdict in before hand-off** — a refutation arriving
after approval re-opens the gate with the correction. In `--auto`, run it to completion and
correct refuted claims before proceeding to planning.

**Pass 2 — re-read as the reader.** One inline act: coverage (every PRD story either driving a
decision or named as unaddressed) · placeholders · contradiction-in-one-pass · ambiguity ("could
any decision be read two ways? pick one and make it explicit"). Fix inline; no re-review loop.

**Calibration for both:** flag only what would cause a real problem downstream — a missing
section, a contradiction, a decision someone could build wrong. Wording preferences are not
findings.

## Approval gate

One pause: present the design path, noting the verifier is running; its verdict folds in
before hand-off. The pause — not the verifier — is bypassed by `--auto` or an explicit "skip
review". On approval (and a clean or corrected verdict) → `planning`.

**A revision is not a confirmation.** After any change the user asks for — however simple —
integrate it, re-present what changed, and wait for explicit approval.

**Soft-cut on circularity, not iteration count.** Revising *different* aspects across rounds
is the gate working. When the **same decision** is revised a second time, stop and ask
directly: the decision is unresolved, not the wording. Identity is by decision, not by
section; a merged item inherits its parents' revision history.

## Rationalizations

| Excuse | Reality |
|---|---|
| "The user seems impatient" | A wrong design costs more than three more questions. Ask the highest-leverage one. |
| "I can infer this from the code" | Then infer it, state it as a recommendation, and confirm — don't skip the question. |
| "This is an implementation detail" | If it changes what gets built, it is a fork. If it doesn't, it isn't a question. |
| "The PRD covers it" | Then cite the section. Can't point at it → it isn't covered. |
| "The list feels thorough" | The exit condition is the checklist above, not a feeling. |
| "I'll note it as an open question" | Open Questions is for genuine residuals, not for a decision you could resolve now. |
