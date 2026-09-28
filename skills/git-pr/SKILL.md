---
name: git-pr
description: Create or update a pull request with a clear title, visual change outline, and validation evidence. Use when asked to raise a PR, improve a PR description, or from the orchestrate Commit & PR stage after pushing.
---

# Git PR

Publish a reviewer-focused PR title and description for the current task. Commits and pushes
belong to the caller; this skill works with a branch that is already pushed.

1. Identify the repository, head branch, and base branch from the caller's context or existing
   PR. For a new PR without a supplied base, use the repository's default branch. Check that
   `gh` is available and authenticated. If the caller supplies a doctor-approved PR skip,
   return null `PR_URL` and `PR_NUMBER`, `PR_ACTION=skipped`, and its reason.
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
5. Save the body as `<HARNESS_DIR>/pr-description.md` when the caller supplies a harness
   directory; otherwise use a temporary Markdown file. Publish with `gh pr create` or
   `gh pr edit`, passing multiline content through `--body-file`. For creation, specify the
   base and head explicitly. Respect any existing draft status on updates.
6. Read back the PR's title, body, URL, number, and state to confirm the requested update.
   Return `PR_URL`, `PR_NUMBER`, and `PR_ACTION` (`created` or `updated`), plus the saved body
   path. On failure, report the failed operation and any PR already created or changed;
   do not claim success or retry creation blindly.

This skill does not merge PRs or change labels, reviewers, or milestones.
