---
status: inactive
date: 2026-09-27
source: .harness/event-emitter/design.md (D6)
tags: [harness-cli, harness-server, cli-to-server, event-store]
---

# Skills write run events through the harness server, never by appending to event.jsonl

## Context and Problem Statement

Skills running inside a harness session need to add events to their run's `.harness/NAME/event.jsonl`. The `harness` CLI could append to that file itself, or send each event to the harness server.

## Considered Options

- CLI sends events to the server: `harness emit` calls `POST /runs/:id/emit`, and the server appends through `storeEmitter(jsonlEventStore(run.task.dir))`
- CLI appends to `event.jsonl` itself with core's `jsonlEventStore` (safe, since appends take a file lock)

## Decision Outcome

Chosen: CLI sends events to the server, because the server owns storage: it alone maps a run to its task folder (its `registry.json`), picks the event store, and is where event hooks will run. A direct write would work when the server is down, but would split those decisions between two processes.

## Consequences

`harness emit` needs a running server and an initialized run (404 unknown run, 409 no task). Any new CLI command that writes a run's events or task files goes through a server route too.
