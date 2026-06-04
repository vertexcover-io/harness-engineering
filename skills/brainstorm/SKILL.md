---
name: brainstorm
description: >
  Structured brainstorming and design exploration for deep problem understanding before implementation.
  Use this skill whenever the user says "brainstorm", "think through", "explore this problem",
  "let's think about", "what are the angles", "help me understand", "design this", or wants to
  deeply analyze a feature, architecture decision, or technical challenge before writing code.
  Also trigger when the user is about to jump into implementation of something non-trivial and
  hasn't explored the problem space yet. This skill produces an architectural design doc — no
  code, scaffolding, or implementation.
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

## Depth Scaling

- **Minor** (small feature, bug fix): early phases as one question round, later phases brief.
  Design doc = a few paragraphs.
- **Medium** (new feature, moderate refactor): all phases, each focused. Doc covers key
  sections without exhaustive detail.
- **Major** (new system, architectural redesign): every phase at full depth. Thorough doc.

Start shallow; go deeper if hidden complexity surfaces.

## Core Principles

- **Understand before solving** — a well-understood problem reveals its own solution.
- **Surface what's hidden** — unstated constraints, implicit requirements, hidden dependencies,
  catastrophic edge cases.
- **Thinking gaps over solutions** — finding what hasn't been considered beats refining what has.
- **Design at the right level** — components, contracts, boundaries, trade-offs. No pseudocode.
- **YAGNI ruthlessly** — every knob, flag, optional feature must justify its existence *now*.

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

## The Brainstorming Flow

### Phase 1 — Context Gathering & Scope Check

Review relevant files, docs, and recent changes. Build a mental model.

**Context map** — if `.harness/knowledge/context/` exists, read `ARCHITECTURE.md` (system shape, boundaries),
`DECISIONS.md` (`D-*` — prior cross-cutting choices the design must not silently contradict), and
`GLOSSARY.md` (domain vocabulary). This keeps the design consistent with the existing product shape and
stops it re-proposing something a decision already ruled out. Advisory — verify against code; no
`.harness/knowledge/context/` → skip.

**Scope decomposition check** — if the request spans multiple independent subsystems
(own data model + API + auth/contract, each independently shippable), flag it. Each
sub-project gets its own design cycle. Tells: title contains "system"/"platform"/"overhaul";
author drafting Phase 1/Phase 2 internally; 2+ items with own data model + API + auth;
sub-piece A ships and provides value while B waits.

Don't split if sub-pieces share >30% of files and ship together — that's delivery
sequencing, not scope.

Use `AskUserQuestion` for every question (2-3 related Qs to establish context). Focus:
what triggered this, who is affected, what success looks like.

### Phase 2 — Visual Companion Offer (conditional)

If upcoming questions will involve visual content (mockups, layouts, diagrams, side-by-side
designs), offer the visual companion **as its own standalone message** before further
questions:

> "Some of what we're working on might be easier to explain visually. I can put together
> mockups, diagrams, and comparisons in a browser as we go. Want to try it?
> (Requires opening a local URL)"

This message must contain ONLY the offer — no other content. Wait for response. If
declined, proceed text-only. If accepted, decide **per question** whether to use the
browser or terminal — the test is: would the user understand this better by *seeing* it
than reading it? Use browser for mockups, wireframes, layout comparisons. Use terminal for
requirements, tradeoffs, scope decisions. A question about UI is not automatically a visual
question. Skip this phase entirely for backend-only work.

### Phase 3 — Problem & Requirements Exploration

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

Switch to **one question at a time** for deeper exploration. Multiple-choice when possible.
Always via `AskUserQuestion`.

**Techniques:** assumption surfacing, pre-mortem, constraint inversion, scope probing,
dependency mapping.

### Phase 4 — Library Trust Surfacing

For every external library or third-party API, record:

- **Maturity signals:** last commit, deprecated/archived, downloads. State bad signals plainly.
- **Distinct use cases to probe:** each flow we depend on is a separate probe.
- **Auth surface:** none / api-key / oauth / cookies + exact env keys (loaded from
  project-root `.env.harness`, gitignored).
- **Fallback chain:** ordered alternatives. MUST end in a paid API or build-our-own.

Output: `## External Dependencies & Fallback Chain` section in the design doc. If none,
write `None — pure-internal feature.` (Input contract for `library-probe` skill.)

### Phase 5 — Architectural Challenges

Identify hard structural problems shaping the solution:
- **Boundaries & interfaces** — where components start/end; contracts between them.
- **Data flow & ownership** — origin, movement, source of truth.
- **State management** — where state lives, how it syncs.
- **Concurrency & ordering** — races, ordering dependencies.
- **Evolution & migration** — change over time, incremental migration path.
- **Integration seams** — connections to existing systems, contract stability.

### Phase 6 — Approach Comparison

Present 2-3 distinct approaches **only when real alternatives exist**. For each: core idea,
how it maps to requirements, how it handles edge cases, trade-offs, risks, relative effort.
Include a recommendation, held loosely.

If only one approach is viable, write a 2-line "Why not X, Y" instead of parallel
Pros/Cons blocks for losers.

### Phase 7 — Approach Stress Test

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

### Phase 8 — YAGNI Pass + Design Synthesis

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
edge cases as EARS-style IDs: F1, F2, NF1, NF2…), Key Insights (conditional),
Architectural Challenges, Approaches Considered, Chosen Approach, High-Level Design,
External Dependencies & Fallback Chain, Open Questions, Risks and Mitigations, Assumptions.
"What this does NOT do" lives in the PRD's Non-Goals — not a separate section.

**Output rules** (to keep docs tight):
- **Key Insights section is conditional** — include only when 3-4 genuine reframings exist
  that aren't restated in Architectural Decisions.
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

### Phase 9 — Spec Review

Dispatch a fresh subagent with the design doc + review rubric (NOT session history).
Rubric covers: completeness vs. the lens list (Phase 7), EARS-style requirement IDs,
YAGNI pass evidence, no tautological assumptions, contract clarity, missing sections,
PRD integrity — section always present, with full subsections or (internal-facing only)
the `No PRD — internal-facing change.` sentinel as its body;
every user flow's behavior covered by at least one F#; no criteria text duplicated
between PRD and Requirements.
Iterate fixes; max 5 iterations, then surface to human.

### Phase 10 — User Review Gate (configurable)

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
- **Ignoring non-functional requirements** — perf, security, observability, maintainability
  is where production problems live.
- **Edge cases as afterthought** — found in brainstorm = cheap; found in prod = catastrophic.
- **Restating across sections** — Key Insights ↔ Architectural Decisions ↔ Risks should
  not say the same thing in different words.
- **Justification-stacking** — piling rationale on already-settled decisions.
- **Straw-man approaches** — listing obvious losers with full Pros/Cons to make the chosen
  one look better.
- **Combining the visual companion offer with other content** — the offer must be its own
  standalone message.
