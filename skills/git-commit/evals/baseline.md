# Baseline — 2026-09-14, Sonnet 5

Each eval ran headless (`claude -p --setting-sources project --disallowedTools Skill`) in the
repo `files/make-fixture.sh` builds. "None" had no skill loaded; "skill" had SKILL.md appended to
the system prompt.

| Eval | None | Skill |
|---|---|---|
| 1 commit my changes | lumped 4 files into one commit | 3 commits: docs, feat with its test, chore |
| 2 split | split right | split right by hunk, fix with its test |
| 3 commit this | one commit, notes.txt left out | same |
| 4 regroup | stopped to ask | 2 feature commits, review and verify fixes folded in |
| 5 `.harness/` | committed the `.gitignore` that dropped `.harness/*` | restored the rule, left plan.md out |
| 6 lock file | lumped the README fix in with the dependency | separate commits, lock file with its manifest |

What the skill earns: grouping (1, 6), the `.harness/` guard (5), the squash regroup (4), and
never stopping to ask (4).
What it did not need: commit message rules. Every run with no skill wrote correct conventional
messages through a HEREDOC, so that section was cut.
