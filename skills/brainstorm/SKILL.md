---
name: brainstorm
description: >
  Structured brainstorming and design exploration for deep problem understanding before implementation.
  Use this skill whenever the user says "brainstorm", "think through", "explore this problem",
  "let's think about", "what are the angles", "help me understand", "design this", or wants to
  deeply analyze a problem, feature, architecture decision, or technical challenge before writing
  code. Also trigger when the user is about to jump into implementation of something non-trivial
  and hasn't explored the problem space yet — a gentle nudge toward brainstorming prevents
  wasted effort from unexamined assumptions. This skill is about understanding the problem deeply
  and producing an approved architectural design, not writing code.
---

# Brainstorm: Deep Problem Understanding and Design

This skill has two jobs that work together:

1. **Deep problem understanding** — explore the problem from every angle, surface hidden
   assumptions, identify what hasn't been considered, and build genuine comprehension.
2. **Design synthesis** — produce an architectural design before implementation
   begins. The design stays at the conceptual and architectural level, never descending
   into code-level detail.

Understanding feeds design, and designing reveals gaps in understanding. But the emphasis
is weighted toward understanding. A thorough exploration naturally produces a good design;
a rushed design without understanding produces rework.

**Note:** No code, scaffolding, or implementation occurs during brainstorming — this skill
produces a design document, then flows directly into the next pipeline stage.

## Depth Scaling

Not every problem needs the same depth. Scale the brainstorming to the problem:

- **Minor changes** (small feature, bug fix): Phases 1-2 can be a single round of
  questions. Phases 3-5 can be a brief risk check and a short design summary. The
  design document can be a few paragraphs.
- **Medium changes** (new feature, moderate refactor): Run all phases but keep each
  focused. Design document covers the key sections without exhaustive detail.
- **Major changes** (new system, architectural redesign, multi-tenancy): Run every
  phase at full depth. Use all exploration techniques. Produce a thorough design document.

When in doubt, start shallow and go deeper if the exploration reveals hidden complexity.

## Core Principles

### 1. Understand Before Solving

The instinct to jump to solutions is strong. Resist it. A well-understood problem often
reveals its own solution. A poorly-understood problem leads to building the wrong thing
efficiently.

### 2. Surface What's Hidden

The most dangerous assumptions are the ones nobody knows they're making. Actively probe for:
- Unstated constraints ("we assumed this runs on a single machine")
- Implicit requirements ("users obviously need to undo this")
- Hidden dependencies ("this only works if service X is available")
- Edge cases that seem unlikely but would be catastrophic

### 3. Multiple Perspectives

Every problem looks different depending on where you stand. Consider the view from:
- The end user
- The developer maintaining this in 6 months
- The system under load / at scale
- Adjacent systems that interact with this
- Security and abuse scenarios
- Failure and recovery modes

### 4. Thinking Gaps Over Solutions

It's more valuable to identify what we *haven't* thought about than to refine what we
have. A brainstorming session succeeds when it surfaces questions nobody had asked yet.

### 5. Design at the Right Level

The design is architectural and conceptual — component relationships, data flow,
boundaries, contracts, and trade-offs. It should make clear *what* the system does,
*why* it's structured that way, and *where* the key boundaries are — without prescribing
*how* each piece is coded. If you're writing pseudocode, you've gone too deep.

## The Brainstorming Flow

### Phase 1: Context Gathering

Start by understanding what already exists and what prompted this exploration.

**Actions:**
- Review relevant files, documentation, and recent changes in the codebase
- Read any linked issues, specs, or prior discussions the user references
- Build a mental model of the current state

**Questioning approach:** Begin with small batches (2-3 related questions) to efficiently
establish context. Focus on: what triggered this, who is affected, and what success
looks like. **Always use the `AskUserQuestion` tool** to ask questions — never embed
questions in plain text output. This ensures the user sees a clear interactive prompt
and the conversation blocks until they respond.

### Phase 2: Problem and Requirements Exploration

Go wide — map the full problem space and discover what's actually needed. Requirements
rarely arrive complete; draw them out through exploration.

**Problem space:**
- Map out all facets of the problem
- Identify stakeholders and their potentially conflicting needs
- Surface constraints (technical, organizational, temporal, budgetary)
- Look for analogous problems that have been solved before

**Functional requirements** — what the system must do:
- Core behaviors, input/output expectations, business rules, integration points

**Non-functional requirements** — qualities the system must have:
- Performance, scalability, reliability, security, observability, maintainability

