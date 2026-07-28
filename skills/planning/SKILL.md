---
name: planning
description: >
  Turns a design, PRD, or feature request into an implementation plan — phases, contracts, and
  the test join, grounded in the actual code. Use whenever code work needs a plan before writing
  code. Trigger on "plan this", "break this down", "how should we implement", or when moving
  from a design to execution. Runs on every change brainstorm's triage routes here; only
  planning's own gate (after recon) may route atomic work to `implement`.
---

# Planning — ground the design in code, then divide it into phases

Produces `.harness/<name>/plan.md` plus one `phases/phase-N.md` per phase. A **phase** is a
vertical capability cut through every layer it touches — independently buildable, demoable,
and provable end to end. Never a layer, never a repo.

**The plan is a pre-code review surface.** Its job is to state the names, signatures, file
locations, and algorithms the change will use, so a reader can correct a wrong abstraction, a
missed piece of existing code, or a bad type while correcting is still cheap. A reader who has
seen the inputs but not the codebase should be able to follow every step without opening a file.

Input is `design.md` + `dossier.md` when brainstorm ran, otherwise the prompt or PRD. `<name>`
comes from the pipeline (`SPEC_NAME`) when orchestrate invokes; standalone, derive a short
kebab-case name from the topic.

**Cite the inputs; do not restate them.** When a PRD or design exists, it owns the problem,
the requirements, and the approach — and it owns their ids. Adopt those ids unchanged; a second
namespace means two documents drifting apart, and a plan that invents ids while claiming to
transcribe them is worse than one with none. Only when there is no requirements document does
planning establish `R#`/`NF#`/`EC#` itself (EARS shapes are a reasonable default), and then it
records them in `## Requirements` because the Test Matrix has nothing to join against otherwise.

## Recon — before any phase exists

Read the dossier first (its quotes are already verified), then explore **only** what the chosen
approach touches. Depth scales: minor → 2-3 files, no sub-agents; major → at most 2 `Explore`
agents plus direct `Glob`/`Grep`. Walk `../_shared/lenses.md` in review mode over the decided
shape — findings land in the plan, or as questions, nowhere else.

Recon's output is not a section. It is the raw material for the steps: which file each change
goes in, which existing thing it extends or replaces, what shape the new code takes, and what
in the existing code has to be repaired first. It lands where it is used.

Four disciplines, because each failure here is expensive downstream:

- **Reference nothing you did not open.** An inferred caller or an assumed helper sends the
  coder to edit code that does not need it, and poisons trust in every other reference.
- **Search the whole workspace before concluding something is absent.** Sibling repos,
  published packages, schema and config repos. "No such helper exists" is a claim, and a wrong
  one produces a duplicate of something that was already there.
- **Finish the recon rather than delegating it.** A step saying *find the callers*, *check
  whether*, *verify that*, or *grep for* is unfinished work handed to someone with less
  context. Resolve it, or name it as an open question.
- **Answer what the design deferred to planning.** A design that says "deferred to planning"
  has handed over an inbox. Leaving it unanswered loses it entirely.

## Is a plan warranted? — fires after recon, never before

You cannot know a change is atomic until you have looked at the code it touches. Hand straight
to `implement`, with no plan doc, when **all** hold: one file · one obvious edit · nothing to
sequence · no test-level judgment to make. *"Fix the typo in README line 47."*

Everything else gets a plan, and **the bias is toward writing one** — a thin plan on small work
is mild ceremony; skipping one that was warranted hands the coder a change with no phase
boundary, no test matrix, no debt disposition. A plan for a two-phase change is half a page.

When this gate routes to `implement`, the recon findings go into the hand-off prompt — they
were the expensive part and they don't stop being true because no file was written.

## Questions — asking is the default, deferring is the user's call

Ask when recon finds a fork the inputs didn't settle, contradicts a design assumption, or hits
something it could not resolve. Always `AskUserQuestion`, with a recommendation and its
one-clause why, recommended option first, labeled `(Recommended)`.

**Deferring is a decision the user makes, not one planning makes for them.** Writing an
unresolved fork into `## Deferred` unilaterally decides that it does not matter — and quietly
removes their chance to say it blocks the work. Resolve what you can, then put the remainder to
them. In `--auto`, ask nothing: findings land in the plan and surface at the report.

## Phasing

Each phase is one coder dispatch, one TDD cycle (RED-GREEN-REFACTOR), one commit.

- **The anti-horizontal test: can you write the title?** Every phase title states a demonstrable
  capability — *"an account can be created and read back with no password exposed"*. A title
  naming only a layer or repo ("db: schema", "api: endpoints") names no capability and fails.
- **Prefer fewer phases.** Two phases modifying the same file are not independent whatever the
  capability graph says — order them, and if neither is more than one sitting's review on its
  own, merge them. Also merge when a phase cannot be demonstrated without a later one, or when
  its only consumer is the next phase: both mean it was cut horizontally and dressed as vertical.
- **Walking skeleton first.** Phase 1 is the thinnest path touching every layer once with a
  visible result. Shared plumbing rides inside the first phase that needs it.
