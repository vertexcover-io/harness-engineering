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

People read the checkpoint summary, plan.html, and the markdown inside it. Write those per
`../_shared/writing-style.md`. Only agents read `design.md` — skip the style rules there.

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
  nearby. Ask each sweep one testability question outright: **can the unit this work changes be
  constructed in a test on its own — and which test libraries actually resolve?** A monolith no
  test can build, and a library listed in `package.json` but missing a peer, both push every
  later matrix row to the browser.
- **The sweep locates; you read.** Open yourself every file a decision turns on.
- When the repo holds fewer than 3 examples of the pattern this work needs, also research
  externally — prior art, known failure modes, current API facts. Findings return inline
  with source URLs.
- Search the whole workspace before you claim something is absent. Miss an existing helper,
  and the coder builds a second one.

**Done when:** you can state the problem, the actor, and the outcome, and what exists in the
code today — each claim cited or labeled an assumption.

## Step 2 — The question loop (the grill)

Close every open fork. Keep a written tree, not a mental model:

```
D<n>: <the decision> — blocks: D<a> · blocked-by: D<c> · [open|resolved|parked]
```

Resolve top-down: the decision that unblocks the most others first. To find the questions the
user did not think of, walk `../_shared/lenses.md` — read it before the first pass.

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
boundaries known · success criteria known or recorded as assumptions · every lens that fired
probed or parked · answers checked against each other · every `D<n>` resolved or parked.

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

Poke holes in the chosen approach: walk `../_shared/lenses.md` again in review mode. Findings
become questions or decisions.

Last, apply YAGNI to every option and flag: needed now? If not, hardcode the value; add the
option when a real need appears.

**Done when:** one approach is chosen and every hole found is resolved, parked, or carried as
a named risk.

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
5. **Next** — one sentence: what the plan will contain.

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

Read `references/phase-design.md` now — it carries the phase-cutting rules, the scenario and
test-matrix contract, and the payload writing habits.

Two rules bind every step you write:

- **Open before you write.** Before a step edits a file, open that file. Write the step
  against the file's current content, never against a sweep pointer or memory.
- **A contradiction goes to the user.** When the code disproves an approved decision, ask:
  show the evidence, recommend the new decision. On the answer, update `design.md` when it
  exists; on the short flow, the user's answer is the record. In `--auto`: supersede, update
  `design.md` when it exists, and state the change in the step-8 summary.

**Done when:** every phase has a capability title, every requirement has a matrix row, every
scenario has exactly one home, and every file a step edits was opened.

## Step 7 — Build plan.html

One authored artifact, two layers:

- **Payloads** — `plan.md` and each `phases/phase-N.md`, embedded as
  `<script type="text/markdown" data-file="…">` blocks. Contract:
  `references/plan-sections.md`. The payload test: **a reader who has the PRD but not the
  codebase can follow every step without opening a file.**
- **Human layer** — built from `scripts/plan-shell.html`, never from scratch. Contract:
  `references/plan-html.md` (sections, xref tooltips, altitude rule, the one optional
  widget).

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
3. **Fill top-down, one save per section**: title, brand, nav, and the hero first; then
   each `SLOT:content` section in order. Insert each new section *above* the remaining
   `SLOT:content` comment and delete the comment only with the last section — that comment
   is what keeps the spinner pinned to the end of the written content.
4. Payloads and the engine data (`X`, `CASES`, `RX`, widget) last.

Then run the self-review in `references/phase-design.md` (five groups) and fix findings
inline.

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
