---
name: create-workspace
description: >
  Create the run's workspace before any code is written: the run's branch checked out in one repo
  (mono) or in each repo the request touches (multi). Runs as the pipeline's create-workspace stage.
mode: inline
allowed-tools: [Bash]
tier: fast
inputs:
  description: Spec name, and optionally the request text, base branch and repo list.
  schema: create-workspace.input.v1
outputs:
  description: Layout, branch, workspace folder and the repos in it.
  schema: create-workspace.output.v1
protocols: []
scopes: []
references:
  select-repos:
    path: references/select-repos.md
    description: How to choose which repos go in a multi-repo workspace.
---

# Create Workspace

Give the run its own branch and working folder, so no agent writes in the main checkout. The
workspace holds one git worktree per repo, each on the branch `SPEC_NAME`.

The input is a `create-workspace.input.v1` object: `specName`, and optionally `request` (the text
of what the run should do), `baseBranch` and `repos`.

This is a pipeline stage for harness v2. Its commands run the orchestrate script with
`bun run orchestrate …`. If that script is not found, stop and report that; do not create
worktrees by hand.

## Steps

1. Run `bun run orchestrate skill extension create-workspace`. If it prints anything, follow it
   for the rest of this skill; where it conflicts with a step below, it wins.
2. Run `bun run orchestrate workspace info`. It prints `{ layout, packages }`.
3. Choose the repos:
   - The input has `repos`: use them as given, and skip `select-repos`.
   - `layout` is `mono`: skip this step. The workspace is the one repo.
   - `layout` is `multi`: run `bun run orchestrate skill ref create-workspace select-repos` and
     follow what it prints to pick repo names from `packages`.
4. Run `bun run orchestrate workspace create SPEC_NAME --run SPEC_NAME`, adding
   `--base BASE_BRANCH` when the input has `baseBranch`, and `--repos NAME1,NAME2` in multi
   layout. `--run SPEC_NAME` names the run, so its event log records the workspace; always pass
   it.
5. The command prints a JSON report. If it exits non-zero, stop and report why: each repo in
   `repos` with `status: "failed"`, with its `name`, `error.kind` and `error.message`, and any
   error printed on stderr. An error saying the workspace changed but its event was not recorded
   means the worktrees exist but the run has no record of them, so later stages would not find
   them. Do not retry, and do not remove or delete anything. A person decides what to do; the
   clean retry is `bun run orchestrate workspace remove SPEC_NAME --run SPEC_NAME`, then this
   skill again. Don't suggest `workspace add` to finish a failed create: the run never recorded
   the workspace, so an added repo would land in a workspace later stages can't see.
6. Reply with the `create-workspace.output.v1` JSON, built from the report:

   ```json
   {
     "layout": "multi",
     "branch": "feat-x",
     "workspaceDir": "/abs/meta/.workspaces/feat-x",
     "repos": [{ "name": "api", "worktreeDir": "/abs/meta/.workspaces/feat-x/api" }]
   }
   ```

   `layout`, `branch` and `workspaceDir` come straight from the report; `repos` keeps each repo's
   `name` and `worktreeDir`.
