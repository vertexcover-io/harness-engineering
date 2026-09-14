---
name: resolve-merge-conflict
description: "Resolves git merge and rebase conflicts, stopped locally or reported on an open pull request, by recovering the intent behind each conflicting change, then finishing the merge. Use when a merge, rebase, cherry-pick or stash pop has stopped with conflicts, when git reports 'CONFLICT', 'Unmerged paths', 'fix conflicts and then commit', or 'could not apply', when a pull request shows 'This branch has conflicts that must be resolved', and whenever the user says 'resolve the conflicts', 'fix the merge', 'the PR has conflicts', 'the rebase onto main stopped', 'rebase conflict', 'this won't merge' or asks what to keep from which side. Handles conflicts only — git-commit writes ordinary commits. Pushes only to return an open PR's resolution, and asks first."
---

# Resolving merge conflicts

A conflict is two intents meeting, not two texts. Recover both intents before touching a hunk, or
the resolution compiles and means the wrong thing.

## When the conflict is on an open PR

Nothing has stopped locally yet, so bring the conflict here first, then run the steps below.

1. Stop if the working tree is dirty and say so. Never stash or discard someone's uncommitted work.
2. `gh pr checkout NUMBER`, then `gh pr view NUMBER --json baseRefName,baseRefOid,url`. BASE is the
   branch the PR targets; BASE_OID is its tip on GitHub right now.
3. Fetch BASE from the remote that points at the PR's repository, the OWNER/REPO in `url`. In an
   ordinary clone that is `origin`. In a fork, `origin` is the fork and its BASE can be long out of
   date, so use the upstream remote. `git fetch REMOTE BASE && git merge REMOTE/BASE`. Merge, not
   rebase: a rebase rewrites a branch other people may have pulled, and needs a force push. Rebase
   only when asked to.
4. Once **Finish the merge/rebase** below is done, prove the base is current:
   `git merge-base --is-ancestor BASE_OID HEAD` must exit 0. Anything else means a stale copy was
   merged; fetch from the right remote and merge again.
5. Show the resolution and ask before pushing, unless the run is unattended. Then `git push`. If a
   rebase was asked for, `git push --force-with-lease`, never `--force`. If the push is refused, as
   on a fork without maintainer edits, stop and report it.
6. Done when `gh pr view NUMBER --json mergeable` reports `MERGEABLE`. `UNKNOWN` means GitHub is
   still computing; check again. `CONFLICTING` means the base moved while you worked; go back to
   step 2.

## Steps

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.
   Then check the incoming side is not a stale copy. Name it from the first line of MERGE_MSG
   (`Merge branch 'NAME'`; `git rev-parse --git-path MERGE_MSG` finds the file, worktrees included),
   or for a rebase from `git reflog -1` (`rebase (start): checkout NAME`). Run `git fetch`, then
   `git merge-base --is-ancestor NAME@{upstream} INCOMING`. INCOMING is `MERGE_HEAD`, or for a
   rebase the commit in `git rev-parse --git-path rebase-merge/onto`. When NAME is already a remote
   ref such as `origin/main`, compare against NAME itself. Exit 1 means the incoming copy is behind
   its remote: say so, finish this resolution, then merge or rebase onto the fresh copy and resolve
   what that brings. Never abort to restart. With no upstream to compare against, say the check
   could not run.

2. **Find the primary sources** for each conflict. Understand deeply why each change was made, and
   what the original intent was. Read the commit messages, check the PRs, check original
   issues/tickets.

3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one
   matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always
   resolve; never `--abort`.

4. Discover the project's **automated checks** and run them, typically typecheck, then tests, then
   format. Fix anything the merge broke. In a harness repo the commands are already named per
   package in `orchestrate.config.json`; read them from there rather than guessing.

5. **Finish the merge/rebase.** Stage everything and commit. If rebasing, continue the rebase
   process until all commits are rebased. The concluding commit is the merge's own, not a change of
   yours — but where the project asks to be consulted before committing, show the resolution and
   wait, unless the run is unattended.

## Reporting

Say which side won each incompatible hunk and why, in one line each. A resolution nobody can audit
is a silent rewrite of somebody's change.

## Source

Adapted from [mattpocock/skills](https://github.com/mattpocock/skills/tree/main/skills/engineering/resolving-merge-conflicts)
(MIT). The five steps are his. Changed here: the description carries triggers and a boundary
against `git-commit`, step 4 names where a harness repo keeps its check commands, the reporting line,
the open-PR section and the stale-base checks are new, and step 5 defers to a project that asks before committing.
