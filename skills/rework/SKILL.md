---
name: rework
description: Apply QA or PR-review feedback to a ticket, across every PR it carries.
disable-model-invocation: true
argument-hint: "<asana-url | pr-url | prompt>"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent, AskUserQuestion
---

# Rework

**Announce at start:** "Using the rework skill to apply feedback to `<ticket-id>`."

## Purpose

The purpose of this skill is to turn review comments or a QA report on a shipped ticket into a
verified fix. It reads the feedback, judges each item, and hands the ones worth acting on to
`orchestrate`, which owns the fix from there.

## Rules

**Ask whatever you need, whenever you need it, up to Step 5.** One `AskUserQuestion` per question,
and act on the answer before asking the next: an answer can change the approach. Once Step 5 invokes
`orchestrate`, stop asking and stop pausing: the run is orchestrate's.

**Events.** Fire them as `skills/orchestrate/references/events.md` defines, from the primary entry's
worktree: `question-pending` before each `AskUserQuestion`, `run-interrupted` before any row of the
Halts table.

## Step 1 — Resolve the ticket

1. `PRS` — each entry `{repository, pr_number}`.

   From a PR URL: one entry, `repository` is `<owner>/<repo>`, `pr_number` follows `/pull/`.

   From an Asana URL: `GID` is the last numeric path segment. Take every distinct
   `github.com/<owner>/<repo>/pull/<n>` URL in the task's notes, stories, and attachments.

   ```bash
   API="https://app.asana.com/api/1.0"
   curl -s "$API/tasks/$GID?opt_fields=name,notes" -H "Authorization: Bearer $ASANA_PAT"
   curl -s "$API/tasks/$GID/stories?opt_fields=text" -H "Authorization: Bearer $ASANA_PAT"
   curl -s "$API/tasks/$GID/attachments?opt_fields=name,view_url" -H "Authorization: Bearer $ASANA_PAT"
   ```

2. `TICKET_REF` — from the Asana task `name`, or from the PR's branch.

3. Run the **Fetch** section of `references/comment-triage.md` once per `PRS` entry. It returns that
   PR's `head_branch`, whether it is merged, and its review comments.

Drop a merged PR from `PRS` and name it in the report. An empty `PRS`, or one that empties here, is
not a halt: the task's `name` and `notes` are the reported issue instead.

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

Record per entry, for Step 5:

| Field | Value |
|---|---|
| `worktree`, `branch` | what the worktree skill returned |
| `packages` | the `packages` keys this PR's changed files sit under, empty for the root `commands` map |
| `spec_name` | `<TICKET_REF>-rework-<N>`, `N` one above the highest `.harness/<TICKET_REF>-rework-*` already in that checkout |
| `base_sha` | the checkout's head |
| `plan` | the prior run's `plan.md`, when a `.harness/*/manifest.json` in that checkout matches this `pr_number` or `TICKET_REF`. Two matches, or none, is a question |

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

## Step 5 — Run the pipeline

**First, collect Step 3's baselines**: wait for each sub-agent, then check its `baseline.json` with
the join command in `skills/orchestrate/SKILL.md` Stage 0. Nothing may still be unresolved either:
an entry with no `plan`, a comment triage could not settle. A plan is required, so ask for it rather
than inferring one.

Then invoke `orchestrate` **once**, via `Skill`, in this conversation, entry stage `coder`. Pass
`TARGETS[]`, one entry per Step 2 checkout, primary first, carrying `repository`, `worktree`, `branch`,
`spec_name`, `plan`, `base_sha` and `packages`.

With each entry pass its **`valid` items only**, inline, each one as: `path:line`, what the reviewer
asked in one sentence, what to change, and the test that shows it done. A comment with any other
verdict never reaches orchestrate.

Orchestrate owns every stage from here. Report what it returns.

## Step 6 — Write the report

Write `rework-report.html` into the primary entry's `.harness/<spec_name>/` once the pipeline
returns, following `references/rework-report-guide.md`. It is this skill's only artifact.

Each item's `sourceHref` is
`https://github.com/<repository>/pull/<pr_number>#discussion_r<id>`, from that comment's own
`repository`, `pr_number` and `id`.

## Halts

| Condition | Detail |
|-----------|--------|
| Argument is not a URL | The argument is neither an Asana task URL nor a GitHub PR URL |
| `ASANA_PAT` unset | The argument is an Asana URL and the token is absent from the environment |
| Config missing | A `PRS` entry's repository has no `orchestrate.config.json` at its root — name it and `setup-harness`, which writes it |
| No checkout | The worktree skill could not produce that repository on that branch — name both |
| Baseline unusable | An entry's `baseline.json` is missing, unparseable, or carries no metrics |
| Plan unresolved | You asked, and an entry holding `valid` items still has no plan |
| No feedback resolved | Step 4 produced no `valid` item anywhere — say what it read |
