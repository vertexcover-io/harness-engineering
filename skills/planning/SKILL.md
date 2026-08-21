---
name: planning
description: >
  One stage from idea to approved plan — grill the open forks, checkpoint the solution
  inline, then build plan.html for review. Use for
  code work that needs thought before code ("plan this", "how should we implement"), and to
  interrogate an existing design or PRD ("grill this idea"). Runs as orchestrate's
  design-and-plan stage. Atomic one-edit work routes to `implement` after step 1.
---

# Planning — understand, decide, confirm, plan

One skill, nine steps (0-8), two user touchpoints:

- **The checkpoint** (step 5) — one inline question that approves the solution *before* the
  expensive plan work starts. A wrong direction stops here and costs one question.
- **The plan gate** (step 8) — the only document review: `plan.html`.

Artifacts, all under `.harness/<name>/` (`<name>` is `SPEC_NAME` from the pipeline;
standalone, derive a short kebab-case name from the topic before step 1):

| File | Written | Read by |
|---|---|---|
| `design.md` | step 5 (full flow only), by a recorder sub-agent | code-review |
| `plan.html` | step 7 | the user — the review surface |
| `plan.md` + `phases/phase-N.md` | step 8, extracted from plan.html | coders, quality-gate |

People read the checkpoint summary and `plan.html`. Write those per
`../_shared/writing-style.md`. `design.md` is agent-only and skips the style rules. `plan.md`
and the phase files keep them: their steps are transcribed into `plan.html`, so a person reads
that prose too.

**Never assume.** State a claim about the code only after one of three things: you read the
code, the user confirmed it, or you labeled it an assumption.

**`--auto`** means orchestrate runs unattended; the flag arrives in the dispatch prompt. Each
touchpoint below states its `--auto` behavior.

## Step 0 — Scale the work

Pick the route before doing anything:

- **Full flow (steps 1–8)** when any holds: an unresolved fork with live alternatives · a new
  boundary, component, or contract · a user-facing surface with unstated behavior · an
  external dependency.
- **Short flow (steps 1, 6–8)** when all hold: the change stays inside existing code paths ·
  one obvious way to do it · acceptance criterion already stated. No checkpoint — the plan
  gate is the only pause — and no recorder, so this route produces no `design.md`. A rename
  across 30 files takes this route.
- **Hand to `implement`** — decided *after* step 1, never before: one file · one obvious
  edit · nothing to sequence · no test-level judgment. Pass the step-1 findings in the
  hand-off prompt.

Watch for work that sounds mechanical but is not: "add caching to this endpoint" hides four
open decisions — TTL, invalidation, key shape, backing store. Full flow.

When the call is close, take the full flow.

If the request spans several independently-shippable subsystems, split it and plan the first.
Do not split when the pieces share more than ~30% of files and ship together.

**Done when:** you can name the route and why in one line.

## Step 1 — Understand

- Read the PRD or input document fully. When it states something, cite it
  (`<path>#<section>`) — never restate it.
- **Dispatch Explore agents for the code sweep — always.** One per repo the work touches, on
  a fast model (`sonnet`). Send them before your first question, so they search while the
  user answers. Each returns findings inline with `file:line` pointers: what already does
  part of this, the conventions to follow, how the code runs and tests, what is fragile
  nearby.
- **Dispatch a design scout too when the change has a user-facing surface.** Send it with the
  sweep, on the same fast model; read `references/design-scout.md` for the brief. It pulls the
  designs off the ticket into `.harness/<name>/design/` and returns the `design/INDEX.md` path.
- **The sweep locates; you read.** Open yourself every file a decision turns on. Where the scout
  left a `design/INDEX.md`, that includes the files it names — a screen you have not looked at
  is one you cannot write a step for. No index means no design was found, which is a fact the
  step records.
- When the repo holds fewer than 3 examples of the pattern this work needs, also research
  externally — prior art, known failure modes, current API facts. Findings return inline
  with source URLs.
- Search the whole workspace before you claim something is absent. Miss an existing helper,
  and the coder builds a second one.

**Done when:** you can state the problem, the actor, and the outcome, and what exists in the
code today — each claim cited or labeled an assumption.

