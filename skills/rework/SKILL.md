---
name: rework
description: Apply QA or PR-review feedback to a ticket that already went through the pipeline.
disable-model-invocation: true
argument-hint: "<ticket-id> [feedback text | --pr NUMBER]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
---

# Rework

**Announce at start:** "Using the rework skill to apply feedback to `<ticket-id>`."

You **resume** a run that already exists. Its worktree, baseline, plan, and claims are all on disk.

**This runs unattended — ask the user nothing.** Every call is yours; record it in the report.

## Step 1 — Resume

Resolve each of these, in order:

1. `SPEC_NAME` — search `.harness/*/manifest.json` for the ticket id in `spec_name` or `branch`,
   or for `pr_number` when the invocation passed `--pr`. Two matches is a halt: say which.
2. `WORKTREE_PATH`, `BRANCH_NAME` — from that manifest. `cd` to the worktree.
3. `REWORK_SPEC_DIR` — `.harness/<SPEC_NAME>-rework-<N>`, `N` one above the highest already there.
   Create it.
4. `PRE_REWORK_SHA` — `git rev-parse HEAD`. Every later stage scopes its diff from here.

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

**PR review** — the invocation passed `--pr NUMBER`, or names review comments. Read
`references/comment-triage.md` and follow it. It **triages** every comment to a verdict.

**QA** — anything else. The argument is the reported issue. Reproduce it as a failing test first.
That **red** test is the proof the report was real, and going green is the proof the fix landed.

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

## Halts

| Condition | Detail |
|-----------|--------|
| No prior run | No `manifest.json` matches the ticket — name the ticket and stop |
| Ambiguous ticket | Two or more manifests match — name both spec dirs |
| Worktree gone | The manifest's `worktree` path does not exist |
| Branch merged | `BRANCH_NAME` is already merged — the fix belongs on a new run, not this one |
| Prior artifacts missing | `plan.md`, `claims.json`, or `proof-report.html` absent from the original spec dir |
| No feedback resolved | Step 2 produced no item to act on — say what it read |
