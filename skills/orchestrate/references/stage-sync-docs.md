# Sync Docs

`set-status sync-docs running`. Resolve this stage's skill from [config.md](config.md) and invoke
it in this conversation.

It runs after the gate and before the commit, so the doc changes ship with the code that made them
stale. Its own edits are therefore not gated; that is deliberate, because a doc fix cannot break a
build the gate already passed.

Pass `<MODE_ARG>`, `<PLAN_PATH>`, the phase files, and `<HARNESS_DIR>`. Return the documents
updated and created.

`write-report sync-docs`, then `set-status sync-docs done`.

## Resumed runs

Run once per `TARGETS[]` entry, in that entry's own worktree. commit-pr pushes every entry, so
syncing only the primary would ship the rest with docs the change already made stale.

## Halts

| Code | Meaning |
|---|---|
| Skill error or `BLOCKED` | report the document it stopped on and the next action |
