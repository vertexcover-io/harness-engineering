# Commit & PR

`set-status commit-pr running` + `fire --event stage-started --stage commit-pr`. Run these steps in the main conversation.

If [config.md](config.md) resolves a skill for this stage, invoke it in place of steps 2–5,
passing `WORKTREE_PATH`, `BRANCH_NAME`, `BASE_BRANCH`, the PR title and body, and `MODE_ARG`.
It owes the commit SHAs and either `PR_URL` or a stated reason there is none. Steps 1 and 6 to 9
stay here either way, so the index, the events and the manifest do not change with the ship method.

If a commit, push, or PR creation fails, stop as `SHIP_FAILED`, naming the operation and error;
report any commits already pushed or PR already created so the next attempt can resume safely.
If writing the index or updating the manifest fails, stop and report that path and error.
An open PR is the successful result; a doctor-approved PR skip must be reported as uncreated.

1. Write `<HARNESS_DIR>/README.md`, the reviewer index: title and final verification verdict,
   one-paragraph summary, TOC (`plan.html` first, then `design.md`, `plan.md`, `phases/`,
   review and verification reports), and PR-link placeholder. Include only artifacts produced
   by this route. Reviewers access this index separately because `.harness/` does not reach the PR.
2. **Squash the run's working commits.** Coder phases, review repairs, verify fix rounds and WIP
   checkpoints each committed as they went. Those commits were checkpoints for the stages that
   needed them. The PR should show the finished change in a few meaningful commits, not the
   history of how the run got there. Squash only what this run committed and nothing the remote
   already has, so no push is ever forced.

   `BASE` is `START_SHA`, or the entry's `base_sha` on a resumed run. After
   `git fetch origin <BRANCH_NAME>`, if `origin/<BRANCH_NAME>` exists and is not an ancestor of
   `BASE`, use it as `BASE` instead. Skip the squash, and say why in the stage report, when
   `BASE` is not an ancestor of HEAD, when `BASE..HEAD` holds fewer than two commits, or when
   `git rev-list --merges BASE..HEAD` prints anything: a merge brings base-branch changes that
   would land in this PR's diff.

   ```bash
   PRE_SQUASH=$(git rev-parse HEAD)
   git update-ref 'refs/harness/pre-squash/<SPEC_NAME>' "$PRE_SQUASH"
   git log --reverse --format='%h %s%n%b' "$BASE..$PRE_SQUASH" > '<HARNESS_DIR>/working-commits.txt'
   git reset --mixed "$BASE"
   git diff -z --name-only --no-renames --diff-filter=A "$BASE" "$PRE_SQUASH" | xargs -0 git add -N --
   ```

   The reset keeps the working tree, so nothing is lost, and uncommitted sync-docs edits come
   along. `add -N` keeps files the run created visible as tracked, so `git-commit` does not treat
   them as stray untracked files. Keep the ref after the run: it is the undo, and it keeps the
   commits the verify ledger recorded reachable, so a later rework re-verifies incrementally.
3. Invoke `git-commit` via `Skill`, passing `--working-commits <HARNESS_DIR>/working-commits.txt`
   when step 2 squashed. It never pauses, so this stage ships without stopping in every mode. The `.harness/` tree is gitignored; if it appears in status, fix
   `.gitignore`.

   When step 2 squashed, check that every change the run committed is committed again:

   ```bash
   git diff -z --name-only --no-renames "$BASE" "$PRE_SQUASH" | xargs -0 git status --porcelain --
   ```

   It must print nothing. Anything it prints is run work `git-commit` left out. Restore the
   working commits with `git reset --mixed "$PRE_SQUASH"`, which leaves the working tree as it is,
   invoke `git-commit` again without `--working-commits` for what is still dirty, and name the
   fallback in the stage report.
4. Push: `git push -u origin <BRANCH_NAME>`.
5. Open the PR, unless this branch already has one. Look first: `gh pr create` errors out when a
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
6. Fire `artifact-created` with kind `commit` and the HEAD SHA, and — only when this run opened the
   PR — kind `pr` with its URL, per [events.md](events.md). Both fire here rather than inside steps
   3 and 5, so a project that replaces those steps with its own ship skill keeps its hooks.
7. Update `manifest.json` with `pr_number` and `completed_at` — merge into the file, never
   rewrite it: `thread` is the notifier's and the run's later events still need it. Backfill
   `PR_URL` into README. If no PR was created, leave its number null and record the reason in the index.
8. `write-report commit-pr`, then `set-status commit-pr done` +
   `fire --event stage-completed --stage commit-pr --result pass`.
9. Fire `run-completed`, with the PR URL or the actual commit/push outcome. Carry commits and `PR_URL`.

## Resumed runs

Commit and push once per `TARGETS[]` entry in its own worktree and branch; name unchanged entries
in the report without creating empty commits. Squash each entry down to its own `base_sha`, or to
`origin/<branch>` when that is newer, so the review fixes land as a few new commits on top of what the
PR already shows. Each entry already has a PR, so step 5 finds it and opens nothing.
Skip the manifest and link update. The reviewer index stays in the primary spec dir.

Uploading the run's artifacts to a tracker belongs in a project `artifact-created` hook filtered to
kind `pr`, not in this stage. Step 5 is what makes that hook fire.
