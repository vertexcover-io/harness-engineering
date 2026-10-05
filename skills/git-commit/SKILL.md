---
name: git-commit
description: >
  Groups a dirty working tree into logical commits using hunk-level staging, with short
  conventional messages. Use when the user asks to commit their changes or split them into
  separate commits, including "save my work to git" or "organize my git changes". Runs as the
  pipeline's commit stage, after qa, where it first squashes the branch's commits since its base;
  it does the same when the user says "squash my commits" or "tidy this branch's history". Does
  not handle branch management, rebasing, merging, or pushing.
mode: inline
allowed-tools: [Bash, Read]
tier: deep
protocols: []
scopes: []
references:
  hunk-staging:
    path: references/hunk-staging.md
    description: How to stage part of a file when it holds more than one concern.
---

# Git Commit

Turn the work in a checkout into a few commits a reviewer can read: one logical concern each,
with a short conventional subject. The details belong in the pull request.

There are two ways in, and the first decision is which one this is:

- **A dirty tree.** The user asks to commit or split their changes. Go straight to Step 1.
  History is never rewritten here.
- **A branch to squash.** In a pipeline run, or when the user asks to squash or tidy a branch,
  the branch's own commits are checkpoints: one per phase, review fix and QA round. Undo them
  first ([Step 0](#step-0-squash-the-branch)), then commit the same tree again. A caller that did
  the squash itself passes `--working-commits PATH`, the log of the commits it undid: skip Step 0
  and treat that file as `LOG`.

If `$ARGUMENTS` holds a path to an existing file, other than a flag's value, read it and
prioritize its guidelines over the defaults below.

## Run start to finish

Ask no question and wait for no approval, here or in `references/`. Commits are local and easy to
undo, and callers such as the orchestrate pipeline have nobody watching. Where a choice is unclear,
make it and name it in the closing summary:

- **Unclear grouping or intent:** pick the most likely grouping.
- **Untracked files that don't clearly belong:** leave them out.
- **A hunk split that gets complicated:** commit the whole file under its main concern.
- **Generated files** (compiled output, timestamped migrations): leave them out; they may be accidental.

## Principles

1. **Stage by path or hunk, after reading it.** `git add .` and `git add -A` sweep in whatever else is lying in the tree.
2. **Commit an untracked file only when it clearly belongs to a change**, such as a new test beside its implementation. Leave every other untracked file out.
3. **One logical concern per commit** — a single file may contribute hunks to different commits. A single commit may span multiple files.
4. **Tests and implementation travel together** — if a test and its corresponding source both changed for the same feature/fix, they belong in one commit.

## Workflow

### Step 0: Squash the branch

Only on the squash way in. RUN below is the run's spec name.

**Where.** In a run, the input's `workspace` is the create-workspace stage's output: do this
step and the rest of the workflow once per repo, in its `worktreeDir`. The repo's base is
`workspace.repositories.NAME.git.startSha` in `.yok/RUN/state.json`. Outside a run, work in
the current checkout, and the base is where the branch left the base branch: the one the user
names, else origin's default branch:

```bash
BRANCH=$(git branch --show-current)
UPSTREAM=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)
BASE=$(git merge-base HEAD "$UPSTREAM")
git fetch origin "$BRANCH" 2>/dev/null
```

**Stop** when either of these holds. Squash nothing, commit nothing, say which it was, and in a
run finish the stage with `--error`:

- `origin/BRANCH` exists and is not an ancestor of `HEAD` (`git merge-base --is-ancestor`): the
  remote has commits this checkout lacks, and squashing or pushing over them would delete
  someone's work. Name the remote commits.
- a file's staged content differs from its working-tree copy, so
  `comm -12 <(git diff --cached --name-only | sort) <(git diff --name-only | sort)` prints a
  path: the reset below rebuilds the index, and that staged version exists nowhere else. Name the
  file; which copy to keep is the developer's call.

**Skip the squash**, commit only what is dirty, and say why in the summary, when any of these
holds:

- `BASE` is not an ancestor of `HEAD`;
- `git rev-list --merges "$BASE..HEAD"` prints anything: a merge carries the base branch's
  changes, and a squash would put them in this change's diff;
- `BASE..HEAD` holds one commit or none and the tree is clean: the history is already short.

**Otherwise squash:**

```bash
PRE_SQUASH=$(git rev-parse HEAD)
git update-ref "refs/yok/pre-squash/$BRANCH" "$PRE_SQUASH"
GIT_DIR_ABS=$(git rev-parse --absolute-git-dir)
LOG="$GIT_DIR_ABS/yok-working-commits.txt"
DIRTY="$GIT_DIR_ABS/yok-dirty-paths.txt"
git log --reverse --format='%h %s%n%b' "$BASE..$PRE_SQUASH" > "$LOG"
git status --porcelain --no-renames | cut -c4- | sort > "$DIRTY"
git reset --mixed "$BASE"
git diff -z --name-only --no-renames --diff-filter=A "$BASE" "$PRE_SQUASH" | xargs -0 git add -N -f --
```

The reset keeps the working tree, so nothing is lost and uncommitted edits come along. The ref
is the undo. `add -N` keeps the files the branch created visible as tracked; it takes `-f`
because a file the branch committed with `git add -f` is ignored again after the reset and would
otherwise drop out of the new history unseen. That is the one place this skill force-adds, and
only for paths the old commits already held. If the `add` fails, put the history back with
`git reset --mixed "$PRE_SQUASH"` and stop.

Pushed commits are squashed too. The next push then needs force; in a run, `visual-pr` does it
with a lease on the exact commit it checked.

### Step 1: Reconnaissance

Read the status, the full diff, the staged diff and recent `git log`. Also check for commit convention configs (`commitlint.config.*`, `.czrc`, `CONTRIBUTING.md`). Match whatever conventions the project already uses — consistency with the repo matters more than any spec.

Classify every path: modified tracked files, untracked files, deletions, already-staged changes, binaries, submodules.

### Step 2: Understand Intent

Read the diffs and figure out what the developer was trying to do. Start with test files — test names are the strongest signal for intent (`test('should reject invalid email')` tells you this is about email validation).

Then read implementation diffs. Use file proximity as a grouping signal — changes in the same module/directory usually belong together unless the diff shows otherwise.

After a squash, `LOG` says how the change was built, oldest first. Read it too:

- **Feature commit messages name the commits.** A message like `feat(auth): add token refresh`
  marks one logical change. Start from these, then merge or split them the way Step 3 would.
- **Fix, review, verify and WIP commits fold into the feature they repaired.** That work never
  shipped, so the repair is part of it. Put each of their hunks in the commit whose code it
  touches.
- **Every tracked change belongs to the branch**, including files marked intent-to-add and
  generated files the old commits held, so the leave-out rules above do not apply to them. Commit
  every tracked change, because Step 5's check fails when one is left.

### Step 3: Group Changes Into Commits

Each commit should represent one logical concern. Grouping priorities:

1. **Feature + its tests = one commit.**
2. **Refactor is separate from feature.** Restructured code AND new behavior → split them.
3. **Config/tooling changes are separate** unless inseparable from a feature.
4. **Dependency updates are separate** unless a new dep is required by a feature in the same commit.
5. **Bug fixes are atomic.** A fix and its regression test = one commit.
6. **A lock file goes in the same commit as its manifest.**

Aim for the fewest commits that each stand alone. One commit is a fine answer for a small
change.

When a single file has mixed concerns, use hunk-level staging to split it across commits. See `references/hunk-staging.md` for techniques; in a run, read it with `yok orchestrate skill ref git-commit.hunk-staging`.

**Plan every commit before staging any:** which files and hunks go into each one.

### Step 4: Execute Commits

For each commit in the plan, in order:

1. Stage its files, or its hunks for a split file.
2. Check `git diff --cached --stat` holds exactly that commit.
3. Commit, passing the message through a HEREDOC.

Respect any already-staged changes — incorporate them into the plan rather than unstaging them.

### Step 5: Check, then report

After a squash, the new history must hold everything the old one did. Compare the two trees,
setting aside the paths that were uncommitted before the squash, since those may differ:

```bash
git diff --name-only --no-renames "$PRE_SQUASH" HEAD | sort | comm -23 - "$DIRTY"
```

It must print nothing. A path it prints was in the old commits and is missing or different now:
put the old history back with `git reset --mixed "$PRE_SQUASH"`, which leaves the working tree
alone, commit what is still dirty without `LOG`, and say so in the summary.

Then show `git log --oneline -N` and name every file you left out and every choice you were
unsure of. After a squash, add per repo: the base, how many commits became how many, whether
the branch was already on the remote, and the undo command
`git reset --hard refs/yok/pre-squash/BRANCH`.

## Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/), unless `git log` shows the repo
follows another style; then match the repo. Take scopes from the ones `git log` already uses.

**The subject line is the whole message.** `type(scope): subject`, at most 72 characters, in the
imperative, with no trailing period: `fix(cart): round totals to two decimals`. Say what changed
for someone using the code, not which files moved.

The details belong in the pull request, so write a body only for what the PR cannot hold once the
commit is read alone in `git log`:

- a breaking change: `!` after the type or scope, and a `BREAKING CHANGE:` footer saying what
  breaks;
- a reason the diff cannot show, in one or two lines;
- a ticket, as a `Refs: KEY-123` trailer, when the ticket is known.

No file lists, no step-by-step account, no test results.

## Edge Cases

- **Large changesets (50+ files)**: batch by directory/module.
- **Monorepo**: use package name as scope (`feat(api): ...`, `fix(web): ...`).
- **Pipeline artifacts under `.yok/`** reach reviewers out-of-band. `.gitignore` ignores `.yok/*` and lets a few paths back in with `!.yok/...` lines; commit only those. Any other `.yok/` path showing as trackable means the ignore rule is missing: restore `.yok/*` in `.gitignore`, commit that fix, and leave the artifact out.

## Scope Boundaries

This skill creates commits from the current working tree, after squashing the branch on the squash way in. It does not manage branches, rebase, amend or push, and it force-adds an ignored file only to keep one the squashed commits already held. In a run, `visual-pr` pushes and opens the PR.