- **One mechanism, one phase.** A generic mechanism handles every data case at once — the
  second locale or third record type is the same capability with different data. Split only
  when a case needs genuinely new production code.
- **Explain a boundary the titles don't.** When the capability titles and the graph already show
  why a cut is where it is, saying so again is padding. When the reason is invisible — a shared
  file forcing an order, a merge that could have gone the other way, a split deliberately not
  made — one clause, because that is the decision a reviewer would otherwise have to guess at.

Typical: 2-4 phases small, 4-6 large. More than that usually means the feature should have been
decomposed at brainstorm, or that phases were split along layers.

Renumber freely while planning — merging and splitting are the point of this stage. After
approval the numbers are referenced by commits and review artifacts, so from then on a split
keeps the original id on the original concept and a deletion leaves a gap.

## Scenarios and the Test Matrix

Derive scenarios for the whole feature first, then place each — **read
`references/scenarios.md` before deriving**; without the behavioral contract loaded, scenarios
assert private helpers and call order, and break on the first refactor while the feature still
works.

Record the join in plan.md's `## Test Matrix`, one row per requirement: **requirement · level ·
strategy · phase**. Five levels: `unit` · `api` · `e2e (phase)` · `e2e (system)` ·
`functional-verify` (a human-observable property no automated test can assert). Choose by
`tdd/references/integration-e2e.md`'s heuristic — the lowest level giving the confidence needed.

The strategy column is what makes the matrix worth reading: what is faked, what is diffed, what
is driven by data rather than asserted against a constant. That is where a wrong test comes
from, and it is reviewable before any test is written.

**Each scenario is written out exactly once.** Per-phase scenarios live in their phase file;
flows provable only after every phase lands live in plan.md's `## Acceptance`, and the phase
completing the journey notes in one line that it owns them. The matrix points at scenarios and
never restates them — a row summarising a scenario body is duplication that will drift.

A requirement with no row means the plan is incomplete or the requirement isn't real — both are
findings.

## Writing the documents

**Read `references/plan-sections.md` before writing.** It carries the section triggers, the
step shape, and the quoting rules.

Two habits decide whether the result is readable, and both run against instinct:

- **Describe each thing where it is implemented.** A reuse verdict, a pattern being followed, an
  alternative rejected — each belongs in the step it governs, as a clause. Collected into a
  standalone section they detach from the work and duplicate into the phase files. The one
  exception is anything crossing phase boundaries: phases are built in isolation, so a name used
  in one and defined in another needs a flat index.
- **State the problem before the decision.** A decision written as a conclusion reads as
  authoritative and transmits nothing. Introduce each domain noun in plain words before using it
  as a term, and name concrete values when describing a failure mode. A three-line entry on a
  subtle decision is a warning sign, not brevity.

Omit any section with nothing to say — the reference carries the trigger for each. A reader who
finds two sections of filler stops trusting the third.

## Self-review — five groups, inline

Each check is a lookup rather than a judgment, because the judgment version ("is this
contestable enough to mention?") is exactly what a model gets wrong. Findings are
`[phase N, step M]: <issue> — <why it matters>`; blocking issues hold the gate, recommendations
never do.

**Against the inputs.** Every cited id resolves in the document named · every design decision
appears in a step, in `## Design corrections`, or in `## Deferred` · no decision is reversed
without saying so · every repo and dependency the inputs name is touched by a phase or
accounted for · every question the design deferred to planning is answered or put to the user.

**Phasing.** No two phases modify the same file unless ordered · every phase is provable by its
own scenarios at the moment it lands · a phase consuming what a "parallel" phase builds is not
parallel.

**Step content.** Every step states a location, a contract, or an algorithm · no step instructs
the coder to discover something · no call site is described in prose where the changed lines
would fit.

**Coverage.** Every requirement has a matrix row · every row names a phase or an acceptance
flow · every scenario appears exactly once across all documents.

**Readability.** Re-read the densest step cold: can a reader who has seen the inputs but not the
code restate what it does and why? Then walk the sections — does each hold content meeting its
trigger, or is it present because a template listed it? This is the group the other four cannot
substitute for: they prove the plan is right, this proves it is usable.

## Approval gate

Present the phase list with its reasoning, the matrix, and anything recon overturned. One
`AskUserQuestion`. In `--auto`, auto-approve. After any revision the user asks for, integrate
it, re-present what changed, and wait for explicit approval — a revision is not a confirmation.

## Hand-off

On approval, phases execute in dependency order — orchestrate dispatches one coder per phase
file (the `tdd` skill owns the cycle), or the user works through them directly. Parallel
sessions may refine later phase files while early ones are built.

Three rationalisations end plans early. They feel like judgment and are not:

| Excuse | Reality |
|---|---|
| "I'll flag it for the coder to check" | The coder has less context than you do — that is why the plan exists. Finish the recon or ask the user. |
| "This is minor, I'll just defer it" | Minor to whom? Deferring spends someone else's risk budget. |
| "One more section would make it complete" | Completeness is every requirement placed and every decision grounded, not every heading present. |
