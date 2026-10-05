# design.md — format

Path: `.yok/RUN/artifacts/design.md`. The first gate: a person reads it in under a minute
and says whether the shape is right, before anyone builds a full plan. The planning stage
builds from it, so it must stand without the conversation that produced it.

## What belongs

One test decides every line: **if this answer changed, would the plan look different?** Passes:
a new component, library or service; a changed boundary or contract; stored data added or
altered; a choice that is hard to undo. Fails, and waits for the plan: field names, function
names, file lists, step order, test plans, edge cases, options nobody weighed.

Cite `file:line` for a claim about the code as it is today. Never list the files to change.

Say each thing once. A fact that appears in two sections is cut from one.

## Caps

Hard caps. Count before showing the doc; over a cap, something belongs to planning.

| Thing | Cap |
|---|---|
| Body words, front matter and mermaid excluded | 500 |
| Diagrams | 1 |
| `What changes` rows | 6 |
| `Decisions` rows | 3 |
| `Risks` bullets | 3 |

```bash
sed '/^---$/,/^---$/d; /^```/,/^```/d' design.md | wc -w
```

## Template

Write it in this order. `Problem`, `Approach` and `Hard to undo` are always present. Every
other section appears only when it holds something that passes the test; otherwise drop it,
header included, never "None". A one-line fix gets a 60-word doc; a new subsystem gets the page.

````markdown
---
status: draft            # approved once the user confirms
task: One line naming what is being designed
---

# TITLE

## Problem
Why this exists, who has the problem, and the outcome they want. Two sentences.

## Scope
- **In:** …
- **Out:** …

## Approach
The one idea, in five sentences or fewer: what gets built, where it sits, what it reuses.

**Rejected:** one line per whole approach the user turned down, with the reason.

## Design
```mermaid
flowchart LR
  …
```

## What changes
| Area | Added / changed / none | One phrase why |
|---|---|---|
| Stored data | | |
| API or contract | | |
| New dependency | | |
| New component or service | | |
| Config | | |
| User surface | | |

## Decisions
| # | What we do | Instead of | Because |
|---|---|---|---|
| D1 | … | … | … |
| D2 | … — *inferred* | … | … |

## Risks
- What the task did not say that changes the design, and what it costs.

## Hard to undo
One line: what this locks in (a table, a public contract, a dependency), or "nothing".

## Unsure
- What you could not settle about the task itself, and what you assumed.

## Open questions
D3: … — blocked-by: D1 · open

## Deferred
- …
````

## Section rules

- **Scope**: `Out` is what stops the plan from growing. Two or three lines each.
- **Rejected**: only approaches the user was shown in step 4 and turned down, or an obvious
  path a reader would ask "why not?" about. An alternative to one decision goes in that
  decision's `Instead of` cell, not here.
- **Design**: one diagram, only when it shows what a paragraph would hide; a small change has
  none. `flowchart LR` for what talks to what, `sequenceDiagram` for order, `stateDiagram-v2`
  for states, `erDiagram` for records. Name boxes as the code does. Show only new or changed
  parts plus what they touch, about 10 nodes, new parts marked
  `classDef new fill:#e6f4ea,stroke:#1e8e3e` and `class NodeId new`. Quote labels holding
  punctuation: `A["POST /runs (retry)"]`.
- **What changes**: keep the `added` and `changed` rows, plus `Stored data` even when `none`.
  No field names, no paths. Point at a decision or at `Hard to undo` instead of restating it.
- **Decisions**: one row per fork that changes the shape; a fork that changes only code is
  planning's. Name the mechanism: the service, the key, the value. Mark forks closed on the
  user's behalf `inferred`. Cite the ticket or a `file:line` in `Because` where one drives it.
- **Risks**: gaps in the task that bite, not a checklist. Each says what it costs if ignored.
- **Hard to undo**: a changed contract every caller sees, a new table, a new runtime dependency.
- **Unsure**: the agent's own gaps in reading the task, not risks in the system.
- **Open questions**: working state, removed at approval.
- No component table, contract sketches, failure tables, phases or test plans. Those belong to
  planning.
