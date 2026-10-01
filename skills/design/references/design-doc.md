# design.md — format

Path: `.harness/RUN/artifacts/design.md`. A person approves it and the planning stage builds
from it, so it must be complete without the conversation that produced it.

## Contents

- [Template](#template)
- [Diagrams](#diagrams)
- [Section rules](#section-rules)

## Template

Write it in this order. Omit a section that would be empty; never pad with "None".

````markdown
---
status: draft            # approved once the user confirms
task: One line naming what is being designed
---

# TITLE

## Problem
Why this exists, who has the problem, and the outcome they want. Two to four sentences.

## Scope
- **In:** …
- **Out:** …

## Success criteria
- How the user will judge that it works, one per line.

## Approach
The chosen approach in six sentences or fewer: what gets built, where it sits, what it reuses.

**Rejected:** one line per approach not taken, with the reason.

## Design

### Context
```mermaid
flowchart LR
  …
```

### Components
| Component | New / changed / reused | Does | Depends on | Where |
|---|---|---|---|---|

### Main flow
```mermaid
sequenceDiagram
  …
```

### Data and contracts
The shapes that cross a boundary: payloads, records, events. A typed sketch or a diagram.

### Failure behavior
| When | Then |
|---|---|

## Decisions
| # | What we do | Instead of | Because |
|---|---|---|---|
| D1 | … | … | … |
| D2 | … — *inferred* | … | … |

## Clarifications
- Q: … → A: …

## Risks
- What could go wrong, and what it costs.

## Open questions
D3: … — blocked-by: D1 · open

## Deferred
- …
````

## Diagrams

Pick the diagram by the question it answers. Draw it only when it shows how something works
that a paragraph would hide.

| Question | Mermaid type |
|---|---|
| What talks to what, and what is outside the system? | `flowchart LR` |
| In what order do the parts act on the main path, or a failure path? | `sequenceDiagram` |
| What states can a thing be in, and what moves it between them? | `stateDiagram-v2` |
| How do the records relate? | `erDiagram` |
| Which choice leads where? | `flowchart TD` |

Rules:

- Name boxes after real components, using the names the code uses.
- Show new parts apart from existing ones:
  `classDef new fill:#e6f4ea,stroke:#1e8e3e` and `class NodeId new`.
- Keep a diagram to about 12 nodes. Past that, split it by concern.
- Quote any label holding punctuation: `A["POST /runs (retry)"]`. Use `<br>` for a line break,
  never `\n`.
- One diagram, one idea. A context diagram does not also show order; a sequence does not also
  show states.

## Section rules

- **Components**: every row answers what it does, how it is used and what it depends on.
  `Where` is a path for changed or reused parts, and the intended folder for new ones.
- **Decisions**: one row per fork taken. Name the mechanism concretely: the service, the
  field, the value. Mark forks closed on the user's behalf `inferred`. Cite the ticket or a
  `file:line` in `Because` where one drives the fork.
- **Clarifications**: one line per answer, appended as each round lands.
- **Open questions**: empty at approval. Every node is by then resolved, inferred or moved to
  `## Deferred`.
- No code steps, phases or test plans. Those belong to the planning stage.
