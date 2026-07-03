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

**What to explore:**

1. **Files that will be touched/extended** — find them, read them, understand their structure
2. **Data flow** — trace how data moves through the parts of the codebase this feature touches
3. **Existing patterns** — utilities, base classes, conventions that the implementation should follow
4. **Potential conflicts** — modules that share state, coupling risks, migration concerns
5. **Test infrastructure** — how similar features are tested, what fixtures and helpers exist
6. **E2E test infrastructure** — what e2e frameworks exist, what tests already cover, how backing services are started, what the dev server command is
7. **Dependencies** — what depends on what, what can run in parallel
8. **Library docs** — for external libraries the feature touches, use context7 or web search to check current API signatures and usage patterns

**Depth scaling** (match effort to change size):
- **Minor changes:** Quick scan of 2-3 files, skip parallel agents
- **Medium changes:** Thorough scan, use 1-2 parallel explore agents
- **Major changes:** Deep exploration, at most 2 parallel explore agents — use main-thread Glob/Grep for additional areas

Record findings — they go into plan.md's Codebase Context section.

### Step 3: Interactive Q&A

From the codebase exploration, identify implementation questions and resolve them with the user before designing phases. This ensures the planner starts with zero ambiguity.

**Question categories:**

**A. Implementation Approach**
- "The spec says X, but the codebase does Y — should we follow the existing pattern or change it?"
- "There are two ways to extend this — via Z or via W. Which do you prefer?"

**B. Integration Points**
- "This touches module M which also affects feature F — is that intentional?"
- "Should this reuse the existing utility at `path/to/util` or create a new one?"

**C. Edge Cases & Error Handling**
- "The spec doesn't cover what happens when X fails — should we retry, fail silently, or propagate?"

**D. Scope Boundaries**
- "Implementing REQ-003 would require changing the shared Z interface — is that in scope?"

**E. Technical Decisions**
- "What's the preferred approach for state management here — option A or option B?"
- "Should tests use real DB or mocks for this feature?"

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

**Read `references/test-scenarios.md` and follow it.** It is the authority on this step.

The essentials, so this is not skipped or done shallowly:

- Write each scenario as **Steps + Expected** — the ordered actions (an actor and a trigger), then
  the **observable outcome** at a stable boundary (UI, API response, index query, rendered output).
  One behavior per scenario (one capability per flow). Group scenarios into `### Unit` / `### API` /
  `### E2E` subsections in the phase file, showing only the non-empty ones.
- **Test behavior, not implementation.** Never let an assertion name a private function, an internal
  call order, or an intermediate data shape — those tests break on refactor and add no value. If the
  design or your draft phrases a test as "function X returns Y," rewrite it as the observable outcome
  a user or caller would see. (See the before/after rewrites in the reference.)
- **Derive systematically** from the source: every functional requirement → a happy-path scenario
  **and** its negative/failure scenario; every edge case → a scenario; every state transition
  (edit/update/re-index/delete, not just create) → a scenario; every cross-boundary transform → a
  round-trip scenario; config-/data-driven behavior → a scenario that varies the data.
- **Derive at two altitudes — atomic AND end-to-end flow.** Atomic scenarios (one trigger, one
  outcome, narrowest boundary) map to unit/API tests. But every user-facing capability that spans
  screens or services (create→save→reopen→render, edit→see-updated, save→search) **also** needs an
  **end-to-end flow scenario** — an ordered multi-step user journey through the running system,
  with checkpoints inline, proving the whole capability works. No-UI capabilities (search) get an
  **API flow scenario** instead. Give each entity/country variant its own flow. A plan of only
  atomic scenarios has not proven the feature works end to end. See `references/test-scenarios.md`,
  "Two altitudes."
- **Regression scenarios are mandatory when the plan touches shared code** — assert the old behavior
  is unchanged, even if the source doc names no such requirement. Add it and note the gap.
