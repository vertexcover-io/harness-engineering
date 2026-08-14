# Phase design — cutting phases, placing tests, reviewing the plan

## Cutting phases

A **phase** is a vertical capability cut through every layer it touches — independently
buildable, demoable, and provable end to end. Never a layer, never a repo. Each phase is one
coder dispatch, one TDD cycle (RED-GREEN-REFACTOR), one commit.

- **The title test.** Every phase title states a demonstrable capability — *"an account can be
  created and read back with no password exposed"*. A title that names only a layer or repo
  ("db: schema", "api: endpoints") fails.
- **Prefer fewer phases.** Two phases that modify the same file are not independent — order
  them. Merge them when each is small enough that a reviewer would read both in one sitting.
  Also merge when a phase cannot be demonstrated without a later one, or when its only
  consumer is the next phase.
- **Walking skeleton first.** Phase 1 is the thinnest path that touches every layer once with
  a visible result. Shared plumbing rides inside the first phase that needs it.
- **One mechanism, one phase.** A generic mechanism handles every data case at once — the
  second locale or third record type is the same capability with different data. Split only
  when a case needs new production code.
- **Explain a boundary the titles don't.** When a cut's reason is invisible — a shared file
  forcing an order, a merge that could have gone the other way — give it one clause.

Typical: 2-4 phases small, 4-6 large. More usually means the feature needed decomposition at
the checkpoint, or the phases were cut along layers.

Renumber freely while designing. After approval the numbers are referenced by commits and
review artifacts: a split keeps the original id on the original concept, and a deletion leaves
a gap.

## Scenarios and the test matrix

Derive scenarios for the whole feature first, then place each — **read `scenarios.md` (sibling
file) before deriving**. Without its behavioral contract, scenarios assert
private helpers and call order, and break on the first refactor while the feature still works.

Record the join in plan.md's `## Test Matrix`, one row per requirement: **requirement · level ·
strategy · phase**. Five levels: `unit` · `api` · `e2e (phase)` · `e2e (system)` ·
`functional-verify` (a human-observable property no automated test can assert). Choose by
`../../tdd/references/integration-e2e.md`'s heuristic — the lowest level that gives the confidence
needed. Its three categories map onto the five levels: its `unit` is `unit`; its `integration`
covers `api` and `e2e (phase)`; its `e2e` is `e2e (system)`. `functional-verify` sits outside
it — no automated level can assert those rows.

The strategy column is what makes the matrix worth reading: what is faked, what is diffed,
what is driven by data rather than asserted against a constant. A wrong test comes from a
wrong strategy, and the strategy is reviewable before any test is written.

**The level states what gives confidence, never what the code permits.** Run the counterfactual
on each row: *if this behavior sat in a plain function, which level would prove it?* When that
answer is lower than the level you wrote, the gap is the shape of the code, not the nature of
the behavior. Say so — the shape is a `## Blockers in existing code` entry, and a phase step
fixes it. Never let an untestable unit set the plan's test level and go unnamed.

**Red flag — an `e2e (system)` heavy matrix.** Count those rows. Past a third of the matrix,
stop and account for every one:

- a real-browser fact — computed layout, focus, navigation, a cross-service journey — is at the
  right level. Keep it.
- render logic, a branch on state, a mapping, a permission gate — is at the wrong level.
  Something cannot be rendered or called on its own. Find it, name it as a Blocker, and give a
  phase the step that extracts it.

The count is the tell, not the verdict. A ticket that is mostly CSS and layout earns browser
rows honestly. Browser rows that assert *which items a list renders* mean the list is trapped
inside something no test can construct.

Two traps that push rows upward for the wrong reason. Check both before accepting a level:

- **The harness gap.** A level is unavailable because a library is missing or a helper does not
  exist yet — not because the code resists it. Adding the dependency is a step, not a reason to
  climb.
- **The environment lie.** A level looks available but cannot answer the question. jsdom reports
  zero for every measurement, so a size, a truncation or an overflow belongs in a browser however
  small the unit is. Moving *down* to a level that cannot see the property is as wrong as
  staying up.

Per-phase scenarios live in their phase file. Some flows are provable only after every phase
lands: those live in plan.md's `## Acceptance`, and the phase that completes the journey
notes that in one line, then authors and runs them.

A requirement with no row means the plan is incomplete or the requirement is not real — both
are findings.

## Two writing habits for the payloads

- **Describe each thing where it is implemented.** A reuse verdict, a pattern being followed,
  a rejected alternative — each belongs in the step it governs, as a clause. The one
  exception: anything crossing phase boundaries. Phases are built in isolation, so a name used
  in one phase and defined in another needs the flat signature index.
- **State the problem before the decision.** Introduce each domain noun in plain words before
  using it as a term. Name concrete values when describing a failure mode.

Omit any section with nothing to say — `plan-sections.md` carries the trigger for each.

## Self-review — five groups, before the plan gate

Each check is a lookup, not a judgment. Findings are
`[phase N, step M]: <issue> — <why it matters>`. A finding is **blocking** when a check in
the five groups below fails; everything else is a recommendation. Blocking findings hold the
gate; recommendations never do.

**Against the inputs.** Every cited id resolves in the document named · every recorded
decision appears in a step, or `design.md` (when it exists) was updated to supersede it · no decision is reversed without
saying so · every repo and dependency the inputs name is touched by a phase or accounted for.

**Phasing.** No two phases modify the same file unless ordered · every phase is provable by
its own scenarios at the moment it lands · a phase consuming what a "parallel" phase builds is
not parallel.

**Step content.** Every step states a location, a contract, or an algorithm · no step
instructs the coder to discover something · no call site is described in prose where the
changed lines would fit.

**Coverage.** Every requirement has a matrix row · every row names a phase or an acceptance
flow · every scenario appears exactly once across all payloads · `e2e (system)` rows are under a
third of the matrix, or every row above that share is either a real-browser fact or traced to a
named Blocker with a phase step that fixes it.

**The two layers agree.** Re-read the rendered sections cold — the browser view is not
available to you. Every number, name, signature, and path in the human layer comes from a
payload block · every internal id on the page has a tooltip entry · the above-the-fold view
answers *what, why, what each phase unlocks* without a drill-down.
