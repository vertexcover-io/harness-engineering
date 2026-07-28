---
name: planning
description: >
  Implementation planning for features, design documents, and multi-step tasks. Use whenever
  code work needs a plan before writing code — from a design document, a feature request, a
  bug fix, or any non-trivial task. Trigger on "plan", "create a plan", "implementation plan",
  "break this down", "how should we implement", or when moving from an approved design to
  execution. Runs on every change brainstorm's triage routes here; only planning's own gate
  (after recon) may route atomic work to `implement`.
---

# Planning — slice the design into buildable phases

Produces `.harness/<name>/plan.md` plus one `phases/phase-N.md` per slice. A **slice** is a
vertical capability cut through every layer it touches — independently buildable, demoable,
and provable end to end. Never a layer, never a repo.

**The plan is a document a person reads, not only an agent's checklist.** Write for a
competent reader who has not seen this code: neither note-form density nor padded
restatement. Every implementation step must be understandable without opening the codebase.

Input is `design.md` + `dossier.md` when brainstorm ran, otherwise the prompt or PRD. `<name>`
comes from the pipeline (`SPEC_NAME`) when orchestrate invokes; standalone, derive a short
kebab-case name from the topic.

**Establish the requirement namespace before anything else.** The design carries decisions, not
requirements — extract `R#` functional, `NF#` non-functional, `EC#` edge cases from the PRD (or
the prompt, when there is no PRD) into plan.md's `## Requirements`. Without ids the Test Matrix
has nothing to join against.

Each `R#` takes one of five EARS shapes:

- **Ubiquitous:** The system SHALL `<response>`.
- **Event-driven:** WHEN `<trigger>`, the system SHALL `<response>`.
- **State-driven:** WHILE `<state>`, the system SHALL `<response>`.
- **Unwanted behaviour:** IF `<condition>`, THEN the system SHALL `<response>`.
- **Optional feature:** WHERE `<feature is present>`, the system SHALL `<response>`.

One sentence of intent plus at most one qualifier. A requirement specifying two outcomes states
the intent and records the fork as a question. **Banned inside a requirement** — each hides an
unmade decision: *fast, quickly, easy, simple, robust, appropriate, reasonable, efficient,
user-friendly, seamless, flexible, scalable, as needed, etc., and/or*. Replace with a number, a
named actor, or a fork.

A PRD whose acceptance criteria are already testable needs transcribing, not rewriting — carry the
criterion's wording and cite its story id, so nothing drifts between the two documents.

## Recon — before any slice exists

Read the dossier first (its quotes are already verified), then explore **only** what the
chosen approach touches. Depth scales: minor → 2-3 files, no sub-agents; major → at most 2
`Explore` agents plus direct `Glob`/`Grep`. Walk `../_shared/lenses.md` in review mode over
the decided shape — findings land in the plan, or as questions, nowhere else.

Four required outputs, each landing in a named plan section:

1. **Patterns to follow** — the files whose shape new code should match.
2. **Reuse verdicts** — for each thing the design says to build: does something already do
   this? Extend, wrap, or build new, with the reason. The abstraction call is decided against
   `code-quality`'s extraction gate — cite it, don't restate it.
3. **Debt in touched files** — pre-existing problems in code this plan will modify, using
   `tech-debt-finder`'s severity and category vocabulary. Each gets one disposition:
   **fix in slice N** (blocks the work) · **fix after** (real but separable) · **leave**
   (the default, with a reason). Nothing is silently inherited. Only files this plan
   modifies — anything wider is `tech-debt-finder`'s job.
4. **Verified execution preconditions** — how this actually runs: the dev/test command,
   whether the worktree's dependency layout works with it, which env file loads, which
   services must be up. Checked in the environment or explicitly marked unverified — an
   asserted-but-unchecked "the server starts with X" is a landmine a coder builds on.

**Verify before claiming absence:** any claim that something is absent — no such helper, no
such config — is checked against the code or labeled an unverified assumption.

## Is a plan warranted? — fires after recon, never before

You cannot know a change is atomic until you have looked at the code it touches. Hand
straight to `implement`, with no plan doc, when **all** hold: one file · one obvious edit ·
nothing to sequence · no test-level judgment to make. *"Fix the typo in README line 47."*

Everything else gets a plan, and **the bias is toward writing one** — a thin plan on small
work is mild ceremony; skipping one that was warranted hands the coder a change with no slice
boundary, no test matrix, no debt disposition. A plan for a two-slice change is half a page.

When this gate routes to `implement`, the recon findings go into the hand-off prompt — they
were the expensive part and they don't stop being true because no file was written.

## Questions — when recon surfaces what the design didn't settle

Ask when recon finds a new fork or contradicts a design assumption — never to re-litigate a
decision the design already closed. Always `AskUserQuestion`, with a recommendation and its
one-clause why, recommended option first, labeled `(Recommended)`. Resolve all questions
before slicing. In `--auto`, ask nothing: findings land in the plan and surface at the report.

## File decomposition — before slicing

Map which files will be created or modified and what each is responsible for. Files that
change together live together; split by responsibility, never by technical layer. This lands
in `## Codebase Context` as a create/modify table — drawn **before** the slices, because
slices drawn from a feature list with files assigned afterwards reliably produce two slices
editing the same file for different reasons, and a collision the graph said was parallel-safe.

## Slicing

Each phase is one slice: one coder dispatch, one TDD cycle (RED-GREEN-REFACTOR), one commit.
A slice needing many cycles is two capabilities — split it.

