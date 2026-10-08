---
name: visual-pr
description: >
  Create or update a pull request with a clear title, visual change outline, and validation
  evidence. Runs as the pipeline's pr stage, after commit, where it also pushes the branch; also
  use it when asked to raise a PR or improve a PR description.
summary: Say which PRs were opened or updated, one repo at a time.
mode: inline
allowed-tools: [Bash, Read, Write, Grep, Glob]
tier: deep
consumes:
  - artifact: plan
    optional: true
  - artifact: proof-report
    optional: true
produces:
  - artifact: pr-description
    optional: true
protocols: []
scopes: []
references:
  description-template:
    path: references/pr-description-template.md
    description: The sections a PR body carries and what each one holds.
  visual-guide:
    path: references/pr-visual-guide.md
    description: How to draw the change outline's diff blocks, trees and diagrams.
---

# Visual PR

Publish a reviewer-focused PR title and description for the current task. Outside a run, commits
and pushes belong to the caller; this skill works with a branch that is already pushed.

## In a run

RUN below is the run's spec name. The input holds `workspace`, the create-workspace stage's
output, and `task`, the request or ticket text. Do every step once per repo in the workspace,
inside its `worktreeDir`, and skip a repo whose branch has no commit past its base. The base
branch is `workspace.repositories.NAME.git.baseBranch` in `.yok/RUN/state.json`.

Push the branch before step 1. The commit stage may have rewritten commits that were already
pushed, so the push may need force. Force only over commits this checkout is known to hold:

```bash
BRANCH=$(git branch --show-current)
git fetch origin "$BRANCH" 2>/dev/null
REMOTE=$(git rev-parse --verify --quiet "origin/$BRANCH")
```

- No `REMOTE`, or `REMOTE` is an ancestor of `HEAD`: `git push -u origin "$BRANCH"`.
- `REMOTE` is an ancestor of `refs/yok/pre-squash/$BRANCH`: the squash rewrote those commits
  and the new history holds their work. Push with a lease on that exact commit, so the push is
  refused if the remote moves after this check:

  ```bash
  git push --force-with-lease="refs/heads/$BRANCH:$REMOTE" -u origin "$BRANCH"
  ```

- Otherwise the remote holds commits this checkout never had. Do not push. Stop, name those
  commits, and finish the stage with `--error`.

Check ancestry with `git merge-base --is-ancestor`. A bare `--force-with-lease` is not enough
here: the fetch above moves the lease to whatever the remote now holds. If a push is refused,
stop and report it; never fall back to a plain `--force`.

Read the references with `yok orchestrate skill ref visual-pr.description-template` and
`yok orchestrate skill ref visual-pr.visual-guide`, not by path. Save the body as
`.yok/RUN/artifacts/pr-description.md`, or `pr-description-NAME.md` per repo when the
workspace has several. Finish the stage with two artifacts for each repo, with the repo's name as
`name`: its description,
`--artifact '{"type":"pr-description","name":"REPO","path":"artifacts/FILE"}'`, and a link to its
PR, `--artifact '{"type":"pull-request","name":"REPO","url":"PR_URL"}'`. The run's last Slack
message lists every `pull-request` link. The stage's output is the result below for each repo.

## Steps

1. Identify the repository, head branch, and base branch from the caller's context or existing
   PR. For a new PR without a supplied base, use the repository's default branch. Check that
   `gh` is available and authenticated. If the caller supplies a doctor-approved PR skip,
   return the `skipped` result defined below and stop; do not enter the publication steps.
2. Look for an **open** PR matching the head branch and intended base. A closed or merged PR
   is not the target. Distinguish a successful lookup with no matches from an authentication
   or network failure; stop on lookup errors. If the caller explicitly names a PR, verify its
   repository, branch, and open state before editing it. Resolve ambiguous targets before publishing.
3. Read the complete PR diff and enough surrounding code to explain the final behavior.
   For a new PR, compare the pushed head against the base. Use the ticket, plan, verification
   reports, and existing PR description when available. Local unpushed work is not part of the PR.
4. Before writing, read [pr-description-template.md](references/pr-description-template.md)
   and [pr-visual-guide.md](references/pr-visual-guide.md). Write a concise title naming the
   concrete change. Follow the template for the body; preserve relevant human-added context
   when updating an existing PR. Honor explicit requests to change only the title or body.
5. Save the body where "In a run" says; outside a run, use a temporary Markdown file. Publish with `gh pr create` or
   `gh pr edit`, passing multiline content through `--body-file`. For creation, specify the
   base and head explicitly. Respect any existing draft status on updates.
6. Read back the PR's title, body, URL, number, and state to confirm the requested update.
   Return the result defined below, plus the saved body path.
   On failure, report the failed operation and any PR already created or changed;
   do not claim success or retry creation blindly.

## Return values

| `PR_ACTION` | Meaning | `PR_URL` and `PR_NUMBER` |
|---|---|---|
| `created` | A new PR was created and confirmed. | The PR's URL and number. |
| `updated` | An existing open PR was updated and confirmed. | The PR's URL and number. |
| `skipped` | Setup explicitly approved skipping publication. | Both null; include the skip reason. |

This skill does not merge PRs or change labels, reviewers, or milestones.
