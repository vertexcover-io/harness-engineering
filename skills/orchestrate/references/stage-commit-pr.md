# Commit & PR

`set-status commit-pr running`. Run these steps in the main conversation.

If [config.md](config.md) resolves a skill for this stage, invoke it in place of steps 2–4,
passing `WORKTREE_PATH`, `BRANCH_NAME`, `BASE_BRANCH`, the PR title and body, and `MODE_ARG`.
It owes the commit SHAs and either `PR_URL` or a stated reason there is none. Steps 1 and 5 to 8
stay here either way, so the index, the events and the manifest do not change with the ship method.

If a commit, push, or PR creation fails, stop as `SHIP_FAILED`, naming the operation and error;
report any commits already pushed or PR already created so the next attempt can resume safely.
If writing the index or updating the manifest fails, stop and report that path and error.
An open PR is the successful result; a doctor-approved PR skip must be reported as uncreated.

1. Write `<HARNESS_DIR>/README.md`, the reviewer index: title and final verification verdict,
   one-paragraph summary, TOC (`plan.html` first, then `design.md`, `plan.md`, `phases/`,
   review and verification reports), and PR-link placeholder. Include only artifacts produced
   by this route. Reviewers access this index separately because `.harness/` does not reach the PR.
2. Invoke `git-commit` via `Skill` with `MODE_ARG` for the feature changes. The `.harness/` tree is
   gitignored; if it appears in status, fix `.gitignore`.
3. Push: `git push -u origin <BRANCH_NAME>`.
4. Open the PR, unless this branch already has one. Look first: `gh pr create` errors out when a
   PR exists for the branch, and a caller that started from an existing PR — a review fixer
   answering comments, say — is pushing to that PR rather than opening a second.

   ```bash
   gh pr view --json url,state --jq 'select(.state == "OPEN") | .url'
   ```

   Ask for the state, because `gh pr view` answers with a closed or merged PR just as readily as
   an open one, and a branch reused after its PR merged would otherwise report success pointing at
   a PR these commits are not in. A URL means an open PR exists: store it as `PR_URL` and record
   in the report that it already existed. No URL means create one, with the spec title
   and a one-paragraph body describing the change, its validation, and where the worktree
   artifacts live. Use `--body-file` for multiline text:

   ```bash
   gh pr create --title '<spec title>' --body-file '<body file>' --base '<BASE_BRANCH>' --head '<BRANCH_NAME>'
   ```

   Store the `PR_URL` it prints. A doctor-approved skip of `gh` leaves the PR uncreated; report
   that explicitly.
5. Fire `artifact-created` with kind `commit` and the HEAD SHA, and — only when this run opened the
   PR — kind `pr` with its URL, per [events.md](events.md). Both fire here rather than inside steps
   2 and 4, so a project that replaces those steps with its own ship skill keeps its hooks.
6. Update `manifest.json` with `pr_number` and `completed_at`; backfill `PR_URL` into README.
   If no PR was created, leave its number null and record the reason in the index.
7. Fire `run-completed`, with the PR URL or the actual commit/push outcome.
8. `write-report commit-pr`, then `set-status commit-pr done`. Carry commits and `PR_URL`.

## Resumed runs

Commit and push once per `TARGETS[]` entry in its own worktree and branch; name unchanged entries
in the report without creating empty commits. Each entry already has a PR, so step 4 finds it and
opens nothing. Skip the manifest and link update. The reviewer index stays in the primary spec dir.

Uploading the run's artifacts to a tracker belongs in a project `artifact-created` hook filtered to
kind `pr`, not in this stage. Step 5 is what makes that hook fire.
