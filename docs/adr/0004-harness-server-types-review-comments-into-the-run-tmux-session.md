---
status: active
date: 2026-10-02
source: .harness/artifact-viewer/design.md
tags: [harness-server, orchestrate-script, harness-server-to-session]
---

# The harness server types review comments into the run's tmux session; the agent arms nothing

## Context and Problem Statement

Only planning lets a user comment on a page, and its agent must arm, re-arm and kill a background watcher to hear comments; every other artifact is reviewed in the terminal. The user wants one viewer for any artifact whose comments reach the agent on their own.

## Considered Options

- The harness server serves one page per run and types each comment batch into the run's tmux Claude session; comments live in `.harness/NAME/comments.json`; the agent replies with `orchestrate comments reply`
- Plannotator-style blocking review (agent frozen, no replies)
- Planning's background wait watcher in every skill (arm, re-arm, kill; missed batches)
- Comments only in server memory, or only in `event.jsonl`
- A separate proxy process

## Decision Outcome

Chosen: server-typed delivery with `comments.json`, because the agent keeps working and arms nothing, comments survive restarts and a thread reads as a thread, and no skill carries watcher logic.

## Consequences

Skills must not add their own comment watchers; the planning skill's own viewer and watcher are a known exception until it moves onto this viewer (deferred in .harness/artifact-viewer/design.md, D14); `comments.json` is written by both the server and orchestrate. Delivery depends on reading Claude Code's screen state in tmux.
