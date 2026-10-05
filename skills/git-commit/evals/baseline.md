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
| 5 `.yok/` | committed the `.gitignore` that dropped `.yok/*` | restored the rule, left plan.md out |
| 6 lock file | lumped the README fix in with the dependency | separate commits, lock file with its manifest |

What the skill earns: grouping (1, 6), the `.yok/` guard (5), the squash regroup (4), and
never stopping to ask (4).
What it did not need: commit message rules. Every run with no skill wrote correct conventional
messages through a HEREDOC, so that section was cut.

# Baseline for the squash path — 2026-10-03

Evals 7 to 10, prompt "Squash my commits", same headless setup. "None" ran on Sonnet; the skill
ran on Haiku, Sonnet and Opus. Each cell is what the repo held afterwards.

| Eval | None (Sonnet) | Skill, Haiku | Skill, Sonnet | Skill, Opus |
|---|---|---|---|---|
| 7 squash a pushed branch | one lump commit, README left uncommitted, no undo ref | pass: 3 commits, undo ref | pass: 2 commits, undo ref | pass: 3 commits, undo ref |
| 8 remote has a commit the checkout lacks | squashed anyway; a push would have wiped the remote commit | pass: stopped | pass: stopped | pass: stopped |
| 9 staged content differs from the working tree | squashed anyway | **fail**: squashed anyway | stopped, committed nothing | stopped, committed nothing |
| 10 force-added ignored file | one lump commit, file kept | **fail**: dropped `dist/bundle.js` and skipped the tree check | pass: file kept | pass: file kept |

What the skill earns: the stop on a diverged remote (8), the stop on staged-only content (9), the
undo ref and the regroup into feature commits (7, 10).

What changed because of this run: on eval 9 the skill said to skip the squash and commit what was
staged, but Sonnet and Opus both stopped and left the choice to the developer. That is the safer
reading, so the skill and the eval now say stop.

Haiku fails 9 and 10, so the stage declares `tier: deep`. Do not run this skill's squash path on
Haiku.

Not measured: the message rule (subject line only). The headless runs add their own
`Co-Authored-By` trailer, so a body is present in every run, with or without the skill. Evals 1
to 6 were not re-run after the rewrite.
