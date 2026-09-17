---
name: adr
description: >
  Write one Architecture Decision Record: draft it in the fixed format, have a fresh-context
  review agent check it, then write it to docs/adr/ and add it to docs/adr/INDEX.md. Use when
  a decision passes the four gates — hard to reverse, surprising without context, a real
  trade-off, relevant to future work. Planning calls it for each qualifying decision; it can
  also be invoked directly ("record this decision as an ADR").
---

# ADR — record one decision

An ADR is a permanent record of one architectural decision, kept in the **project's** repo at
`docs/adr/`. It tells the next person or agent why the code is the way it is, so they do not
undo it by accident.

## Input

| Input | Required | What it is |
|---|---|---|
| Decision | yes | what was chosen, in one sentence |
| Reason | yes | why — from the ticket, the PRD, or the conversation |
| Alternatives | no | the options that were rejected |
| Source | no | the ticket id or document path the decision came from |
| Related ADRs | no | paths of existing ADRs the caller already found relevant |

A reason that only restates the decision ("move to pgvector because we want pgvector") is not a
reason. Stop and return `dropped: no reason given` — the caller asks for one.

The decision must be one the task in `Source` required. A decision that came up while doing the
work but that the task never called for — a test runner chosen while building a component, a lint
rule added while fixing a bug — is out of scope: return `dropped: out of scope` so the caller can
raise it separately.

## The four gates — all must hold

**A gate you have to argue for is a fail.**

1. **Hard to reverse**: undoing this later means changing several files, migrating data, or
   coordinating with other teams. If the undo is the same size as the change — one line back to
   one line — this fails.
2. **Surprising without context**: a future reader will look at the code and wonder "why did
   they do it this way?", and a comment at the code site or a line in the PR would not settle it.
3. **A real trade-off**: two people with the same facts could have landed on different answers.
   Every option on the table is a good solution with its own pros and cons. If one option is
   simply the right one, the choice was forced, and a forced choice is not a trade-off.
4. **Relevant to future work**: the next person or agent who has to make a code change would
   make a different choice if they knew about it.

## What qualifies

- **Architectural shape.** "The write model is event-sourced; the read model is projected into
  Postgres."
- **Integration patterns.** "Ordering and Billing communicate via domain events, not HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider — not every
  library, only the ones that would take a quarter to swap.
- **Boundary and scope decisions.** The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** These stop the next engineer from "fixing"
  something that was deliberate.
- **Constraints not visible in the code.** Compliance, partner contracts, latency budgets.
- **Non-obvious rejections.** Considered GraphQL, picked REST — record it, or someone suggests
  GraphQL again in six months.

## Format

File: `docs/adr/NNNN-slug.md` — four digits, the highest existing number plus one; the slug
comes from the title.

```markdown
---
status: {active | inactive}
date: {YYYY-MM-DD, the day the decision was approved}
source: {optional — ticket id or document path}
tags: [{the parts of the system this decision applies to — components (e.g. session-search, billing-service) and connectors between them (e.g. cli-to-api, orders-billing-events)}]
---

# {Short title stating the decision, not the topic}

## Context and Problem Statement

{1-3 lines: Describes the context and problem statement.}

## Considered Options

{Optional — This section lists the alternatives (or choices, options, candidate solutions) investigated:

<title/name of option 1>
…
The template recommends listing the chosen option first (as a project-wide convention). One needs to make sure to list options that can solve the given problem in the given context (as documented in Section “Context and Problem Statement”). They should do so on the same level of abstraction. A mistake we have seen in practice is that a technology is compared with a product, or an architectural style with a protocol specification and its implementations. Pseudo-alternatives sometimes can be found too, but do not help.}

## Decision Outcome

{Here, the chosen option is identified and called out explicitly, by its option name (title).

A justification should be given as well: <name of option 1> because <justification>. Some examples of justifications are: it is the only option that meets a certain k.o. criterion/decision driver; it resolves a particularly important force well; it comes out best when comparing options }

## Consequences

{At most 2 lines: This section discusses how problem and solution space look like after the decision is made}
```

### INDEX.md

`docs/adr/INDEX.md`, one line per ADR, inactive ones included:

```markdown
# Architecture Decision Records

- [{NNNN} {title}]({NNNN-slug}.md) · {status} · {date} · {tags} · {one line on what the ADR requires}
```

**Tags come from the index.** Before tagging, read the tags already used in INDEX.md and reuse
one whenever it names the same part of the system. Add a new tag only when none fits.

## Steps

1. **Read what exists.** Open `docs/adr/INDEX.md` when present, and every related ADR the caller
   passed. Open any other active ADR whose index line touches the same decision.
2. **Draft** the ADR in the format above. Do not write it to disk yet.
3. **Dispatch the review agent** with the brief below, on a fast model (`sonnet`).
4. **Apply the verdict:**
   - `keep` — go to step 5.
   - `rewrite: <what>` — fix the draft once, then go to step 5. No second review.
   - `covered by <NNNN>` — write nothing. Return `covered by: docs/adr/<file>`.
   - `drop: <reason>` — write nothing. Return `dropped: <reason>`.
5. **Write** `docs/adr/NNNN-slug.md`. Create `docs/adr/` when it does not exist.
6. **Mark contradicted ADRs inactive.** For each active ADR the new one contradicts, set its
   `status: inactive` and update its INDEX.md line. Never delete an old ADR or rewrite its body.
7. **Update INDEX.md** — add the new line; create the file with its heading when it does not
   exist.
8. **Return** `written: docs/adr/<file>`, plus any ADRs marked inactive.

## Review agent brief

The review agent reads the draft as a future reader would. Give it the draft, `docs/adr/INDEX.md`,
the related ADRs, the source path, and this skill's Gates and Format sections — never the
session history.

It checks:

1. **Gates** — all four hold.
2. **In scope** — the decision is one the task named in `source` required. A decision the task did
   not call for fails here, however well it passes the gates.
3. **Covered** — no active ADR already records this decision.
4. **Restated request** — Decision Outcome gives a reason beyond the request itself.
5. **Conflict** — every active ADR the draft contradicts is named for marking inactive.
6. **Tags** — each tag names a component or connector, and none duplicates an existing tag
   under a different spelling (`db` vs `database`).
7. **Format** — front matter has `status`, `date` and `tags` · the title states the decision · Context
   and Problem Statement is 1–3 lines · Decision Outcome has a `because` · Consequences is at
   most 2 lines and every rule in the format section is followed.

It returns one verdict: `keep` · `rewrite: <what>` · `covered by <NNNN>` · `drop: <reason>`.
