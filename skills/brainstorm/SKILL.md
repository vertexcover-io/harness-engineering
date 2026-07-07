---
name: brainstorm
description: >
  Explore a problem and design it before implementation — surfacing every decision the
  design turns on, then producing an architectural design doc (no code). Use when the user
  wants to brainstorm, think through, or design a non-trivial feature, architecture change,
  or migration; when they hand over a design to interrogate ("grill me", "poke holes in
  this" — see Grill Mode); or before jumping into implementation of something structural
  they haven't explored yet.
---

# Brainstorm: Deep Problem Understanding and Design

**The job: open the decision tree, then close it.** A design is done when every decision it
turns on is either resolved or consciously parked — not when questioning feels thorough. You
open the tree by discovering decisions (Phases 1-5), close it at the completeness gate, then
synthesize the design doc. The design is conceptual — boundaries, contracts, trade-offs, no code.

<HARD-GATE>
Do NOT write code, scaffold, or invoke an implementation skill until the design doc is
written AND (unless bypassed) approved by the user. Applies to EVERY project, however
"simple" it seems.
</HARD-GATE>

## Questioning Discipline

Applies to every question in every phase:

- **Explore before asking.** Resolve a question from the cheapest authoritative source first:
  1. **Code and git history** — code is authoritative when it conflicts with stated assumptions.
  2. **The user** — only for decisions they alone can make: preferences, priorities, business
     context, unknowable intent.
- **Every question carries a recommendation.** State your recommended answer and the one-clause
  why. In `AskUserQuestion`, the recommended option goes first, labeled "(Recommended)".
  Forming a recommendation forces the thinking; the user accepts or corrects instead of
  authoring from scratch.
- **Write the decision tree down.** Keep an explicit written list of open decisions — not a
  mental model. Tag each `blocks:` / `blocked-by:` and resolve top-down: ask the decision that
  unblocks the most downstream ones first, never one whose best form depends on an unanswered
  upstream one. A decision you were forced to write cannot be silently forgotten. Batch 2-4
  questions in one `AskUserQuestion` call only for independent context facts; any question whose
  answer could reshape another is asked alone. (Format and derivation: `references/question-completeness.md`.)
- **Exit on a closed decision tree, not stamina.** Questioning ends only after the completeness
  gate (see Phase 2) confirms no material decision is still open — every one resolved or
  consciously parked in Open Questions. "The list feels long enough" is not the exit condition.

## Scope of This Skill

Brainstorm applies to **structural changes**: extractions, rearchitectures, new components
inside existing systems, migration paths. Output is a design (what changes, where boundaries
move, how things connect).

Brainstorm does **not** apply to:
- **Bug investigation** — use direct exploration. Output should be a root cause and fix.
- **Tactical refactoring** (rename, extract function, restructure one file) — use `harness:refactor`.
- **Performance investigation** — profile first; brainstorm only if the fix is structural.

Rule of thumb: "change these 10 lines" is not brainstorm; "this changes how three components
talk to each other" is.

## Grill Mode — User Arrives With a Plan

When the user already has a plan or design ("grill me", "stress-test my plan", "poke holes
in this"), do not re-derive it from scratch. Flip the flow:

1. Read their plan; explore the codebase to verify its claims (Questioning Discipline applies —
   verify in code what code can verify).
2. Interview the user relentlessly: walk each branch of *their* design tree, resolving
   dependencies between decisions one-by-one, one question at a time, each with your
   recommended answer.
3. Run the Phase 5 stress-test lenses against their plan, not a fresh design.
4. Output: the agreed result captured as a design doc — then the normal Phase 6-8 pipeline.

Greenfield Phases 2-4 are skipped; the goal is shared understanding of their design, not a
competing alternative.

## Depth Scaling

| Phase | Minor (small feature) | Medium (new feature, moderate refactor) | Major (new system, redesign) |
|-------|----------------------|------------------------------------------|------------------------------|
| 1 Context & scope | one AskUserQuestion round | full | full |
| 2 Problem & requirements | folded into that round | focused | full depth |
| 2 Completeness gate | inline self-check | subagent | subagent |
| 3 Architectural challenges | skip unless boundaries move | focused | full |
| 4 Approach comparison | skip — state the approach in one line | 2 approaches | 2-3 approaches |
| 5 Stress test | 2-3 most relevant lenses | all lenses, brief | all lenses, full |
| 6 YAGNI + design doc | a few paragraphs | key sections | thorough |
| 7 Spec review | self-review against the rubric (no subagent) | subagent review | subagent review |
| 8 User review gate | always | always | always |

## External Dependency Declaration (continuous — not a phase)

Brainstorm *declares* dependencies; the `library-probe` skill *verifies* them (health
heuristics + live smoke tests) right after brainstorm. Do not investigate library health
here — that's probe work. Whenever an external library or third-party API enters the
conversation, record the design-time decisions only:

- **Distinct use cases to probe:** each flow we depend on is a separate probe.
- **Auth surface:** none / api-key / oauth / cookies + exact env keys (loaded from
  project-root `.env.harness`, gitignored).
- **Fallback chain:** ordered alternatives. MUST end in a paid API or build-our-own —
  the probe walks this chain automatically when a library fails verification.

Finalize as the `## External Dependencies & Fallback Chain` section of the design doc during
Phase 6 — the dependency set is only settled once the approach is chosen. If none, write
`None — pure-internal feature.` (This section is library-probe's input contract; it blocks
without it.)

## The Brainstorming Flow

### Phase 1 — Context Gathering & Scope Check

Review relevant files, docs, and recent changes. Build a mental model.

**Scope decomposition check** — if the request spans multiple independent subsystems
(own data model + API + auth/contract, each independently shippable), flag it. Each
sub-project gets its own design cycle. Tells: title contains "system"/"platform"/"overhaul";
author drafting Phase 1/Phase 2 internally; 2+ items with own data model + API + auth;
sub-piece A ships and provides value while B waits.

Don't split if sub-pieces share >30% of files and ship together — that's delivery
sequencing, not scope.

Use `AskUserQuestion` for every question (2-3 related Qs to establish context — independent
facts only, per Questioning Discipline). Focus: what triggered this, who is affected, what
success looks like.

**Visual companion (sidebar — UI-facing work only).** If upcoming questions will involve
visual content (mockups, layouts, diagrams, side-by-side designs), offer the visual companion
**as its own standalone message** before further questions:

> "Some of what we're working on might be easier to explain visually. I can put together
> mockups, diagrams, and comparisons in a browser as we go. Want to try it?
> (Requires opening a local URL)"

The message must contain ONLY the offer — no other content. Wait for response. If declined,
proceed text-only. If accepted, decide **per question** whether browser or terminal fits —
the test: would the user understand this better by *seeing* it? Browser for mockups,
wireframes, layout comparisons; terminal for requirements, tradeoffs, scope decisions. A
question about UI is not automatically a visual question. Skip entirely for backend-only work.

### Phase 2 — Problem & Requirements Exploration (open the tree)

Requirements rarely arrive complete. **Seed the decision tree from two sources** so
completeness is derived, not recalled: walk every section of `references/design-template.md`
(an empty or hand-wavy section is an unasked question — this covers problem space,
functional/non-functional requirements, edge cases, the hard structural questions, and
personas/non-goals for user-facing work) and walk the stress-test lenses as question sources.
Both feed the written tree.

Ask **one question at a time**, in dependency order, each with a recommendation
(Questioning Discipline). Multiple-choice when possible. Always via `AskUserQuestion`.

**Completeness gate (exit criterion).** Before leaving questioning, confirm no material
decision is still open. Minor: inline self-check re-walking both sources. Medium/Major:
dispatch a fresh completeness sub-agent. Anything it surfaces re-enters the tree and must be
resolved or parked. Full rubric and sub-agent prompt: `references/question-completeness.md`.

### Phase 3 — Architectural Challenges

The hard structural questions (boundaries, data ownership, state, concurrency, migration,
integration seams) are surfaced by the Phase 2 template walk — see the High-Level Design
entry in `references/question-completeness.md`. This phase is where you resolve them into
the chosen structure; at Minor depth skip unless boundaries actually move.

### Phase 4 — Approach Comparison

Present 2-3 distinct approaches **only when real alternatives exist**. For each: core idea,
how it maps to requirements, how it handles edge cases, trade-offs, risks, relative effort.
Include a recommendation, held loosely.

If only one approach is viable, write a 2-line "Why not X, Y" instead of parallel
Pros/Cons blocks for losers.

### Phase 5 — Approach Stress Test

Stress-test the chosen approach before writing the doc. Walk the lenses in
`references/stress-test-lenses.md` against it — generative, not just review. Each finding
flows into Requirements, Edge Cases, Risks, or Decisions.

### Phase 6 — YAGNI Pass + Design Synthesis

**YAGNI pass first.** Every knob, flag, optional feature must answer: "needed now, or can
we hardcode and add it when the need is real?" Hardcode by default. Knobs survive only if
the right value is genuinely empirical (then defer the value, not the knob).

**Then write the doc.** Read `references/design-template.md`. Save to
`.harness/features/<SPEC_NAME>/design.md` (the orchestrator passes `SPEC_NAME`; if invoked
standalone without a `SPEC_NAME`, slugify the topic and create `.harness/features/<slug>/design.md`).

The section list, output rules (keep docs tight), and required mermaid diagrams all live
in `references/design-template.md` — follow it; do not restate it here. The External
Dependencies & Fallback Chain section is finalized here from the continuous External
Dependency Declaration notes. "What this does NOT do" lives in the PRD's Non-Goals.

### Phase 7 — Spec Review

Dispatch a fresh subagent with the design doc + the rubric in
`references/spec-review-rubric.md` (NOT session history). Iterate fixes; max 5
iterations, then surface to human.

### Phase 8 — User Review Gate (configurable)

**Default ON.** Present the design path to the user and pause:
> "Design at `<path>`. Review and confirm before I hand off to spec-generation."

**Bypass** when:
- `--auto` flag set (orchestrate / CI mode)
- Prompt contains "don't wait for approval", "skip review", "no review gate"

On approval (or bypass), flow to spec-generation.

## Anti-Patterns

- **Premature completion** — closing the tree because the list feels long, before the gate
  confirms no material decision is open. The failure this skill exists to prevent.
- **Premature solutioning** — jumping to "here's how to implement" before the tree is open.
- **Skipping for "simple" problems** — simple-seeming problems harbor unexamined assumptions.
