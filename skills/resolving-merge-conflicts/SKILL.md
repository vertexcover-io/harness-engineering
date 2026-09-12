---
name: resolving-merge-conflicts
description: "Resolves an in-progress git merge or rebase conflict by recovering the intent behind each conflicting change, then finishing the merge. Use when a merge, rebase, cherry-pick or stash pop has stopped with conflicts, when git reports 'CONFLICT', 'Unmerged paths', 'fix conflicts and then commit', or 'could not apply', and whenever the user says 'resolve the conflicts', 'fix the merge', 'rebase onto main', 'this won't merge' or asks what to keep from which side. Handles the conflict only: git-commit groups and writes ordinary commits, and neither creates branches nor pushes."
---

# Resolving merge conflicts

A conflict is two intents meeting, not two texts. Recover both intents before touching a hunk, or
the resolution compiles and means the wrong thing.

1. **See the current state** of the merge/rebase. Check git history, and the conflicting files.

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
against `git-commit`, step 4 names where a harness repo keeps its check commands, the reporting line
is new, and step 5 defers to a project that asks before committing.
