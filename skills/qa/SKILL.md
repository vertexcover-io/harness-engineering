---
name: qa
description: >
  Interactive Q&A session for low-level design — runs between spec-generation and planning.
  Deeply explores the codebase, identifies implementation questions, and resolves all ambiguities
  with the user before planning begins. Use when the user says "qa", "questions", "low-level design",
  "implementation questions", or when transitioning from spec to planning in the orchestrate pipeline.
  This skill runs in the main conversation (interactive, like brainstorm) — NOT as a sub-agent.
  By the time this skill completes, the planner should have zero open questions.
---

# Q&A: Interactive Low-Level Design

Bridges the gap between spec-generation (what to build) and planning (how to build it).
Reads the codebase deeply, asks the user implementation-level questions, and documents
all decisions so the planner starts with zero ambiguity.

**Announce at start:** "Using the Q&A skill for low-level design — I'll explore the codebase and ask implementation questions."

**Hard gate:** All questions must be resolved interactively with the user before writing `qa.md`.

---

## Inputs

This skill expects:
- A **spec file** (`spec.md`) — the output of brainstorm + spec-generation
- A **spec directory** — where to write `qa.md`

If invoked standalone (not via orchestrate), ask the user to point to the spec.

---

## The Q&A Process

### Step 1: Load Context

- Read the spec (`spec.md`) and any design doc
- Understand what's being built — requirements, architecture, acceptance criteria
- Note anything the spec leaves open or underspecified

### Step 2: Deep Codebase Exploration

Use `Agent` sub-agents (subagent_type=Explore) in parallel to investigate multiple areas simultaneously.

**What to explore:**

1. **Files that will be touched/extended** — find them, read them, understand their structure
2. **Data flow** — trace how data moves through the parts of the codebase this feature touches
3. **Existing patterns** — utilities, base classes, conventions that the implementation should follow
4. **Potential conflicts** — modules that share state, coupling risks, migration concerns
5. **Test infrastructure** — how similar features are tested, what fixtures and helpers exist
6. **Surprising inconsistencies** — anything that contradicts the spec's assumptions

**Depth scaling** (match effort to change size):
- **Minor changes:** Quick scan of 2-3 files, skip parallel agents
- **Medium changes:** Thorough scan, use 2-3 parallel explore agents
- **Major changes:** Deep exploration with 4+ parallel agents covering different areas

### Step 3: Identify Questions

From the codebase exploration, build a question list across these categories:

**A. Implementation Approach**
- "The spec says X, but the codebase does Y — should we follow the existing pattern or change it?"
- "There are two ways to extend this — via Z or via W. Which do you prefer?"

**B. Integration Points**
- "This touches module M which also affects feature F — is that intentional?"
- "Should this reuse the existing utility at `path/to/util` or create a new one?"

**C. Edge Cases & Error Handling**
- "The spec doesn't cover what happens when X fails — should we retry, fail silently, or propagate?"
- "What's the expected behavior for concurrent access to Y?"

**D. Scope Boundaries**
- "Implementing REQ-003 would require changing the shared Z interface — is that in scope?"
- "Should we handle backward compatibility with the old API?"

**E. Technical Decisions**
- "What's the preferred approach for state management here — option A or option B?"
- "Should tests use real DB or mocks for this feature?"

If the codebase exploration reveals no questions (rare — typically only for trivial changes), note that and write a minimal `qa.md`.

### Step 4: Interactive Q&A Session

Ask questions **one at a time** (or small batches of 2-3 closely related ones).

**Rules:**
- Use **multiple-choice** when possible to reduce cognitive load
- Group questions by category
- After each answer, check if it raises follow-up questions
- Continue until no open questions remain
- If the user says "you decide" or "your call," make the decision, state it clearly, and record the rationale

**Example question format:**
```
**Implementation Approach Q1:** The spec calls for a webhook dispatcher, but the codebase
already has an event emitter at `src/events/emitter.ts`. Should we:

A) Extend the existing event emitter to support webhooks
B) Create a new webhook-specific dispatcher alongside it
C) Replace the event emitter with a unified system

I'd recommend A — it reuses existing infrastructure and avoids duplication.
```

### Step 5: Synthesize & Write qa.md

After all questions are resolved, write `qa.md` to the spec directory.

---

## Output Format (`qa.md`)

```markdown
# Q&A: <Feature Name>

> **Spec:** <path to spec.md>
> **Date:** YYYY-MM-DD

## Codebase Findings

### Files to Touch
- `path/to/file.ts` — [what needs to change and why]

### Existing Patterns to Follow
- `path/to/similar.ts` — [pattern description]

### Potential Conflicts
- [any conflicts discovered, or "None identified"]

## Resolved Questions

### Implementation Approach
| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| Q1 | ... | ... | ... |

### Integration Points
| # | Question | Decision | Rationale |
|---|----------|----------|-----------|

### Edge Cases & Error Handling
| # | Question | Decision | Rationale |
|---|----------|----------|-----------|

### Scope Boundaries
| # | Question | Decision | Rationale |
|---|----------|----------|-----------|

### Technical Decisions
| # | Question | Decision | Rationale |
|---|----------|----------|-----------|

## Summary for Planner
- [Key decisions that affect phase design]
- [Files identified for modification]
- [Patterns to follow]
- [Constraints discovered]
```

Omit empty categories — only include sections that have content.

