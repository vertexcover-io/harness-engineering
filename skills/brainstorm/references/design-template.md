# Design Document Template

Use this template when producing the design document in Phase 6. Scale sections
to the problem — a minor feature might have 2-3 sentence sections, a major
architectural change might have full paragraphs with diagrams.

Save to `docs/plans/YYYY-MM-DD-<topic>-design.md`.

```markdown
# <Topic> — Design

## Problem Statement
What we're trying to solve, in concrete terms.

## Context
What exists today. What triggered this exploration.

## Requirements
### Functional Requirements
- Numbered list of what the system must do.

### Non-Functional Requirements
- Performance, scalability, reliability, security, observability, maintainability.

### Edge Cases and Boundary Conditions
- Identified edge cases and how they should be handled.

## Key Insights
The most important things discovered during brainstorming.
Things that surprised us or shifted our thinking.

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

## Open Questions
Things that still need investigation or decisions.

## Risks and Mitigations
Known risks and how we plan to address them.

## Assumptions
What we're taking as given. What would invalidate these assumptions.
```