## Step 2 — The question loop

Close every open fork. Keep a written tree, not a mental model:

```
D<n>: <the decision> — blocks: D<a> · blocked-by: D<c> · [open|resolved|parked]
```

Resolve top-down: the decision that unblocks the most others first. To find the questions the
user did not think of, walk `references/lenses.md` — read it before the first pass.

Asking mechanics — always `AskUserQuestion` (on surfaces without it, plain text in the same
shape):

- Every menu question carries a recommendation and one clause saying why. Put the
  recommended option first and label it `(Recommended)`.
- Batch up to 4 **unrelated** questions. A question whose answer could reshape another is
  asked alone.
- Use an open question only when you cannot write 3-4 distinct, plausible options.
- Deferring is the user's decision, not yours. Resolve what you can; put the remainder to
  them. In `--auto`, ask nothing — record each open fork in plan.md's `## Deferred`, marked
  `auto`, and name it in the step-8 summary.

When a question is faster judged by seeing — layouts, wireframes, diagrams — offer the
browser companion per `references/visual-companion.md`. Read it before the first offer.

Last, check the answers **against each other**. Two answers can clash even when each looks
fine alone — "sessions expire after 24h" vs "remember-me lasts 30 days". Ask about every
clash now.

**Done when:** every checklist item holds — actor identified · outcome stated · scope
boundaries known · success criteria known or recorded as assumptions · answers checked against
each other · every `D<n>` resolved or parked.

## Step 3 — Solutions

Present 2-3 approaches only when real alternatives exist; one viable option gets two lines of
"why not X, Y" and moves on. Rules:

- Frame each as **reuse / extend / build new**.
- Every approach names something from this codebase — a file, a service, a pattern the sweep
  found. Cut any approach that would fit every project of this type.
- Describe each approach by what the user gets — "pause as a rule property" vs "pause as its
  own entity" — never by table names or file paths.
- When the code shows a genuinely higher-upside path, add it as one extra option labeled
  **challenger**. Never invent one to fill a slot.
- Present all approaches, then recommend. A recommendation given first biases how the user
  reads the rest.

Walk `references/lenses.md` again, this time against the approach you chose. Route each finding
to the destination that file names.

Last, apply YAGNI to every option and flag: needed now? If not, hardcode the value; add the
option when a real need appears.

**Done when:** one approach is chosen, and every finding is resolved, parked, or carried as a
named risk.

## Step 4 — Review the solution, before asking

Two passes, cheap one first.

**Pass 1 — self-review, inline.** Re-read the summary as a stranger. Five checks:

- any TBD, placeholder, or vague requirement
- two decisions that contradict each other
- a sentence readable two ways — pick one meaning and write it
- scope: one plan, or does this need decomposition?
- a reader who never saw this conversation understands it in one read

Fix what you find. No re-review loop.

**Pass 2 — fresh-context reviewer, dispatched.** It receives the summary and the PRD path —
never the session history — and verifies against the code itself. Budget ~15 targeted reads.
Per claim: **confirmed** (`file:line`) · **refuted** · **unverifiable**. It also checks:
every PRD story drives a decision or is named as unaddressed, and every new component
answers three questions — what it does, how it is used, what it depends on.

Fix refuted claims before the checkpoint — the user confirms a reviewed solution, not a
draft.

**Done when:** both passes ran; no refuted claim, contradiction, or two-way sentence
survives.

## Step 5 — The checkpoint

Present the solution inline, then ask one question. The summary, in this shape, every
sentence per the writing style:

1. **Problem** — one or two sentences.
2. **Approach** — six sentences or fewer: what gets built, where it sits, what it reuses.
3. **Decisions** — the resolved `D<n>` list as bullets, one line each. Flag every fork closed
   on the user's behalf with *(inferred — confirm)*.
4. **External dependencies** — each with its fallback order. Omit when none.
5. **Risks** — one line each. Omit when none.
6. **Next** — one sentence: what the plan will contain.

On a large solution, present the decisions in blocks and confirm each block before the final
question. Then `AskUserQuestion`: header `Approve?`, options
`Approve — build the plan (Recommended)` / `Revise`. In `--auto`, skip the question and
proceed.

