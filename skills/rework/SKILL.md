---
name: rework
description: Apply QA or PR-review feedback to a ticket, across every PR it carries.
disable-model-invocation: true
argument-hint: "<ticket-url | pr-url | prompt>"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent, AskUserQuestion
---

# Rework

**Announce at start:** "Using the rework skill to apply feedback to `<ticket-id>`."

## Purpose

The purpose of this skill is to turn review comments or a QA report on a shipped ticket into a
verified fix. It reads the feedback, judges each item, and hands the ones worth acting on to
`orchestrate`, which owns the fix from there.

## Rules

**Ask whatever you need, whenever you need it, up to and including the Step 5 checkpoint.** One
`AskUserQuestion` per question, and act on the answer before asking the next: an answer can change
the approach. Once Step 6 invokes `orchestrate`, stop asking and stop pausing: the run is
orchestrate's.

**Events.** Fire them as `skills/orchestrate/references/events.md` defines, from the primary entry's
worktree: `question-pending` before each `AskUserQuestion`, `run-interrupted` before any row of the
Halts table.

## Step 1 — Resolve the ticket

1. `PRS` — each entry `{repository, pr_number}`.

   From a PR URL: one entry, `repository` is `<owner>/<repo>`, `pr_number` follows `/pull/`.

   From a ticket URL or id: read the ticket through whatever the project uses to reach its
   tracker, and take every distinct `github.com/<owner>/<repo>/pull/<n>` URL the ticket's own
   text carries. Ask which command or tool reads a ticket here when the project or the
   orchestrate config does not make it obvious.

2. `TICKET_REF` — from the ticket's title, or from the PR's branch.

3. Run the **Fetch** section of `references/comment-triage.md` once per `PRS` entry. It returns that
   PR's `head_branch`, whether it is merged, and its review comments.

Drop a merged PR from `PRS` and name it in the report. An empty `PRS`, or one that empties here, is
not a halt: the ticket's title and body are the reported issue instead.

## Step 2 — Build the workspace

**One workspace holds every checkout this ticket needs**, side by side, so a fix that spans PRs is
built and proven in one place. A ticket's PRs may share a repository or not; each PR is its own
branch, so each gets its own checkout.

Per `PRS` entry, or for the launch repo when `PRS` is empty:

1. Read that entry's `repository` root `orchestrate.config.json`. Every command for this checkout
   comes from that file, resolved per `skills/orchestrate/references/config.md`.
2. **Do not make the checkout yourself.** Invoke the worktree skill that config's `stages.worktree`
   resolves to, placing the checkout in the workspace on the PR's `head_branch` **as the remote has
   it now**. A QA ticket with no PR gets a new branch off the remote's default branch.
3. Install with that config's `bootstrap` command.
4. Create `.harness/<spec_name>/`, delete `.harness/current-phase`, and copy no prior document in: a
   `plan.md` there puts the whole feature back into verification's scope.

Record per entry, for Step 6:

| Field | Value |
|---|---|
| `worktree`, `branch` | what the worktree skill returned |
| `packages` | the `packages` keys this PR's changed files sit under, empty for the root `commands` map |
| `spec_name` | `<TICKET_REF>-rework-<N>`, `N` one above the highest `.harness/<TICKET_REF>-rework-*` already under the run root (`hooks.ts run-root`) |
| `base_sha` | the checkout's head |
| `plan` | the prior run's `plan.md`, when a `.harness/*/manifest.json` under the run root matches this `pr_number` or `TICKET_REF`. Two matches, or none, is a question |

**The first `PRS` entry is primary.**

## Step 3 — Baseline every checkout, in the background

The moment a checkout is ready, dispatch one background sub-agent for it from the Stage 0 Baseline
block in `skills/orchestrate/references/stage-prompts.md`, with its worktree, spec dir and
`packages`. Do not wait for it; Step 5 collects them.

## Step 4 — Triage the feedback

**PR review.** Follow the **Triage** section of `references/comment-triage.md`, reading each comment
in its own PR's checkout.

**QA.** Reproduce the reported issue as a failing test first. That **red** test is the proof the
report was real, and going green is the proof the fix landed.

## Step 5 — The checkpoint

**First, collect Step 3's baselines**: wait for each sub-agent, then check its `baseline.json` with
the join command in `skills/orchestrate/SKILL.md` Stage 0. Nothing may still be unresolved either:
an entry with no `plan`, a comment triage could not settle.

Then present the plan inline, opening with one sentence saying this is the plan to review and
nothing runs until they approve it. Every sentence per the writing style:

1. **Ticket** — `TICKET_REF`, where the feedback came from, how many comments were read, and each
   PR in scope with the branch it is checked out on. Name every PR dropped as merged, and every
   `plan` you inferred rather than found, as *(inferred — confirm)*.
2. **What will change** — every `valid` item as `path:line`, what the reviewer asked in one
   sentence, what to change, and the test that shows it done.
3. **What will not** — every other item in one line with its verdict and reason.
4. **Risks** — blast radius per `references/blast-radius.md`, one line each. Omit when none.
5. **Next** — one sentence: orchestrate runs from entry stage `coder` and owns every stage after.

Then `AskUserQuestion`: header `Approve?`, options `Approve — run the pipeline (Recommended)` /
`Adjust scope` / `Revise`. **Adjust scope** re-triages only the items the user names, per Step 4.
**Revise** corrects a plan, a target, or a fix's approach. Either one re-presents and asks again.

When the **same item** is revised twice, stop and ask about it directly — its verdict is unresolved,
not its wording. If adjusting scope empties the `valid` set, that is the **No feedback resolved**
halt. In `--auto`, skip the question and proceed.

## Step 6 — Run the pipeline

Invoke `orchestrate` **once**, via `Skill`, in this conversation, entry stage `coder`. Pass
`TARGETS[]`, one entry per Step 2 checkout, primary first, carrying `repository`, `worktree`, `branch`,
`spec_name`, `plan`, `base_sha` and `packages`.

With each entry pass its **`valid` items only**, inline, exactly as Step 5 presented them. A comment
with any other verdict never reaches orchestrate.

Orchestrate owns every stage from here. Report what it returns.

## Step 7 — Write the report

Write `rework-report.html` into the primary entry's `.harness/<spec_name>/` once the pipeline
returns, following `references/rework-report-guide.md`. It is this skill's only artifact.

Each item's `sourceHref` is
`https://github.com/<repository>/pull/<pr_number>#discussion_r<id>`, from that comment's own
`repository`, `pr_number` and `id`.

## Halts

| Condition | Detail |
|-----------|--------|
| Ticket unreadable | The argument is not a PR URL, and asking did not produce a way to read the ticket |
| Config missing | A `PRS` entry's repository has no `orchestrate.config.json` at its root — name it and `setup-harness`, which writes it |
| No checkout | The worktree skill could not produce that repository on that branch — name both |
| Baseline unusable | An entry's `baseline.json` is missing, unparseable, or carries no metrics |
| Plan unresolved | You asked, and an entry holding `valid` items still has no plan |
| No feedback resolved | Triage produced no `valid` item anywhere — say what it read |
| Checkpoint not approved | The user declined the run at Step 5 rather than revising — say what was presented |
