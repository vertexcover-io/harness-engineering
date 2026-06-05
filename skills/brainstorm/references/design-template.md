# Design Document Template

Use this template when producing the design document in Phase 8. Scale sections
to the problem — a minor feature might have 2-3 sentence sections, a major
architectural change might have full paragraphs with diagrams.

Save to `.harness/features/<SPEC_NAME>/design.md`.

```markdown
# <Topic> — Design

## Problem Statement
What we're trying to solve, in concrete terms.

## Context
What exists today. What triggered this exploration.

## Product Requirements (PRD)
Always present. For user-facing features (human or API consumer), fill all
subsections below. For internal-facing changes (refactors, infra, tooling),
the section body is the single line `No PRD — internal-facing change.` with
no subsections. Everything here is user-observable behavior — no
architecture, no implementation.

### Personas
Who uses this, what they know, what they want. 1-3 short entries.

### Goals & Non-Goals
- **Goals:** product outcomes this must achieve (not system obligations — those are F# IDs).
- **Non-Goals:** explicitly out of scope. This covers "what this does NOT do" —
  behaviors that might be assumed but are deliberately excluded.

### User Stories
Traceability table only — do NOT restate acceptance criteria here; the F# IDs
in Requirements are canonical.

| Story | Persona | Fulfilled by |
|-------|---------|--------------|
| Can reset password from the login screen | End user | F3, F4 |

### User Flows
One per primary journey. Numbered steps of observable behavior
(action → what the user sees), including key error/empty states.
Write each flow so a tester could walk it — spec-generation turns these
into Verification Scenarios (VS-N).

**Flow: <name>**
1. <action> → <what the user sees>
2. ...

## Requirements
### Functional Requirements
- Numbered list of what the system must do.

### Non-Functional Requirements
- Performance, scalability, reliability, security, observability, maintainability.

### Edge Cases and Boundary Conditions
- Identified edge cases and how they should be handled.

## Key Insights
Conditional — include only when 3-4 genuine reframings exist that aren't
restated in Architectural Challenges. The most important things discovered
during brainstorming; things that surprised us or shifted our thinking.

## Architectural Challenges
The hard structural problems and how the design addresses them.

## Approaches Considered
### Approach A: <Name>
Summary, how it addresses requirements, trade-offs, risks.

### Approach B: <Name>
Summary, how it addresses requirements, trade-offs, risks.

### Approach C: <Name> (if applicable)
Summary, how it addresses requirements, trade-offs, risks.

## Chosen Approach
Which approach and why. What trade-offs we're accepting.

## High-Level Design
Architectural overview — components, boundaries, data flow, contracts.
This is conceptual, not code. Think boxes-and-arrows, not classes-and-methods.
Mermaid diagrams go here (architecture / sequence / state — see Phase 8 rules
for when each is required).

## External Dependencies & Fallback Chain
Required whenever the design names any external library or third-party API.
Write `None — pure-internal feature.` if there are no external deps.

### Primary: <lib-name>
- **Purpose:** What it does in this feature.
- **Use cases to probe:** Distinct flows we depend on (e.g. for Twitter:
  single tweet, list, thread). Each one becomes a separate probe.
- **Maturity:** Last commit, downloads, deprecated/archived flags. Note bad signals.
- **Auth:** none | api-key | oauth | cookies
- **Required env keys:** KEY1, KEY2 (all loaded from project-root `.env.harness`, gitignored)

### Fallbacks (in order)
1. <alt-lib-1> — why this is a fallback.
2. <alt-lib-2> — why.
3. <paid-api or build-custom> — must end with a non-OSS option so the harness
   can always land somewhere.

## Open Questions
Things that still need investigation or decisions.

## Risks and Mitigations
Known risks and how we plan to address them.

## Assumptions
What we're taking as given. What would invalidate these assumptions.
Omit if empty — no tautologies or already-verified facts.
```
