---
name: brainstorm
description: >
  Structured brainstorming and design exploration for deep problem understanding before implementation.
  Use this skill whenever the user says "brainstorm", "think through", "explore this problem",
  "let's think about", "what are the angles", "help me understand", "design this", or wants to
  deeply analyze a feature, architecture decision, or technical challenge before writing code.
  Also trigger when the user arrives with an existing plan and wants it interrogated — "grill me",
  "stress-test my plan", "poke holes in this design" (see Grill Mode). Also trigger when the user
  is about to jump into implementation of something non-trivial and hasn't explored the problem
  space yet. This skill produces an architectural design doc — no code, scaffolding, or implementation.
---

# Brainstorm: Deep Problem Understanding and Design

Two jobs that work together:

- **Deep problem understanding** — explore the problem from every angle, surface hidden
  assumptions, identify what hasn't been considered.
- **Design synthesis** — produce an architectural design (conceptual, not code-level).

A thorough exploration produces a good design; a rushed design produces rework.

<HARD-GATE>
Do NOT write code, scaffold, or invoke an implementation skill until the design doc is
written AND (unless bypassed) approved by the user. Applies to EVERY project, however
"simple" it seems.
</HARD-GATE>

## Core Principles

- **Understand before solving** — a well-understood problem reveals its own solution.
- **Surface what's hidden** — unstated constraints, implicit requirements, hidden dependencies,
  catastrophic edge cases.
- **Thinking gaps over solutions** — finding what hasn't been considered beats refining what has.
- **Design at the right level** — components, contracts, boundaries, trade-offs. No pseudocode.
- **YAGNI ruthlessly** — every knob, flag, optional feature must justify its existence *now*.

## Questioning Discipline

Applies to every question in every phase:

- **Explore before asking.** Resolve a question from the cheapest authoritative source first:
  1. **Lessons** — `.harness/knowledge/INDEX.md` for past incidents and patterns in this codebase.
     the decision instead; question it only if the new design has a concrete reason to revisit it.
  2. **Code and git history** — for what the map doesn't cover; code is authoritative when it
     conflicts with the map.
  3. **The user** — only for decisions they alone can make: preferences, priorities, business
     context, unknowable intent.
- **Every question carries a recommendation.** State your recommended answer and the one-clause
  why. In `AskUserQuestion`, the recommended option goes first, labeled "(Recommended)".
  Forming a recommendation forces the thinking; the user accepts or corrects instead of
  authoring from scratch.
- **Resolve decisions in dependency order.** Treat open decisions as a tree: ask the question
  that unblocks the most downstream questions first, and never ask a question whose best form
  depends on an unanswered upstream one. Batch 2-4 questions in one `AskUserQuestion` call only
  for independent context facts; any question whose answer could reshape another is asked alone.
- **Exit on shared understanding, not stamina.** Questioning ends when every identified decision
  branch is resolved or consciously parked in Open Questions — not when the list feels long
  enough. An unresolved material branch means keep going.

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
| 3 Architectural challenges | skip unless boundaries move | focused | full |
| 4 Approach comparison | skip — state the approach in one line | 2 approaches | 2-3 approaches |
| 5 Stress test | 2-3 most relevant lenses | all lenses, brief | all lenses, full |
| 6 YAGNI + design doc | a few paragraphs | key sections | thorough |
| 7 Spec review | self-review against the rubric (no subagent) | subagent review | subagent review |
| 8 User review gate | always | always | always |

Start shallow; go deeper if hidden complexity surfaces.

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

### Phase 2 — Problem & Requirements Exploration

Map the full problem space and discover what's needed. Requirements rarely arrive complete.

- **Problem space:** stakeholders, conflicting needs, constraints (technical, organizational,
  temporal), analogous solved problems.
- **Functional requirements:** core behaviors, I/O, business rules, integration points.
- **Non-functional:** performance, scalability, reliability, security, observability,
  maintainability.
- **Edge cases:** boundaries, dependency failures, unexpected user behavior, time/version
  evolution.
- **Product framing (user-facing features only):** capture personas and explicit
  non-goals while questioning — 1-2 targeted questions at most; this feeds the PRD
  section, it is not a new interrogation round. Skip for internal-facing changes.

Switch to **one question at a time**, in dependency order, each with a recommendation
(Questioning Discipline). Multiple-choice when possible. Always via `AskUserQuestion`.

**Techniques:** assumption surfacing, pre-mortem, constraint inversion, scope probing,
dependency mapping.

### Phase 3 — Architectural Challenges

Identify hard structural problems shaping the solution:
- **Boundaries & interfaces** — where components start/end; contracts between them.
- **Data flow & ownership** — origin, movement, source of truth.
- **State management** — where state lives, how it syncs.
- **Concurrency & ordering** — races, ordering dependencies.
- **Evolution & migration** — change over time, incremental migration path.
- **Integration seams** — connections to existing systems, contract stability.

### Phase 4 — Approach Comparison

Present 2-3 distinct approaches **only when real alternatives exist**. For each: core idea,
how it maps to requirements, how it handles edge cases, trade-offs, risks, relative effort.
Include a recommendation, held loosely.

If only one approach is viable, write a 2-line "Why not X, Y" instead of parallel
Pros/Cons blocks for losers.

### Phase 5 — Approach Stress Test

Stress-test the chosen approach before writing the doc. Walk these lenses against it —
generative, not just review. Each finding flows into Requirements, Edge Cases, Risks, or
Decisions:

