---
status: active
date: 2026-10-03
source: .harness/yok-distribution/design.md, docs/plans/2026-10-02-yok-distribution-plan.md
tags: [harness-cli, harness-server-to-session, agent-plugin]
---

# Skills call plain `yok`; a per-program PATH shim makes it the program that started the session

## Context and Problem Statement

A developer keeps the release `yok` and a dev copy `yok-dev` side by side, and skill text run inside an agent session must reach whichever of the two launched that session, with nothing set by hand.

## Considered Options

- Before each launch, write `HOME/shims/HASH/yok` (HOME is `~/.yok` for the binary and `~/.yok-dev` from source; HASH of `selfArgv()`; a symlink to the binary, or a two-line exec script for dev), never deleted, and put its folder first on the session's PATH; dev runs also load the repo with `claude --plugin-dir`
- The same shim, but per run id and deleted when the run ends
- One shared home and server for both programs, with each run sending its own argv for the server to build the shim from
- Skills name `$YOK_BIN` instead of plain `yok`
- Skills say `yok` and the session uses whatever `yok` is on the user's PATH

## Decision Outcome

Chosen: a per-program shim, because skill text stays plain `yok`, which agents copy more reliably than a variable and no build has to rewrite, while release and dev never mix: each session's `yok` is the program that launched it. A per-program shim holds nothing run-specific, so it needs no cleanup state, unlike a per-run one; the user's PATH alone would send a dev run's skills to the release binary. Dev runs load the repo with `--plugin-dir` so the agent and orchestrate read the same skills. The two programs keep separate homes (`~/.yok`, `~/.yok-dev`) and tmux sockets, because the CLI reuses any server already answering in its home and that server builds the shim from its own argv: a shared home would let a release run launch sessions that call `yok-dev`.

## Consequences

Skill text and printed hints must say plain `yok`, never an absolute path or `$YOK_BIN`; a session opened by hand has no shim and gets the release binary. A run started by one program is not visible in the other's `yok view`; `YOK_HOME` overrides either home.
