# Question Completeness

The gate that catches the question you never thought to ask. Run before questioning
exits. The exit condition "every identified branch resolved" is circular — it cannot
catch a branch never identified. This rubric makes completeness *derivable* instead of
recalled.

## The decision tree (throughout questioning)

Keep an explicit, written list of open decisions — not a mental model. Each entry:

```
D<n>: <the decision> — blocks: D<a>, D<b> · blocked-by: D<c>
```

Resolve top-down: ask the decision that unblocks the most downstream decisions first;
never ask a question whose best form depends on an unanswered upstream one. A decision
you were forced to write down cannot be silently forgotten. Mark each `resolved`,
`parked` (→ Open Questions), or `open`. Questioning is not done while a material
decision is `open`.

## Deriving the decision set (two independent sources)

Completeness comes from crossing two sources — neither alone is enough.

**1. Template-section walk.** Walk every section of `design-template.md`. For each, ask:
*do I have enough to write this section, or is there an open decision hiding here?*
An empty or hand-wavy section IS an unasked question. High-yield sections:

- **Functional Requirements** — is each core behavior's rule pinned, or assumed?
- **User Flows** — is each primary journey enumerated? For multi-actor systems, what does
  a user see of other actors' presence and live activity?
- **Edge Cases** — boundaries, dependency failure, concurrent/stale actors, deletion mid-flow.
- **High-Level Design / data ownership** — source of truth, who writes, how state syncs.
  The hard structural questions live here: boundaries & interfaces (where components
  start/end, contracts between them), data flow & ownership, state management,
  concurrency & ordering (races, ordering deps), evolution & migration path, integration
  seams (contract stability with existing systems).
- **Non-Goals** — what's deliberately excluded? Unstated non-goals become scope creep.
- **External Dependencies** — every named lib/API: auth surface, fallback, env keys.
- **Non-Functional Requirements** — perf target, scale bound, reliability, security, observability.

**2. Lens walk.** Run the six stress-test lenses (`stress-test-lenses.md`) *as question
sources*, not just as review — each lens that produces a concern you can't answer is an
open decision. (Phase 5 runs these lenses again against the chosen approach; here they
generate questions.)

## The gate

Before leaving the questioning phases:

- **Minor depth** — inline self-check: re-walk the two sources above against the decision
  tree; any gap re-enters the tree as `open`.
- **Medium / Major depth** — dispatch a fresh sub-agent (see prompt below). Its findings
  re-enter the decision tree. Do not exit until it returns nothing material, or every
  new item is resolved or consciously parked.

### Sub-agent dispatch prompt (Medium / Major)

Dispatch a fresh subagent with the current decision tree + design context (NOT session
history). Prompt:

> You are a completeness reviewer for a brainstorming session. Below is the problem
> context and the current list of open/resolved decisions. Your ONLY job is to find
> decisions that are MISSING — questions that must be answered before this can be
> planned, but which do not appear in the list.
>
> Check two ways: (1) walk each section of the design template and name any section that
> can't yet be written; (2) apply the lenses — end user, maintainer, scale, adjacent
> systems, security/abuse, dependency failure — and name any concern the current
> decisions don't address.
>
> Return ONLY the missing decisions, each as one line: `<decision> — why it blocks
> planning`. If nothing material is missing, return "COMPLETE". Do not restate decisions
> already in the list. Under 300 words.

Iterate until the reviewer returns COMPLETE or all surfaced items are resolved/parked;
max 3 rounds, then surface remaining gaps to the user as Open Questions.