A revision is not a confirmation: integrate the change, re-present what changed, wait for
approval. When the **same decision** is revised twice, stop and ask about it directly — the
decision is unresolved, not the wording.

On approval, dispatch the recorder sub-agent → it writes `design.md`. Read
`references/design-record.md` before dispatching — it carries the file contract and what the
prompt must include verbatim. Then move to step 6.

**Done when:** explicit approval (or `--auto`) and the recorder is dispatched.

## Step 6 — Design the phases

Cut the work into phases. Phases exist so a coder can hold one in context, a human can
review one in a sitting, and — the biggest win — independent phases can run in parallel.
Each phase also costs a dispatch, a TDD cycle, a commit, and one more document to read, so
every phase must earn its place.

A good phase is a **vertical slice**: it covers one or more requirements and is testable
on its own, end to end — never a code layer. "db: schema" fails (no requirement can be
proven against a schema alone); "an account can be created and read back" passes. Typical:
2-4 phases small, 4-6 large.

- **Phase 1 is the thinnest slice.** Barely functional but visible end to end — it proves
  the wiring before anything is built on top. Setup and plumbing are never their own
  phase; they ride inside the first phase that needs them.
- **Prefer fewer phases.** Merge when a phase cannot be demoed without the next, when its
  only consumer is the next, or when both are small enough that a reviewer reads them in
  one sitting. Two phases touching the same file are ordered, never parallel.
- **One mechanism, one phase.** "Export CSV" and "export JSON" are one phase when one
  exporter handles both as data — split only when a case needs new production code.

After approval, phase numbers are frozen — commits and claims files reference them. A
deleted phase leaves a gap; never renumber the survivors.

Then derive the tests: read `references/test-scenarios.md` now and build the Test Matrix
from it — a basis, not a checklist.

Two rules bind every step you write:

- **Open before you write.** Before a step edits a file, open that file. Write the step
  against the file's current content, never against a sweep pointer or memory.
- **A contradiction goes to the user.** When the code disproves an approved decision, ask:
  show the evidence, recommend the new decision. On the answer, update `design.md` when it
  exists; on the short flow, the user's answer is the record. In `--auto`: supersede, update
  `design.md` when it exists, and state the change in the step-8 summary.

**Done when:** every phase has a capability title, every requirement has a matrix row, every
scenario has exactly one home and names a failure no other scenario catches, and every file
a step edits was opened.

## Step 7 — Build plan.html

One authored artifact, two layers:

- **Payloads** — `plan.md` and each `phases/phase-N.md`, embedded as
  `<script type="text/markdown" data-file="…">` blocks. Contract:
  `references/plan-sections.md`. The payload test: **a coder that has the PRD but not the
  codebase can follow every step without opening a file.**
- **Human layer** — built from `scripts/plan-shell.html`, never from scratch. Contract:
  `references/plan-html.md` (sections, xref tooltips, altitude rule).

The `#phases` drill-down belongs to both: it is the payload's `## Implementation` section
**transcribed** into HTML, part for part. `#tests` is the same move on the payloads'
`## Test Scenarios`, per `references/test-scenarios.md`. `references/step-card.md` is the one contract for
those parts — read it before writing either layer.

Building the page takes a while — stream it so the user watches it grow instead of waiting:

1. **Start the live view first** (background it):
   ```bash
   bash <skill-dir>/scripts/start-server.sh --file <abs-path>/.harness/<name>/plan.html
   ```
   Print the returned `url` to the user immediately — it carries `?key=…`; never strip the
   query string. The page auto-reloads on every save; keep the startup JSON (the session
   dir is the parent of its `state_dir`) for the step-8 shutdown. If the server fails to
   start, build the file anyway and present it as a `file://` link — never block on the
   viewer.
2. **Copy the shell** to `.harness/<name>/plan.html`. Unfilled slots render as spinners.
3. **Fill top-down, one save per section**: title, brand, nav, and the hero first — the hero's
   `.links` ends with the run-info line, so run
   `node --experimental-strip-types <skill-dir>/../_shared/collect-run-info.ts` and paste its
   output there. Then fill each `SLOT:content` section in order. Insert each new section *above*
   the remaining `SLOT:content` comment and delete the comment only with the last section — that comment
   is what keeps the spinner pinned to the end of the written content.
