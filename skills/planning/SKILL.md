---
name: planning
description: >
  Implementation planning for features, design documents, and multi-step tasks. Use this skill
  whenever you need to create an implementation plan before writing code — whether from a design
  document, a feature request, a bug fix, or any non-trivial task. Trigger when the user says
  "plan", "create a plan", "implementation plan", "break this down", "how should we implement",
  or when transitioning from brainstorming/design to implementation. Also trigger when the user
  provides a design document and wants to move to execution, or when a task clearly needs
  decomposition before coding begins. This skill bridges the gap between understanding a problem
  (brainstorm skill) and executing it (tdd skill). If no brainstorm/design doc exists and the
  feature is non-trivial, suggest brainstorming first — but don't block on it for smaller features.
  Also trigger when the user wants to update an existing plan using @fix tags.
---

# Implementation Planning

Produces actionable implementation plans as a folder of documents — one overview and
one file per phase. Each phase is a **vertical slice** — one thin capability cut through every
layer it touches (config → form → validation → persistence → render), independently buildable and
demoable — not a horizontal layer (all the config, then all the API, then all the UI). The folder
structure lets you work on early phases while refining later ones in parallel sessions.

**Vertical, not horizontal.** A horizontal slice is a *component* ("the data model", "the UI
layer"); nothing is usable until the last layer lands, and the only real end-to-end test has to be
deferred to plan.md because no single phase can run it. A vertical slice is a *capability* ("a user
registers and the account exists — validated, persisted, confirmable"); it works on its own, a user
can exercise it, and it carries its own end-to-end test. Slice by capability, then order the slices;
never slice by repo or layer. The **anti-horizontal test**: if a phase's title names only a
repo/layer with no user-visible outcome ("db: schema", "api: endpoints", "ui: forms"), it is
horizontal — re-slice it around the capability it serves.

> **Examples in this skill use a neutral illustrative domain (a user-auth feature: register, log in,
> token refresh, protected routes) that is deliberately unrelated to whatever feature you are
> planning.** State every rule feature-independently and, when you need a concrete illustration, draw
> it from a domain *distinct from the target feature* — never from the feature at hand. This keeps the
> skill general: examples anchored to one real feature silently narrow the rules to that feature's
> shape. Your plan's artifacts, of course, use the target feature's real vocabulary; only the skill's
> teaching examples stay neutral.

**Walking skeleton first.** The first slice is the thinnest path that touches every layer once and
produces a visible result — the *walking skeleton*. It establishes the shared plumbing; later slices
thicken it and mostly parallelize. Do **not** front-load a "build all the shared foundation" phase by
default: shared plumbing rides inside the first slice that needs it. **Exception:** a thin
foundation phase (a shared config schema, a shared helper) is justified *only when two or more later
slices provably depend on it* and folding it into slice 1 would couple slice 1 to slice 2's needs —
then it may be its own small phase 0. Absent that proven multi-consumer need, keep it inside the
walking skeleton. Do not swing from all-horizontal to a dogmatic all-vertical that recreates coupling.

**Announce at start:** "Using the planning skill to create an implementation plan."

**Plan output:**

`plan.md` (the overview + DOT phase graph) is committed; per-phase breakdowns are pipeline working state and stay gitignored.

```
.harness/features/<SPEC_NAME>/
└── plan.md          # Committed — overview, DOT phase graph, codebase context

.harness/runtime/<SPEC_NAME>/
├── phase-1.md       # Gitignored — detailed steps for phase 1
├── phase-2.md       # Gitignored — detailed steps for phase 2
└── ...
```

**For small, obvious changes** (single file, clear fix): skip planning, go straight to TDD.

---

## The Planning Process

### Step 1: Understand the Input

The input is either a **design document**, a **spec**, or a **feature description**.

- Read it thoroughly — requirements, chosen approach, decisions, edge cases
- Note open questions or assumptions that affect implementation

**Goal:** What are we building, what are the acceptance criteria, what's already decided?

### Step 2: Explore the Codebase

Build understanding of existing code before planning changes. Dispatch sub-agents in parallel to investigate — Claude Code: `Agent` tool with `subagent_type=Explore`; Codex: invoke the `explore` agent defined at `.codex/agents/explore.toml` (see `references/codex-tools.md`). Also use `Glob`/`Grep`/`Read` directly for targeted lookups.

**What to explore:** the files this feature will touch (structure); the data flow through them;
existing patterns/utilities/conventions to follow; conflict risks (shared state, coupling,
migration); test infrastructure (fixtures, helpers) and E2E infrastructure (frameworks, how backing
services and the dev server start); dependencies (what can run in parallel); and, for external
libraries, current API signatures via context7 or web search.

**Depth scaling** (match effort to change size): minor → quick scan of 2-3 files, no parallel agents;
medium → thorough scan, 1-2 explore agents; major → deep exploration, at most 2 explore agents plus
main-thread Glob/Grep.

Record findings — they go into plan.md's Codebase Context section.

### Step 3: Interactive Q&A

From the codebase exploration, identify implementation questions and resolve them with the user
before designing phases, so the planner starts with zero ambiguity. Ask about: **implementation
approach** (spec says X but code does Y; two ways to extend), **integration points** (reuse vs. new;
shared-module impact), **edge cases** (unspecified failure handling), **scope boundaries** (does
REQ-N require changing a shared interface), and **technical decisions** (state management, real DB
vs. mocks).

**Rules:**
- **Always use the `AskUserQuestion` tool** to ask questions — never embed questions in plain text output
- Ask questions **one at a time** (or small batches of 2-3 closely related ones)
- Use **multiple-choice** when possible to reduce cognitive load
- After each answer, check if it raises follow-up questions
- If the user says "you decide" or "your call," make the decision, state it clearly, and record the rationale
- If the codebase exploration reveals no questions (rare — typically only for trivial changes), skip this step

**Hard gate:** All questions must be resolved before proceeding to phase design.

### Step 4: Derive Test Scenarios

Before designing phases, derive the **behavioral, scenario-based tests** that will prove the
feature works and that nothing regressed. This step drives phase design — scenarios come first so
each phase is built to satisfy specific, observable behaviors.

**Read `references/test-scenarios.md` and follow it — it is the authority on this step** (scenario
format, systematic derivation, two altitudes, the placement/containment test, regression rules, the
coverage checklist). Do not restate its content here or in your reasoning; apply it. This step must
not be skipped or done shallowly — the process-level obligations it feeds are:

- **Derive the whole set first, then distribute.** List every scenario across the feature to confirm
  coverage, then place each: Unit/API in the phase that delivers it; each E2E flow by the containment
  test (phase-level to its phase — the common case; cross-slice to plan.md's System E2E). Number
  globally (S1, S2, …) so trace ids stay unique across files.
- **Regression scenarios are mandatory when the plan touches shared code**, even if the source names
  no such requirement — add them and note the gap.
- **Do a written coverage-map pass** before writing phase files: pair every source item (each
  requirement, edge case, risk, "shall not change" clause, and each named variant of a capability)
  with the scenario id(s) covering it. A written pass catches what a linear read misses (the 2nd/3rd
  variant, the enforcement negative, the plain create-then-view). Fill or flag any gap. This map is a
  **working artifact only — never a section in any output file** (no audit / coverage-map /
  traceability-matrix section); coverage lives in the per-scenario trace tags.

### Step 5: Design the Phases

Each phase is a **vertical slice** — one thin capability cut through every layer it touches, from
the user's entry point to a user-visible outcome. It makes sense on its own, a user can exercise it,
and it can prove itself end to end. A phase typically follows one TDD cycle (RED-GREEN-REFACTOR)
resulting in one commit. Occasionally a complex slice may need multiple TDD cycles, each with its
own commit — but this should be rare. If a phase needs many cycles, it's probably two capabilities
and should be split.

**Slice vertically, never horizontally:**
- A phase delivers a **thin end-to-end capability a user can exercise** — e.g. "a user registers and
  the account exists: validated → persisted → confirmable on read" — cutting through every layer it
  needs (data, service, form, validation, render), not one layer across all capabilities. A phase
  spanning several repos to deliver one working capability is correct; several phases each confined to
  one repo/layer ("db: schema", "ui: render") is the horizontal anti-pattern — re-slice it.
- **The first slice is the walking skeleton** — the narrowest capability touching every layer once
  with a visible result. Later slices thicken it and, being independent, mostly parallelize (see the
  foundation-phase exception in the intro before pulling shared plumbing into its own phase).
- **Don't split one mechanism across phases by data case.** A *generic* mechanism (a config-driven
  builder/validator, a per-case-free renderer) handles every data case it covers at once — the second
  locale, another role, the third record type are the **same capability with different data**.
  Splitting them leaves the second phase nothing to build but confirming the first. Keep all the data
  cases in the one slice that builds the mechanism; prove each with its own scenario. Split only when
  a case needs genuinely new production code (a different component, a new enforcement path) — the
  split is justified by *that code*, not the data.
- Leaves the codebase working with all tests passing. Express dependencies as a DOT digraph in
  plan.md — expect a walking-skeleton node with a wide fan-out, not a strict layer chain.
- **Carries its own phase-scoped test scenarios** (Step 4): each Unit/API scenario, plus a
  phase-level `### E2E` — which a vertical slice almost always owns, since its point is a runnable
  end-to-end capability. Only a genuinely cross-slice E2E goes to plan.md's System E2E. The scenarios
  a phase carries *are* its definition of done — no separate Done-When section.

**Every phase must build load-bearing work; a test obligation is not a phase.** Before keeping a
phase, read its `## Implementation`: *does it add new production code whose absence would break the
feature?* If its steps are mostly "confirm X" / "verify the prior builder handles Y" / "no change
needed" with one stray edit, it is not a slice — it is another slice's test obligation. Fold such
work into the slice that **touches (modifies) or exercises (runs end-to-end) the code it concerns**:
- **Regression / "unchanged" / "still generic" guards** belong in the slice that changes the shared
  code — that slice asserts the pre-existing callers still work. No phase exists solely to hold guard
  tests.
- **"Touched" is not the only trigger — "exercised" counts too.** A generic downstream artifact (a
  renderer, serializer, formatter) a slice does not *edit* but whose output *is the observable outcome
  of that slice's own end-to-end flow* is exercised by it: its coverage is that slice's `### E2E`
  render/output leg, not a separate phase. Do not read "the slice doesn't modify the renderer" as "no
  slice touches it" — that pulls render back into a standalone layer-phase (horizontal slicing).
- **New-but-not-independently-valuable behavior** (e.g. a cross-row de-dup rule, meaningless until a
  record holds multiple rows) folds into the slice where it first becomes meaningful. Split it out
  only when it builds new production code in a file no other slice touches.

**Two things are genuinely *not* phases:**
- **An unchanged artifact with no in-scope way to prove it** (a schema already generic whose only
  consumer is out of scope). Record it as a **verified precondition in plan.md's Codebase Context**,
  not a phase.
- **A standalone confirm-and-guard phase** survives *only* when generic code is **neither modified nor
  exercised end-to-end by any slice**, yet the feature relies on its genericness and it has no
  coverage — a rare case with no slice to fold into. When one does survive: its `## Overview` states
  the guard's purpose; its `## Implementation` first step notes no production change and the rest
  describe the test file(s); if a test surfaces a real gap, fixing it to stay generic is in scope.

**Runner-less producer repos** (a raw JSON/config or types-only package — `test` is `echo no-test`):
never invent a runner. The proving scenario lives in the **consumer** phase that imports the artifact
and has a runner, written there once. If producer and consumer are separate phases, the producer's
`## Implementation` names in prose where the behavior is proven (a locator, not a scenario copy). If
the producer is folded into its consumer slice (common — a shared config created inside the
walking-skeleton slice that reads it), they are the same phase: create the artifact and prove it
there, no locator needed.

**Steps within a phase:** decompose by the `## Implementation` work, not a separate Step Graph or
per-step Files/Tests/Done blocks (those duplicate Implementation and Test Scenarios). Note any
parallelizable sub-work in one line of prose; real parallelism lives in the phase graph.

### Step 6: Write the Plan Documents

Create the folder and write all documents. Use the `AskUserQuestion` tool to present
the plan summary and ask for approval — never embed approval questions in plain text output.

---

## Output Format

**The annotated skeletons for `plan.md` and `phase-N.md` live in `references/plan-template.md` —
that file is the single source of truth for the shape. Read it and follow it; do not reproduce the
skeleton here.** This section states only the *rules* that govern the format — the reasoning a
skeleton alone can't convey. (Scenario format — Steps/Expected, altitude, where each scenario lives
— is owned by `references/test-scenarios.md`; not restated here.)

### plan.md rules

- **Acceptance Criteria** are system-level, whole-feature outcomes only — never a per-phase task.
- **`## System E2E Tests`** is the home only for **cross-slice** end-to-end flows: journeys that
  only exist once several slices are assembled, so no single phase can run them (see the containment
  test in Step 4). Under vertical slicing each phase is itself an end-to-end capability, so most E2E
  flows are *phase-level* and live in that phase's `### E2E`; this section holds only the genuinely
  cross-slice journeys (e.g. register **then** log in **then** reach a protected page — chaining
  three independently-built slices). If this section swells with flows each fully runnable inside one
  phase, the phases
  were sliced horizontally — re-slice. Do **not** put E2E environment/harness setup here
  (docker-compose, the build-and-run command, the browser-driver command) — that belongs in the
  project's CLAUDE.md, not the plan.
- plan.md carries **no** Unit/API scenarios — those live in the phase files.

### phase-N.md rules

The phase header is `# Phase N (<tag>): <title>`, where `<tag>` names the **capability/slice** the
phase delivers (`register`, `login`, `token-refresh`), **not** the repo or layer — a vertical slice
spans layers, so a repo/layer tag would misdescribe it and re-encode horizontal slicing. Name the
repos a slice touches *inside* `## Implementation` (each step names its files), not in the header.
The `<title>` states the user-visible capability ("a user registers and the account exists"), not
a layer. (Only for a genuinely single-layer plan — every phase lands in one repo — may `<tag>` be
the layer `api`/`ui`; pick one convention per plan and use it consistently.)

A phase file has exactly **four body sections** — `## Overview`, `## Implementation`,
`## Test Scenarios`, `## Commit` — plus the header. Each answers **one question and only that
question**; this disjointness is what keeps the file free of the restatement a "fill every box"
template forces. Do **not** add a Step Graph, a "What to build", a "Done When", or an
"E2E Verification" section — each paraphrases another section or forces a hollow end-to-end claim
onto a phase that owns none. The `tdd` skill handles RED-GREEN-REFACTOR during execution.

**Section responsibilities (do not let one bleed into another):**

| Section | Answers only | Must NOT contain |
|---|---|---|
| header | what phase this is, what it depends on | behavior, files, a prose summary |
| `## Overview` | *why* this phase exists — its purpose and what it enables | file lists, step-by-step how, scenario prose, a restated phase-graph label |
| `## Implementation` | *how* the change is made, as ordered steps naming the files each touches | scenario prose, done-criteria, purpose/why |
| `## Test Scenarios` | *what behavior* proves it works — Unit/API, plus the phase-level `### E2E` the slice runs on its own code (a vertical slice almost always owns one) | file lists, implementation how, cross-slice E2E flows (those go in plan.md) |
| `## Commit` | the commit message | — |

- **Overview is purpose, not a build summary.** One or two sentences: what the phase is *for*, why
  it is its own phase, what it unlocks. It must add context no other section holds — not a reworded
  phase-graph label, not a narration of the steps. If it starts naming files or listing behaviors,
  cut it back to the "why."
- **Implementation is ordered steps, not one paragraph.** Each step: a short bold action title, then
  the file(s) it creates/modifies and the approach/content, in one or two sentences — enough to act
  on. A test-file step states what it sets up, what it asserts, and what that proves; a bare
  "Create: foo.test.ts (Vitest)" is not acceptable. Order steps the way the work unfolds. Include a
  code block under a step only for genuinely non-obvious logic (a tricky algorithm, an easily
  mis-implemented rule); routine code is left to the TDD cycle.
- **Test Scenarios** carries `### Unit` / `### API`, and a `### E2E` for the flow this phase can run
  entirely on its own code — which a vertical slice almost always has, since the slice *is* an
  end-to-end capability; a slice with no phase-level E2E is a signal it may have been sliced
  horizontally. Only a genuinely cross-slice flow goes to plan.md's System E2E Tests (see the
  containment test in Step 4). Show only the subsections the phase has. A non-scenario gate (e.g.
  "no hardcoded regex") folds into a scenario's Expected, not a separate checklist.

---

## @fix Tags

Annotate phase files with `@fix` tags to mark what needs changing. The agent reads
the tags, applies changes, and removes them.

**Format:** `<!-- @fix: description of what needs to change -->` — placed directly above the
content that needs updating. See `references/plan-template.md` ("@fix Tag Examples") for worked
examples.

When processing: collect all `@fix` tags, summarize changes to user, apply them,
remove tags. If fixes change phase structure, update plan.md too.

---

## Integration with Other Skills

**From brainstorm:** Read the design doc/spec, focus on codebase exploration,
interactive Q&A, and phase design.

**To execution:** After plan approval, work through phases in dependency order.
Load each phase-N.md, use the `tdd` skill for RED-GREEN-REFACTOR, commit after
each cycle. Update phase status as they complete. User can say "implement through
phase 3" to set a stopping point.

**Parallel sessions:** Session A implements phases 1-2 while Session B refines
phase-3.md and phase-4.md with `@fix` tags or direct edits.

**Tasks:** Create one task per phase with dependency relationships matching plan.md.
Update status as phases complete.
