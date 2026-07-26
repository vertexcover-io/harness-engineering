# design.md — Section Contract

The design is written for a human reviewer and consumed by planning, `code-review`'s spec
persona, and `functional-verify`. Path: `.harness/<name>/design.md`.

## Hard floor — always present

| Section | Holds | Never holds |
|---|---|---|
| `## Problem` | what we're solving, concretely | the remedy |
| `## Context` | what exists today; what triggered this; **dossier path** | speculation |
| `## Requirements` | `R#` functional (EARS), `NF#` non-functional with numbers, `EC#` edge cases — **or** a citation to the PRD plus only what the grill added | implementation, architecture |
| `## Chosen Approach` | which, why, what trade-off is accepted | a re-listing of the losers' pros/cons |
| `## Decisions` | every resolved fork, one line each: the choice and its one-clause why — **including the ones you inferred rather than asked** | rationale essays |
| `## Design` | boundaries, contracts, data flow, ownership. Mermaid where shape doesn't survive prose | code bodies |
| `## Verification Intent` | what must be *observable* for this to be done — the test-level split is planning's job | test names, test levels |

## Include when material

The test is *"does this specific design have content this section would surface?"* — never
*"is this a big design?"*. A section padded with placeholder prose is worse than an omitted one.

`## Open Questions` (when any `D<n>` is parked — each entry marked **blocking** or
**deferred**; a design with every fork resolved omits the section rather than writing "none") ·
`## Approaches Considered` (when 2+ were real) · `## Personas & Flows` (user-facing only;
flows are the tester-walkable numbered steps `functional-verify` consumes) ·
`## External Dependencies & Fallback Chain` (whenever an external lib or API is named —
`library-probe`'s input contract) · `## Reuse & Abstraction` (what we extend, what we leave,
and why) · `## Risks` · `## Assumptions` (no tautologies, no verified facts) · `## Non-Goals`.

## Requirement IDs — one namespace, forever

`R1`, `NF1`, `EC1` are established here and never re-derived. Planning cites them;
`phases/phase-N.md` scenarios trace to them; `code-review`'s spec persona checks against them;
`functional-verify` routes on the flows. There is no second namespace anywhere in the pipeline.

## EARS — the requirement sentence shape

Every `R#` uses one of five shapes:

- **Ubiquitous:** The system SHALL `<response>`.
- **Event-driven:** WHEN `<trigger>`, the system SHALL `<response>`.
- **State-driven:** WHILE `<state>`, the system SHALL `<response>`.
- **Unwanted behavior:** IF `<condition>`, THEN the system SHALL `<response>`.
- **Optional feature:** WHERE `<feature is present>`, the system SHALL `<response>`.

One sentence of intent plus at most one qualifier. When a requirement would specify two
outcomes, state the intent and send the fork to `## Open Questions`.

**Banned words** inside a requirement — each hides an unmade decision: *fast, quickly, easy,
simple, robust, appropriate, reasonable, efficient, user-friendly, seamless, flexible,
scalable, as needed, etc., and/or*. Replace with a number, a named actor, or a fork.

## Decisions — where the grill becomes reviewable

The written tree ends with every `D<n>` resolved or parked; resolved ones land here, parked
ones in Open Questions. Nothing else records *that a fork existed* — a design stating only
conclusions hides which of them were choices.

The load-bearing case is the **inferred** decision: a fork closed on the user's behalf because
it seemed obvious. Those are bets, and the highest-value thing a reviewer can correct — write
them as decisions marked `— inferred`, never absorb them silently into prose.

## Prose economy — every kept section

- Lead with the decision or outcome, then the reason, then background.
- One idea per sentence.
- Cut hedges: "critically", "deliberately", "explicitly", "genuinely", "actually", "simply".
- Prefer the verb to the nominalization.
- **Resolve in place.** When a later decision supersedes earlier text, rewrite it — no
  strikethrough, no "resolutions" layer. Git holds history.
- Keep file paths, IDs, thresholds, and domain terms verbatim. Economy targets connective
  tissue, never precision.

**Two named tests, before the doc is declared written:**

**Contradiction test:** could a reader find a contradiction in each section in one pass? A
sentence with more than one parenthetical, or an item specifying two outcomes, fails — split
it or defer it.

**Cold-reader test:** a reviewer who never saw the dialogue must get, in one read: what is
being built, why, and what was decided. Anything that presupposes the conversation fails — an
unexplained domain term, "as discussed", a decision referenced but never stated. The doc is
the record; the chat is not. The hard-floor order is the reading order: Problem before remedy,
Context before Requirements — a doc a cold reader must read twice fails this test.

**No process exhaust.** No "captured at Phase 3", no `## Next Steps` pointing at the next
skill, no italic provenance lines. The doc reads as value to a human, not as an audit log of
how it was produced.
