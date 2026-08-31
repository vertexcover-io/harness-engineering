---
name: rework
description: Apply QA or PR-review feedback to a ticket that already went through the pipeline.
disable-model-invocation: true
argument-hint: "<asana-url | pr-url>"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
---

# Rework

**Announce at start:** "Using the rework skill to apply feedback to `<ticket-id>`."

You **resume** a run that already exists. Its worktree, baseline, plan, and claims are all on disk.

**This runs unattended — ask the user nothing.** Every call is yours; record it in the report.

## Step 1 — Resume

Resolve each of these, in order:

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

   An empty `PRS` from an Asana task is not a halt. Step 2 reads it as QA.

2. `TICKET_REF` — from the Asana task `name`, or from the PR's branch.

3. `SPEC_NAME` — search `.harness/*/manifest.json` for any `PRS` entry's `pr_number`, then for
   `TICKET_REF` in `spec_name` or `branch`. Two matches is a halt: say which.

4. `WORKTREE_PATH`, `BRANCH_NAME` — from that manifest. `cd` to the worktree.
5. `REWORK_SPEC_DIR` — `.harness/<SPEC_NAME>-rework-<N>`, `N` one above the highest already there.
   Create it.
6. `PRE_REWORK_SHA` — `git rev-parse HEAD`. Every later stage scopes its diff from here.

Then seed it:

```bash
cp .harness/<SPEC_NAME>/{baseline.json,claims.json} <REWORK_SPEC_DIR>/
rm -f .harness/current-phase
```

Leave the feature docs where they are — a `plan.md` in this dir puts the whole feature back into
verification's scope.

**Done when** you hold `SPEC_NAME`, `WORKTREE_PATH`, `BRANCH_NAME`, `REWORK_SPEC_DIR`, and can read
the original run's `plan.md`, `claims.json`, and `verification/proof-report.html`.

## Step 2 — Read the feedback

**PR review** — `PRS` is not empty. Read `references/comment-triage.md` and follow it. It
**triages** every comment from every entry to a verdict.

**QA** — `PRS` is empty. The Asana task's `name` and `notes` are the reported issue. Reproduce it as
a failing test first. That **red** test is the proof the report was real, and going green is the
proof the fix landed.

## Step 3 — Run the pipeline

Invoke `orchestrate` via `Skill`, passing:

- `SPEC_NAME=<REWORK_SPEC_DIR basename>`, `WORKTREE_PATH`, `PRE_REWORK_SHA`, entry stage `coder`
- The feedback from Step 2 — the triaged comments, or the reported issue and its red test
- Plan `.harness/<SPEC_NAME>/plan.md` — the original, for Stage 4's `--plan`

Orchestrate owns every stage from here — the fix, the review, the gate, the verification. Report
what it returns.

## Step 4 — Write the report

Write `<REWORK_SPEC_DIR>/rework-report.html` once the pipeline returns. Follow
`references/rework-report-guide.md`.

Each item's `sourceHref` is
`https://github.com/<repository>/pull/<pr_number>#discussion_r<id>`, from that comment's own
`repository`, `pr_number` and `id` Step 2 fetched.

## Halts

| Condition | Detail |
|-----------|--------|
| Argument is not a URL | The argument is neither an Asana task URL nor a GitHub PR URL |
| `ASANA_PAT` unset | The argument is an Asana URL and the token is absent from the environment |
| No prior run | No `manifest.json` matches any `PRS` entry or `TICKET_REF` — name it and stop |
| Ambiguous ticket | Two or more manifests match — name both spec dirs |
| Worktree gone | The manifest's `worktree` path does not exist |
| Branch merged | `BRANCH_NAME` is already merged — the fix belongs on a new run, not this one. A merged PR among several in `PRS` is not a halt; skip it and say so in the report |
| Prior artifacts missing | `plan.md`, `claims.json`, or `proof-report.html` absent from the original spec dir |
| No feedback resolved | Step 2 produced no item to act on — say what it read |
