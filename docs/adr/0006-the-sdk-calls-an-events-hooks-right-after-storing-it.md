---
status: active
date: 2026-10-02
source: VER-294, .harness/hooks-notifier/artifacts/design.md
tags: [run-hooks, event-store, sdk, sdk-to-core]
---

# The SDK calls an event's hooks right after storing it; blocking by default, detached on request

## Context and Problem Statement

v2 must run project hooks and a Slack notifier when run events are stored, without a hook ever breaking the run. Events are stored by many short-lived processes: orchestrate commands, the agent's hooks, the server, and skill scripts that load only the SDK.

## Considered Options

- The SDK calls the hooks in `appendRunEventIf`, after the state lock is released: a blocking hook (the default, as in v1) is awaited; a `blocking: false` hook runs in a detached SDK runner (`run-hooks.ts` run as a script) that records its own call
- A detached orchestrate dispatcher in core fires every hook, started after each event
- An in-process listener core registers at startup

## Decision Outcome

Chosen: the SDK calls the hooks, because it is the one path every writer goes through, so an event stored by an SDK-only skill script fires its hooks too, and blocking-by-default keeps v1's model. A core dispatcher or listener only fires for processes that load core. A hook that throws, exits non-zero or times out becomes a failed `hooks.hook.called` record and never fails the append. Only the process that newly stores an event calls its hooks, so each fires once per event. A non-blocking function runs in a detached runner, not un-awaited, because orchestrate commands exit right after storing their event; the runner is short-lived, so ADR 0002's no-long-lived-process rule holds. This extends ADR 0003: the SDK runs hooks only as module paths or commands frozen into `state.json` at init, so core's notifier reaches it as a module path, never as an import.

## Consequences

A slow blocking hook slows every append it listens to, including the agent's hooks; slow hooks should set `blocking: false`. Hooks never run inside the state lock, so a hook may store events of its own.