**Edge cases** — actively hunt for these:
- Boundary conditions (empty inputs, maximum sizes, concurrent access)
- Dependency failures (network down, service unavailable, bad data)
- Unexpected user behavior (rapid actions, stale state, back-button)
- Time-based concerns (data growth, schema evolution, version migration)

**Questioning approach:** Switch to one question at a time for deeper exploration.
Use multiple-choice when possible to reduce cognitive load. **Always use the
`AskUserQuestion` tool** for each question — this guarantees interactive flow where
the user must respond before exploration continues.

**Structured exploration techniques:**
- **Assumption surfacing:** "What are we assuming is true here? What if it isn't?"
- **Pre-mortem:** "Imagine this ships and fails badly. What went wrong?"
- **Constraint inversion:** "What if we removed constraint X? What would change?"
- **Scope probing:** "What's the smallest version of this that delivers value?"
- **Dependency mapping:** "What else in the system does this touch or depend on?"

### Phase 3: Architectural Challenges

Identify the hard structural problems that shape the entire solution.

Consider:
- **Boundaries and interfaces:** Where do components start and end? What are the
  contracts between them?
- **Data flow and ownership:** Where does data originate, how does it move, who
  is the source of truth?
- **State management:** Where does state live? How is it synchronized?
- **Concurrency and ordering:** Are there race conditions? Does ordering matter?
- **Evolution and migration:** How does this change over time? Can we migrate
  incrementally?
- **Integration seams:** Where does this connect to existing systems? Are those
  interfaces stable?

### Phase 4: Approach Comparison

Present 2-3 distinct approaches. For each:
- **Core idea:** What's the fundamental strategy?
- **How it addresses requirements:** Map back to functional and non-functional needs
- **How it handles identified edge cases:** Be specific
- **Architectural trade-offs:** What does this approach make easy? What becomes hard?
- **Risks:** What could go wrong? What's the blast radius?
- **Effort and complexity:** Relative comparison, not time estimates

Include a recommendation with reasoning, but hold it loosely.

### Phase 5: Gap Analysis

Before producing the design, explicitly check for thinking gaps:

- **Blind spots:** What haven't we discussed?
- **Open questions:** What needs more investigation?
- **Unvalidated assumptions:** What are we taking on faith?
- **Biggest risks:** Ranked by impact and likelihood.
- **Decision reversibility:** What would change our mind?
- **Uncovered edge cases:** Review edge cases from Phase 2 against the chosen approach.

### Phase 6: Design Synthesis and Documentation

Produce the design document. Read `references/design-template.md` for the full template.
Save to `docs/plans/YYYY-MM-DD-<topic>-design.md`.

The document covers: Problem Statement, Context, Requirements (functional, non-functional,
edge cases), Key Insights, Architectural Challenges, Approaches Considered, Chosen Approach,
High-Level Design, Open Questions, Risks and Mitigations, and Assumptions.

Save the design document and proceed directly to the next stage (spec generation or
implementation planning). No approval gate — the design flows through.

## Handling Code-Level Problems

When the problem IS about code (refactoring, bug investigation, performance):

- Reading and analyzing existing code is exploration, not implementation — do it freely
- The brainstorming phases still apply, but context gathering involves reading code
- The "design" is about *what* changes structurally (which components, interfaces, data
  flows) — not the specific code changes
- Still resist fixing things during brainstorming — understand the full picture first

## Handling Pushback

If the user wants to skip phases, let them — but note what's being skipped and what
risks that introduces. The brainstorming should serve the user, not frustrate them.

If the user disagrees with the recommendation, explore why. Their context often reveals
factors you missed. A disagreement is an opportunity to surface hidden information, not
a problem to resolve.

If the user wants to go straight to implementation, that's their call — but make sure
they're making it consciously, not just skipping brainstorming out of habit.

## Anti-Patterns to Avoid

- **Premature solutioning:** Jumping to "here's how to implement it" before the problem
  is fully understood.

- **Single-perspective analysis:** Only thinking about the happy path, or only the
  developer's view. Rotate through perspectives.

- **Skipping for "simple" problems:** Simple-seeming problems harbor unexamined
  assumptions. The brainstorm can be brief, but it should still happen.

- **Ignoring non-functional requirements:** Performance, security, observability, and
  maintainability are where production problems actually live.

- **Treating edge cases as afterthoughts:** Edge cases found during brainstorming are
  cheap to address. Found in production, they're catastrophic.

- **Ignoring the user's energy:** If the user is engaged, follow their lead. If they're
  uncertain, provide more structure. Adapt depth and formality to what's productive.
