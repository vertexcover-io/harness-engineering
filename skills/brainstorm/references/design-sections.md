# design.md — Section Contract

Path: `.harness/<name>/design.md`. Read by a human reviewer, by planning, and by `code-review`'s
spec persona. Examples use a neutral domain (user auth) unrelated to the feature being designed.

The design answers **how we will solve it**. The PRD answers what and why; the plan answers what
the code does. Anything already stated by the PRD is cited, never restated — planning reads both
documents, so nothing downstream is starved by the design's silence.

## Sections

| Section | Holds | Never holds |
|---|---|---|
| `## Problem` | one paragraph, plus the PRD path | the remedy; restated stories |
| `## Context` | what exists today and what must change, at reviewer altitude | speculation; `file:line` coordinates |
| `## Approach` | the shape of the solution, prose plus a diagram where shape resists prose | code bodies; step lists |
| `## Decisions` | every fork taken, and what drove it — the document's core | requirement text; rationale essays |
| `## Risks & Assumptions` | what could go wrong; what we are betting on | anything a decision already states |
| `## Open Questions` | unresolved forks, each **blocking** or **deferred** | forks you could resolve now |

Six sections, all of them earned. A section with nothing to say is omitted rather than padded —
`## Open Questions` disappears when every fork is closed rather than saying "none".

## `## Decisions` — the core

A decision states the fork taken, what drove it, and why. Cross-cutting by default: one decision
usually serves several stories, and forcing a decision under each requirement it touches either
misfiles it or duplicates it.

```markdown
| # | Drives | Decision | Why |
|---|---|---|---|
| D1 | PRD S1, S3 | Sessions expire after 24h, refreshed on use | the only window the audit rule allows |
| D4 | PRD S4 | Store the token hashed, in the existing sessions table | matches how credentials are already persisted |
| D7 | grill finding | Revoke on password change as well as on logout | the logout path is the only one covered today, so a reset leaves live tokens behind |
```

- **`Drives`** cites the PRD's own ids, prefixed `PRD` — planning uses bare `S<n>` for test
  scenarios, so an unprefixed id is ambiguous across the two documents. A decision answering
  something the PRD never raised reads `grill finding`, the column where the grill's value becomes
  visible.
- **Name the mechanism.** A decision states what was chosen concretely enough to build and to
  argue with: the service, the field, the flag, the value. *"Handle it the way the existing job
  does"* names nothing a reviewer can disagree with; *"store the token hashed in the sessions
  table, 24h expiry"* does. Context's altitude rule — describe a precedent rather than naming it —
  governs Context alone; here, precision is the point.
- **Forks closed on the user's behalf** are marked `— inferred`. They are bets, and the
  highest-value thing a reviewer can correct.
- **Reuse verdicts are decisions.** "Extend the existing pipeline rather than build new, because
  it already pages and buffers" is a fork with a driver; it needs no separate section.
- A reviewer checks coverage by scanning `Drives` for PRD stories that appear nowhere. Name any
  story deliberately left unaddressed in one line under the table, so silence never reads as an
  oversight.

## `## Context` — reviewer altitude

Keep the claims a reviewer could **disagree** with: who owns what, that a mechanism already exists
so this is an extend rather than a build, that a precedent exists for the pattern being copied,
and what is **absent** — absence justifies decisions, so it earns its place.

Drop line numbers, function and symbol names, key names, config values, and exact commands.
Describe a precedent by what it does — *"one job type already deduplicates repeat submissions by
hashing the request"* — not by naming the function.

Close with one pointer to the dossier, which replaces every citation.

## Requirements live in the PRD

The design states no requirements and no edge cases. It cites story ids and moves on.

A grill discovery — behaviour no story covers, surfaced by the questioning — is not an exception:
it enters as a **decision** marked `grill finding`, because what makes it worth recording is the
fork it forced. When such a discovery is load-bearing enough that a test must prove it, say so
precisely enough to be testable; planning turns it into a scenario.

## One fact, one home

A fact can qualify for several sections at once. Write it once, in its highest-precedence home:

    decision (the fork taken)  >  risk (what it costs)  >  open question (unresolved)

Elsewhere reference it by id. A diagram may depict a fact stated in prose — that is depiction, not
duplication.

## Prose economy

- Lead with the decision or outcome, then the reason, then background.
- One idea per sentence.
- Cut hedges: "critically", "deliberately", "explicitly", "genuinely", "actually", "simply".
- Prefer the verb to the nominalization.
- **Resolve in place.** When a later decision supersedes earlier text, rewrite it — no
  strikethrough, no "resolutions" layer. Git holds history.
- Keep file paths, ids, thresholds, and domain terms verbatim. Economy targets connective tissue,
  never precision.

**Three tests, before the doc is declared written:**

**Contradiction test:** could a reader find a contradiction in each section in one pass? A sentence
with more than one parenthetical, or an item specifying two outcomes, fails — split it or defer it.

**Single-home test:** grep the doc for its three most load-bearing facts — whichever the design
turns on, typically a mechanism, a limit, and a failure behaviour. Each restated as prose in a
second section is a finding. The same *word* recurring is fine; the same *claim* is not.

**Cold-reader test:** a reviewer who never saw the dialogue must get, in one read: what is being
built, why, and what was decided. Anything presupposing the conversation fails — an unexplained
domain term, "as discussed", a decision referenced but never stated. The doc is the record; the
chat is not.

**No process exhaust.** No "captured at Phase 3", no `## Next Steps` pointing at the next skill, no
italic provenance lines. The doc reads as value to a human, not an audit log of how it was produced.