4. **Write each `phases/phase-N.md` payload before the `#phases` card and the `#tests` table
   that render it** — you cannot transcribe a document you have not written. Payload blocks
   never render, so this costs the stream nothing. `plan.md` and the engine data (`X`, `RX`,
   `IMG`) last.

Then self-review and fix findings inline. Each check is a lookup, not a judgment; findings
are `[phase N, step M]: <issue>`. A failed check below blocks the gate; anything else is a
recommendation:

- **Inputs.** Every cited id resolves in the document named · every recorded decision
  appears in a step, or `design.md` (when it exists) was updated to supersede it · every
  repo and dependency the inputs name is touched by a phase or accounted for.
- **Phasing.** No two phases modify the same file unless ordered · every phase is provable
  by its own scenarios the moment it lands · a phase consuming what a "parallel" phase
  builds is not parallel.
- **Steps.** Every step states a location, a contract, or an algorithm · no step instructs
  the coder to discover something · no call site is described in prose where the changed
  lines would fit · every step title opens with an imperative verb naming the action · every
  line reference is an address the coder must open, and names what is there.
- **Coverage.** Every requirement has a matrix row · every row names a phase or an
  acceptance flow · every scenario appears exactly once across all payloads · `e2e` rows
  stay under a third of the matrix, or each excess row traces to a real-browser fact or a
  named Blocker.
- **The transcription is complete.** Count it, per phase: `<li>` in the drill-down ==
  numbered steps in that payload's `## Implementation`, same order, same titles · every code
  block in a step reaches its `<li>` · every existing-code snippet carries a `.snip-lbl.cur`
  with its reason · every step that names a design embeds it, and every `data-img` resolves
  in `IMG` · every `<details>` opens with a `<summary>` and wraps its panel in `.d-body` ·
  rows in `#matrix` == scenarios across all payloads, each carrying that
  scenario's id, heading, `Given` line and outcomes word for word.
- **The layers agree.** Every number, name, signature, and path in the human layer comes
  from a payload block · every internal id on the page has a tooltip entry · the
  above-the-fold view answers *what, why, what each phase unlocks* without a drill-down.

**Done when:** the shell's slots are filled, the payloads are complete, and the self-review
found nothing blocking.

## Step 8 — The plan gate

Present `plan.html` — the live-view URL when the server is running (the open tab already
shows the finished page), plus its absolute path as a `file://` fallback — with a
one-paragraph summary: the phase list and anything that changed since the checkpoint. One
`AskUserQuestion`. In `--auto`, auto-approve.

After any revision the user asks for: update plan.html — payloads included — re-run step 7's
self-review, and re-present. Keep the server running through revisions; every save shows up
in the user's tab on its own. A revision is not a confirmation; extract only after explicit
approval.

On approval, extract the payloads and stop the server:

```bash
node <skill-dir>/scripts/extract-plan.mjs .harness/<name>/plan.html
bash <skill-dir>/scripts/stop-server.sh <session-dir>
```

The HTML is the source; the extracted files are build products. Never hand-edit them —
re-run extraction after any HTML edit.

Hand off: orchestrate dispatches one coder per phase file in dependency order, or the user
works through them directly.

**Done when:** approval given, extraction ran, `plan.md` and `phases/` exist on disk.

## Rationalizations

| Excuse | Reality |
|---|---|
| "The user seems impatient" | A wrong plan costs more than one more question. Ask the highest-leverage one. |
| "I'll flag it for the coder to check" | The coder has less context than you. Resolve it or ask the user. |
| "The summary can gloss this decision" | The summary is what the user approves. A decision missing from it was never approved. |
| "This unit is untestable, so the test is e2e" | That is a finding about the code, not a level. Name it a Blocker and give a phase the step that opens it up. |
| "The existing code has no tests, so this is how it is" | The input describes the code today. The plan says what it becomes. Never copy a constraint you are allowed to remove. |
| "Most rows are e2e because the feature is user-facing" | User-facing describes the requirement. It never describes the level. Run the counterfactual on every row. |
