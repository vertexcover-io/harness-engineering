---
status: active
date: 2026-10-02
source: VER-294, .harness/hooks-notifier/artifacts/design.md
tags: [subscribers, event-store, sdk, sdk-to-core]
---

# The SDK calls an event's subscribers right after storing it; blocking by default, detached on request

## Context and Problem Statement

v2 must run project subscribers and a Slack notifier when run events are stored, without a subscriber ever breaking the run. Events are stored by many short-lived processes: orchestrate commands, the agent's hooks, the server, and skill scripts that load only the SDK.

## Considered Options

- The SDK calls the subscribers in `appendRunEventIf`, after the state lock is released: a blocking subscriber (the default, as in v1) is awaited; a `blocking: false` subscriber runs in a detached SDK runner (`subscribers.ts` run as a script) that records its own call
- A detached orchestrate dispatcher in core fires every subscriber, started after each event
- An in-process listener core registers at startup

## Decision Outcome

Chosen: the SDK calls the subscribers, because it is the one path every writer goes through, so an event stored by an SDK-only skill script fires its subscribers too, and blocking-by-default keeps v1's model. A core dispatcher or listener only fires for processes that load core. A subscriber that throws, exits non-zero or times out becomes a failed `subscriber.called` record and never fails the append. Only the process that newly stores an event calls its subscribers, so each fires once per event. A non-blocking function runs in a detached runner, not un-awaited, because orchestrate commands exit right after storing their event; the runner is short-lived, so ADR 0002's no-long-lived-process rule holds. This extends ADR 0003: the SDK runs subscribers only as module paths or commands frozen into `state.json` at init, so core's notifier reaches it as a module path, never as an import.

## Consequences

A slow blocking subscriber slows every append it listens to, including the agent's hooks; slow subscribers should set `blocking: false`. Subscribers never run inside the state lock, so a subscriber may store events of its own.
