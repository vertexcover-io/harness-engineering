---
status: active
date: 2026-10-01
source: VER-290
tags: [sdk, core, sdk-to-core]
---

# The sdk's public entry is a curated list for extension authors; engine pieces sit behind @harness/sdk/internal

## Context and Problem Statement

`@harness/sdk` had grown into "whatever core and the skill scripts share", and keeping the built-in hooks there forced core to inject functions into `HookDeps`.

## Considered Options

- Keep event and state.json logic in sdk, export engine-only pieces from a second entry `@harness/sdk/internal`, and move built-in hooks and the Claude agent into core.
- Move state.json projection into core and make the sdk's `emitRunEvent` append-only, with core folding new events in at its next action.
- Keep everything in sdk and export engine pieces from the main index.

## Decision Outcome

Chosen: keep state in sdk behind `@harness/sdk/internal`, because emitting an event and updating state.json stay one call, so state.json never lags the log, while the main entry stays a short list for people writing stage scripts, verifiers, event handlers and checks. Built-in hooks live in core, so `HookDeps` carries no injected functions; `packages/agents` was folded into core to avoid an import loop.

## Consequences

A new sdk export goes in the public allowlist (`packages/sdk/src/boundaries.test.ts`) or in `internal.ts`. `internal` is a convention for core, server and cli; only skill scripts are blocked by a test.
