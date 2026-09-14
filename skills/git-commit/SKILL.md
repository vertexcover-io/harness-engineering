---
name: git-commit
description: "Analyzes dirty working trees, groups related changes into logical commits using hunk-level staging, and writes conventional commit messages. Use when the user asks to commit their changes or split them into separate commits, including \"save my work to git\" or \"organize my git changes\". Does not handle branch management, rebasing, merging, or pushing."
model: sonnet
---

# Git Commit

Analyze a dirty working tree, understand the intent behind changes, group related modifications into logical commits, and write well-formed commit messages.

## Project-Specific Guidelines

1. If `$ARGUMENTS` holds a path to an existing file, other than a flag's value, read it and
   prioritize its guidelines over the defaults below. The one flag is `--working-commits PATH`,
   covered below.
2. Otherwise, use the defaults below.

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

### Step 1: Reconnaissance

Read the status, the full diff, the staged diff and recent `git log`. Also check for commit convention configs (`commitlint.config.*`, `.czrc`, `CONTRIBUTING.md`). Match whatever conventions the project already uses — consistency with the repo matters more than any spec.

Classify every path: modified tracked files, untracked files, deletions, already-staged changes, binaries, submodules.

### Step 2: Understand Intent

Read the diffs and figure out what the developer was trying to do. Start with test files — test names are the strongest signal for intent (`test('should reject invalid email')` tells you this is about email validation).

Then read implementation diffs. Use file proximity as a grouping signal — changes in the same module/directory usually belong together unless the diff shows otherwise.

### Step 3: Group Changes Into Commits

Each commit should represent one logical concern. Grouping priorities:

1. **Feature + its tests = one commit.**
2. **Refactor is separate from feature.** Restructured code AND new behavior → split them.
3. **Config/tooling changes are separate** unless inseparable from a feature.
4. **Dependency updates are separate** unless a new dep is required by a feature in the same commit.
5. **Bug fixes are atomic.** A fix and its regression test = one commit.
6. **A lock file goes in the same commit as its manifest.**

When a single file has mixed concerns, use hunk-level staging to split it across commits. See `references/hunk-staging.md` for techniques.

**Plan every commit before staging any:** which files and hunks go into each one.

### Regrouping squashed work

A caller that has squashed a branch's commits back into the working tree passes
`--working-commits PATH`: the log of the commits it undid, oldest first. The working tree holds
the finished change, and the log says how it was built.

- **Feature commit messages name the commits.** A message like `feat(auth): add token refresh`
  marks one logical change. Start from these, then merge or split them the way Step 3 would.
- **Fix, review, verify and WIP commits fold into the feature they repaired.** That work never
  shipped, so the repair is part of it. Put each of their hunks in the commit whose code it
  touches.
- **Every tracked change belongs to the run.** Files marked intent-to-add (`git add -N`) are
  files the run created, so Principle 2 does not apply to them. Commit every tracked change,
  because the caller checks that none is left.

### Step 4: Execute Commits

For each commit in the plan, in order:

1. Stage its files, or its hunks for a split file.
2. Check `git diff --cached --stat` holds exactly that commit.
3. Commit, passing the message through a HEREDOC.

After all commits, show `git log --oneline -N`, then name every file you left out and every
choice you were unsure of.

Respect any already-staged changes — incorporate them into the plan rather than unstaging them.

## Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/), unless `git log` shows the repo
follows another style; then match the repo. Take scopes from the ones `git log` already uses.

## Edge Cases

- **Large changesets (50+ files)**: batch by directory/module.
- **Monorepo**: use package name as scope (`feat(api): ...`, `fix(web): ...`).
- **Pipeline artifacts under `.harness/`** reach reviewers out-of-band. `.gitignore` ignores `.harness/*` and lets a few paths back in with `!.harness/...` lines; commit only those. Any other `.harness/` path showing as trackable means the ignore rule is missing: restore `.harness/*` in `.gitignore`, commit that fix, and leave the artifact out.

## Scope Boundaries

This skill creates commits from the current working tree. It does not manage branches, rebase, squash, amend, push, or force-add ignored files. A caller that wants a branch squashed resets it and passes `--working-commits`.