- **Trace every scenario** to a requirement / edge case / risk id. A scenario tracing to nothing is
  either implementation trivia (drop it) or a spec gap (flag it).

**Where scenarios live — split by altitude across two file kinds:**

- **Phase-scoped scenarios (`### Unit` and `### API`)** go into the **`phase-N.md` file that
  delivers that behavior** — one scenario in one phase, written out in full as a Steps + Expected
  block with its trace tag.
- **End-to-end flow scenarios (`### E2E`)** are placed by a **containment test**. Because each phase
  is a vertical slice that owns every layer its capability touches, a flow whose every step runs on
  **that one slice's own code** is *phase-level* and lives in that phase's `### E2E` subsection —
  the common case. Only a flow whose steps **cross slice boundaries** (it combines two
  independently-built capabilities, so no single phase can run it) is *system-level* and lives in
  **`plan.md`'s `## System E2E Tests` section**. See `references/test-scenarios.md`, "the placement
  rule," for the discriminator and worked examples.

During this step, first derive the whole set so you can check feature-wide coverage (every
requirement, edge case, risk, and regression), then distribute: atomic Unit/API scenarios to their
phase, and each E2E flow by the containment test (phase-level to its phase — the common case;
cross-slice to plan.md's System E2E Tests section). Number them globally (S1, S2, …) so the trace
tags stay unique across all files. **Write each scenario out in full where it lives; never restate it elsewhere and never
replace it with an "id-only" pointer like "see S4" — a reader must be able to read any one file top
to bottom without chasing ids across files.**

**Mandatory coverage-map pass (do not skip):** before writing the phase files, build an explicit
map pairing every source item — each requirement, edge case, risk, "shall not change" clause, and
**each named variant** of a capability — with the scenario id(s) covering it. This is a written
pass, not a mental one; it is what catches the coverage that a linear read misses (the 2nd/3rd
variant of a capability, the enforcement negative on each gated axis, the plain create-then-view,
the edit/re-index transition). Any item with no scenario is filled or flagged with a reason. This
map is a **working artifact for you only — it does not become a section in plan.md** (no audit,
coverage-map, or traceability-matrix section is written into any output file); coverage lives
implicitly in the per-scenario trace tags. See `references/test-scenarios.md`, "Coverage checklist."

### Step 5: Design the Phases

Each phase is a **vertical slice** — one thin capability cut through every layer it touches, from
the user's entry point to a user-visible outcome. It makes sense on its own, a user can exercise it,
and it can prove itself end to end. A phase typically follows one TDD cycle (RED-GREEN-REFACTOR)
resulting in one commit. Occasionally a complex slice may need multiple TDD cycles, each with its
own commit — but this should be rare. If a phase needs many cycles, it's probably two capabilities
and should be split.

**Slice vertically, never horizontally:**
- A phase delivers a **thin end-to-end capability a user can exercise** — e.g. "a user registers and
  the account exists: input validated → persisted → confirmable on read" — cutting through every
  layer it needs (data, service, endpoint/form, validation, response/render), not one layer across
  all capabilities.
- **Anti-horizontal rule:** a phase must not be "all of layer X." If a phase's title names only a
  repo or layer with no user-visible outcome ("db: schema", "api: validation", "ui: render"), it is
  a horizontal slice — re-slice it around the capability it serves. A phase spanning several repos to
  deliver one working capability is correct; several phases each confined to one repo is the
  anti-pattern.
- **Load-bearing-work rule — every phase must *build* something the feature needs, not merely
  exercise a prior phase.** Before keeping a phase, read its `## Implementation` and ask: *does it add
  new, non-trivial production code whose absence would make the feature not function?* If its steps
  are mostly "confirm X", "verify the prior phase's builder handles Y", "no change needed here" —
  with one stray real edit buried among them — it is **not a slice**; it is the prior slice's own
  test obligation wearing a phase costume. Fold it back: move its one real edit and all its scenarios
  into the phase that built the mechanism they exercise.
- **Do not split one mechanism across phases by data case.** When a slice builds a *generic*
  mechanism (a config-driven builder, a validator that reads a config, a renderer with no per-case
  branch), every data case it already handles — the second locale, one role vs. another, the third
  record type — is **the same capability with different data**, not a new capability. Splitting, say,
  "the endpoint for role A" and "the endpoint for role B" into two phases when one config-driven
  handler serves both cuts one mechanism in half, and the second phase is left with nothing to build
  but confirming the first. Keep all the data cases the mechanism covers in the **one** slice that
  builds the mechanism; prove each case with its own scenario there. Only split when the second case
  needs genuinely new production code (a different component, a new enforcement path, a distinct file
  the mechanism doesn't already cover) — and then the split is justified by *that new code*, not by
  the data.
- **The first slice is the walking skeleton** — the narrowest capability that touches every layer
  once and produces a visible result. Later slices thicken it and, being independent, mostly
  parallelize (see the foundation-phase exception in the skill intro before pulling shared plumbing
  into its own phase).
- Leaves codebase in a working state with all tests passing.
- Express dependencies as a DOT digraph in plan.md — nodes with no edges between them are independent.
  Vertical slices are far more independent than horizontal layers; expect a walking-skeleton node
  with a wide fan-out, not a strict layer chain.
- **Carries its own phase-scoped test scenarios** (Step 4): assign each derived **Unit/API**
  scenario to the phase that delivers its behavior, written as Steps + Expected (grouped by
  `### Unit` / `### API`, plus a phase-level `### E2E` — which a vertical slice almost always owns,
  since its whole point is a runnable end-to-end capability) in that phase file with its trace tag.
  **Only a genuinely cross-slice E2E flow goes to plan.md's `## System E2E Tests`** (see the
  containment test in Step 4); under vertical slicing that is the exception, not the norm. A phase
  has no separate Done-When section; the scenarios it carries *are* its definition of done.

**A test obligation is not a phase; only new behavior is.**
Before making something a phase, ask: *does it introduce new user-visible behavior, or does it only
assert existing behavior still holds?*
- **Regression / "still generic" / "unchanged" work is a test obligation of whichever slice touches
  that code — never its own phase.** A phase that only guards existing behavior (a standalone
  "legacy-locale regression" phase, a "confirm the shared renderer is still generic" phase) is the
  horizontal tell — it pulls "all the guard tests" out into their own layer, decoupled from the
  feature work that created the risk. Delete it as a phase and **fold its assertions into the vertical
  slice that actually touches the shared code**: a slice that changes a shared handler asserts the
  pre-existing callers of that handler still work *for the code it touched*. Each slice guards the
  regressions its own changes could break — no phase exists solely to hold guard tests.
- **New behavior belongs to the slice where it first becomes meaningful — folded in, not stranded.**
  Some work is a real capability but not independently valuable (e.g. a cross-row de-duplication rule
  means nothing until a record can hold multiple rows). Do not give it its own thin phase; fold it
  into the slice that first makes it meaningful. Only split a capability into its own phase when it is
  both genuinely independent and substantial enough to demo alone (it builds new production code in a
  file no other slice touches — see the load-bearing-work rule above).
This generalizes the confirm-and-guard rule below: under vertical slicing a pure test-only phase
almost always dissolves into the slice that builds (and therefore must guard) the code it covers.

**Steps within a phase:**
- A phase is decomposed by its file-level `## Implementation` work, not by a separate Step Graph.
  Do not add a Step Graph or per-step Files/Tests/Done blocks — those duplicate the Implementation
  bullets and the Test Scenarios. If sub-work is genuinely parallelizable, note it in one line of
  Implementation prose; the parallelism lives in the phase graph, not a nested step graph.

**When the owning repo has no test runner (data/schema/JSON-package phases):**
- Some phases deliver an artifact in a repo that cannot run tests (e.g. a raw JSON config package,
  a types-only package — `test` is `echo no-test`). The proving scenario runs in the **consumer**
  repo that imports the artifact and has a runner. Never invent a test runner for a repo that has
  none.
- **The scenario has exactly one home: the phase whose `## Implementation` builds the executing test
  (the consumer phase).** Write the scenario in full there, once. The producer phase (the one that
  ships the runner-less artifact) does **not** carry the scenario block — that would restate it in
  two files. Instead, the producer phase's `## Implementation` states plainly that the repo has no
  runner and, in prose, names where the behavior is proven (e.g. "the config's shape is exercised by
  the config-contract test built in Phase 2"). That prose is a locator, not a scenario copy and not
  an id-only pointer — the full scenario text still lives, once, in the consumer phase.
- If the artifact repo *does* have a runner, the scenario lives in that phase normally; this rule
  only applies when the producer repo cannot run tests.
- **When the runner-less producer is folded into its consumer slice** (common under vertical slicing —
  a shared config created inside the walking-skeleton slice that first reads it), producer and
  consumer are the *same phase*: create the artifact in one Implementation step and prove it with the
  scenarios in that same phase. There is no separate producer phase and no locator prose — the
  distinct-producer-phase wording above applies only when they genuinely land in different phases.

**When an artifact is unchanged AND has no in-scope way to be proven — it is not a phase.**
- If a repo needs no production change *and* there is no in-scope consumer/test that would exercise
  it (e.g. a schema that is already generic, whose only consumer is out of scope), do **not** create
  a phase for it — a phase that changes nothing and can prove nothing is hollow. Record the fact as
  a **verified precondition in plan.md's Codebase Context** (e.g. "the shared persistence schema is
  already generic; no change needed"), not as a phase. Only make it a phase if there is real work or
  a real in-scope test to run.

**When a phase changes no production code (confirm-and-guard / regression-only phases):**
- **First check it should exist at all.** Under vertical slicing, a test-only guard almost always
  belongs *inside* the slice that touches the code it guards (see "A test obligation is not a phase"
  above) — fold it there rather than making it a phase.
- **"Touched" means *modified*; "exercised" means *run by a slice's end-to-end flow*. A guard folds
  into any slice that *exercises* the code — not only one that modifies it.** This is the distinction
  that decides most confirm-and-guard calls, so apply it before creating the phase. A generic
  downstream artifact (a renderer, a serializer, a formatter) that a slice does not *edit* but whose
  output *is the observable outcome of that slice's own end-to-end flow* is **exercised** by that
  slice: the slice must run through it to prove its capability is user-visible. Its coverage is that
  slice's E2E leg — write it as the render/output step of the slice's `### E2E`, not as a separate
  phase. Do not treat "the slice doesn't modify the renderer" as "no slice touches the renderer" —
  that mistake pulls the render back out into a standalone layer-phase and re-creates horizontal
  slicing. (Concretely: if the capability is "a value the user enters becomes visible downstream,"
  the downstream display is part of that capability's slice, generic or not.)
- Keep a standalone confirm-and-guard phase **only** when the guarded code is genuinely generic, is
  **neither modified nor exercised end-to-end by any slice in this plan** (no slice's flow runs
  through it to reach a user-visible outcome), yet the feature *relies* on its genericness and it
  currently has no coverage — a genuinely rare case where there is no slice to fold into. When that
  holds, it is a phase of the shape below; otherwise fold it in.
- A phase may exist purely to prove an already-generic capability still holds (add missing test
  coverage; no source change). Its `## Overview` states that purpose (why the guard exists). Its
  `## Implementation` first step states plainly that no production code changes — the
  component/schema is already generic — and the remaining steps describe the **test file(s)** (setup,
  assertions, what they prove), exactly like any other Implementation step. If a test surfaces a real
  gap, fixing it to stay generic is in scope and noted. Such a phase still has only the four body
  sections; it is simply Implementation-light and test-focused, not a different shape.

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