- **The anti-horizontal test: can you write the title?** Every phase title states a
  demonstrable capability — *"an account can be created and read back with no password
  exposed"*. A title that only names a layer or repo ("db: schema", "api: endpoints") names
  no capability and fails — re-slice around the capability it serves.
- **Walking skeleton first.** Slice 1 is the thinnest path touching every layer once with a
  visible result. Shared plumbing rides inside the first slice that needs it. A separate
  foundation slice is justified only when 2+ later slices provably depend on it *and* folding
  it into slice 1 would couple slice 1 to slice 2's needs.
- **Reachable — no orphaned code.** Every slice, when it lands, is reachable from a real
  entry point and provable end to end. A module nobody calls until slice 6 is not a slice —
  fold it into its first consumer.
- **One mechanism, one slice.** A generic mechanism (config-driven builder, per-case-free
  renderer) handles every data case at once — the second locale or third record type is the
  same capability with different data. Keep the cases in the slice that builds the mechanism;
  prove each with its own scenario. Split only when a case needs genuinely new production code.
- **Sizing by reviewability:** a slice is the smallest unit that carries its own test cycle
  and is worth a fresh reviewer's gate. Fold setup, config, and doc steps into the slice whose
  deliverable needs them. Typical: 2-4 slices small, 4-8 large; more than ~8 means the feature
  should have been decomposed at brainstorm.
- **Phase-ID stability.** Once assigned, never renumbered. Splitting keeps the original id on
  the original concept; deletion leaves a gap. Gaps are fine — renumbering silently invalidates
  every claims file, DAG node, and review reference pointing at the old number.

Two slices that modify the same file are not independent, whatever the capability graph says —
order them or merge them.

## Scenarios and the Test Matrix

Derive scenarios for the whole feature first, then place each — **read
`references/scenarios.md` before deriving**; without the behavioral contract loaded,
scenarios assert private helpers and call order, and break on the first refactor while the
feature still works.

Record the join in plan.md's `## Test Matrix`, one row per requirement:

| Requirement | Level | Where it's proven | Slice |
|---|---|---|---|
| `R1` | unit | `S1` | 1 |
| `R5` | e2e (phase) | `S9` | 2 |
| `NF2` | functional-verify | flow: *"a user reconciles a half-rupee gap"* | — |

Five levels: `unit` · `api` · `e2e (phase)` · `e2e (system)` · `functional-verify` (a
human-observable property no automated test can assert). Choose the level by
`tdd/references/integration-e2e.md`'s heuristic — the lowest level that gives the confidence
needed. Scenario ids `S<n>` are globally unique across the plan; each is written out once in
its home file — its phase file, or plan.md's `## System Verification` for a cross-slice flow —
with its `(traces to …)` tag. An `e2e (system)` row's Slice column names the slice completing
the journey: that slice's coder authors and runs the flow, and its phase file says so in one
line. **A requirement with no row means the plan is incomplete or the requirement isn't real —
both are findings.**

## Write the documents

**Read `references/plan-sections.md` before writing.** Without the section contract and step
shape loaded, steps collapse back into "modify X to do Y" prose and file references back into
bare paths — the two failures that make a plan unreadable without the codebase open.

The two rules worth carrying here because every step hits them:

- **A step changing existing code quotes the current code, then describes the change.** The
  quote orients; the prose states the change. A new file gets Contract + Logic, no quote —
  there is no "before" to show.
- **Every file reference names what's there:** `src/services/user.ts:34 — createUser, the
  insert path`. Path leads (click-detection needs it), the naming clause follows.

## Self-review — four checks, inline

1. **Matrix coverage** — every `R#`/`NF#`/`EC#` has a row; every row names a slice or a
   system test. Fill or flag gaps.
2. **Reachability** — walk the phases in order: at the end of each, is its deliverable
   reachable from a real entry point and provable? A failing slice is folded or re-sliced.
3. **Consistency** — the same name means the same thing in every file: no placeholders
   (`TBD`, "handle edge cases"), no reference to a type or function no slice builds, every
   `builds:`/`needs:` entry resolving to the outline's signatures.
4. **Clarity** — re-read as a reader who has not seen this code: every requirement
   represented, every slice followable without opening the codebase, every quoted region
   sufficient to picture its change. This is the check the other three can't substitute for —
   they prove the plan is right; this proves it is readable.

Findings are `[slice N, step M]: <issue> — <why it matters>`; blocking issues hold the gate,
recommendations never do.

## Approval gate

Present the structure outline, the matrix, and the debt dispositions. One `AskUserQuestion`.
In `--auto`, auto-approve. After any revision the user asks for, integrate it, re-present
what changed, and wait for explicit approval — a revision is not a confirmation.

## Hand-off

On approval, phases execute in dependency order — orchestrate dispatches one coder per phase
file (the `tdd` skill owns the cycle), or the user works through them directly. Parallel
sessions may refine later phase files while early ones are built.

| Excuse | Reality |
|---|---|
| "The design already says this" | Then cite it — `design.md#section`. The plan holds what planning added: slices, matrix, dispositions. |
| "This slice is obvious, skip the scenarios" | The scenarios are the definition of done. A slice without them cannot prove itself. |
| "I'll note the file's debt but not decide" | Every debt item gets a disposition. Undecided is silently inherited. |
| "The reader can open the file" | The reader is reviewing, not spelunking. Quote the region; name what's at the path. |
| "One more section would make it complete" | The section list is closed. New content goes in an existing section or it doesn't go. |
