---
status: active
date: 2026-10-03
source: .harness/yok-distribution/design.md, docs/plans/2026-10-02-yok-distribution-plan.md
tags: [harness-cli, agent-plugin, release-pipeline]
---

# v2 ships as one compiled `yok` binary plus an agent plugin at the same version

## Context and Problem Statement

A user's project has no bun, no node and no checkout of this repo, yet v2 ran as bun scripts, `bun run …` commands and `@harness/*` packages resolved from this repo's `node_modules`.

## Considered Options

- One `bun build --compile` binary per platform carrying the CLI, orchestrate and the SDK, plus the Claude/Codex plugin (the skills and their scripts, run through `yok orchestrate skill run`) installed at the binary's own tag; one `install.sh` installs both
- Publish `@yok/*` packages to npm and have users install them with a package manager
- Keep running bun scripts from a checkout of this repo

## Decision Outcome

Chosen: one compiled binary plus a version-matched plugin, because it is the only option that runs on a machine with neither bun nor node: the bun runtime is inside the file, and one shell script installs everything with no npm account or registry. npm packages need node or bun installed and let the SDK drift from the CLI; a checkout needs bun and this repo on every user's machine.

## Consequences

Code must never assume a `.ts` source file, a `bun` on PATH or this repo's `node_modules` at run time; what it reads or spawns beside its source must be embedded or routed through the binary itself.