- **End user:** failure modes visible or silently degrading?
- **6-months-later maintainer:** where will the next reader get stuck?
- **System under load:** what breaks at 10x / 100x?
- **Adjacent systems:** what contract did we assume that might change?
- **Security & abuse:** who exploits this and how?
- **Failure modes:** what happens when each dependency dies?

Also check: unvalidated assumptions, decision reversibility, edge cases vs. chosen approach.
If a lens produces nothing, that's suspicious — try again or note why it doesn't apply.

### Phase 6 — YAGNI Pass + Design Synthesis

**YAGNI pass first.** Every knob, flag, optional feature must answer: "needed now, or can
we hardcode and add it when the need is real?" Hardcode by default. Knobs survive only if
the right value is genuinely empirical (then defer the value, not the knob).

**Then write the doc.** Read `references/design-template.md`. Save to
`.harness/features/<SPEC_NAME>/design.md` (the orchestrator passes `SPEC_NAME`; if invoked
standalone without a `SPEC_NAME`, slugify the topic and create `.harness/features/<slug>/design.md`).

Sections (matching `references/design-template.md`): Problem Statement, Context,
Product Requirements (PRD — always present: personas, goals/non-goals, story→F# table,
user flows; for internal-facing changes the body is the
`No PRD — internal-facing change.` sentinel), Requirements (functional + non-functional +
edge cases as EARS-style IDs: F1, F2…, NF1, NF2…, EC1, EC2…), Key Insights (conditional),
Architectural Challenges, Approaches Considered, Chosen Approach, High-Level Design,
External Dependencies & Fallback Chain (finalized here from the continuous External
Dependency Declaration notes), Open Questions, Risks and Mitigations, Assumptions.
"What this does NOT do" lives in the PRD's Non-Goals — not a separate section.

**Output rules** (to keep docs tight):
- **Key Insights section is conditional** — include only when 3-4 genuine reframings exist
  that aren't restated in Architectural Challenges or Chosen Approach.
- **Assumptions** — no tautologies, no verified facts, no "we'll see". Omit if empty.
- **Open Questions** — items that block planning. Tunable knobs go inline with their
  decision as `(default X, tune empirically)`.
- **Code blocks show shapes, not bodies** — interfaces, signatures, data shapes. Bodies
  belong in planning/coding.
- **Cite, don't re-enumerate** — if a linked artifact covers it, reference the section.
- **PRD never restates acceptance criteria** — stories reference F# IDs; flows describe
  observable behavior only (no architecture). F# stays the single source of truth.
- **Justification budget** — one clause per decision. If more is needed, the decision
  isn't ready.

**Diagrams required** (mermaid, part of the design — not decoration):
- **Architecture diagram** (`graph TB` / `graph LR`) — required for designs with 3+
  components. Show components and their connections.
- **Sequence diagrams** (`sequenceDiagram`) — one per multi-component flow that crosses
  2+ boundaries (e.g., upload pipeline, auth handshake, write-with-fanout).
- **State diagrams** (`stateDiagram-v2`) — when an entity has non-trivial transitions
  (e.g., subscription confirmation, payment lifecycle, document review states).

If the diagram is wrong, the design is wrong. Update diagrams when the design changes.

### Phase 7 — Spec Review

Dispatch a fresh subagent with the design doc + review rubric (NOT session history).
Rubric covers: completeness vs. the lens list (Phase 5), EARS-style requirement IDs,
YAGNI pass evidence, no tautological assumptions, contract clarity, missing sections,
PRD integrity — section always present, with full subsections or (internal-facing only)
the `No PRD — internal-facing change.` sentinel as its body;
every user flow's behavior covered by at least one F#; no criteria text duplicated
between PRD and Requirements.
Iterate fixes; max 5 iterations, then surface to human.

### Phase 8 — User Review Gate (configurable)

**Default ON.** Present the design path to the user and pause:
> "Design at `<path>`. Review and confirm before I hand off to spec-generation."

**Bypass** when:
- `--auto` flag set (orchestrate / CI mode)
- Prompt contains "don't wait for approval", "skip review", "no review gate"

On approval (or bypass), flow to spec-generation.

## Handling Pushback

If the user wants to skip phases, let them — but note what's skipped and what risk it
introduces. If they disagree with the recommendation, explore why — their context often
reveals factors you missed. If they want to go straight to implementation, that's their
call, but ensure it's conscious, not habit.

## Anti-Patterns

- **Premature solutioning** — jumping to "here's how to implement" before understanding.
- **Single-perspective analysis** — only happy path or only developer view. Rotate.
- **Skipping for "simple" problems** — simple-seeming problems harbor unexamined assumptions.
- **Asking what the context layer or codebase already answers** — check `D-*` decisions and
  explore first; user time is for decisions only they can make.
- **Questions without recommendations** — open-ended questions offload the thinking to the
  user. Always bring a recommended answer.
- **Ignoring non-functional requirements** — perf, security, observability, maintainability
  is where production problems live.
- **Edge cases as afterthought** — found in brainstorm = cheap; found in prod = catastrophic.
- **Restating across sections** — Key Insights ↔ Architectural Challenges ↔ Risks should
  not say the same thing in different words.
- **Justification-stacking** — piling rationale on already-settled decisions.
- **Straw-man approaches** — listing obvious losers with full Pros/Cons to make the chosen
  one look better.
- **Combining the visual companion offer with other content** — the offer must be its own
  standalone message.
- **Re-deriving a plan the user brought** — that's Grill Mode: interrogate their design,
  don't compete with it.
