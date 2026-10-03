---
status: active
date: 2026-10-02
source: VER-294, .harness/hooks-notifier/artifacts/design.md
tags: [run-hooks, event-store]
---

# A run hook fires at most once per event; a crash before it runs loses that call

## Context and Problem Statement

The ticket asks that each hook fire once. Hooks run from the process that stored the event, so a crash between storing an event and calling its hooks must either lose those calls or need something that catches up later.

## Considered Options

- At-most-once: hooks run only from the process that newly stored the event; a repeated event id or a crash runs nothing again
- At-least-once: a cursor in `state.json` plus a catch-up pass that fires every event's unrecorded hooks

## Decision Outcome

Chosen: at-most-once, because it needs no cursor and no catch-up process, and a crash in that window is rare in a short-lived orchestrate command. Each call's `hooks.hook.called` id (`hook:EVENT_ID:HOOK`) still stops a call from being recorded twice.

## Consequences

A hook can be skipped by a crash and is never retried. Moving to at-least-once later means a cursor in `state.json` and a catch-up step, as the rejected option describes.
