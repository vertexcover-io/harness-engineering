---
status: active
date: 2026-10-05
source: .harness/v1-retro-merge-conflict-skills/artifacts/design.md
tags: [workflow-engine]
---

# A node marked `always: true` still starts after an earlier node in its scope failed

## Context and Problem Statement

A failed node stops its scope: no later node starts. The task workflow must end with a retro that audits every run, and failed runs are the ones a retro helps most.

## Considered Options

- A node field `always: true`: the node starts after a blocking failure and after a skipped dependency; its `when` still applies and the run keeps its status
- Run the retro only when the run reaches its last node, and by hand after a failed run
- A subscriber on `workflow.failed` that starts the retro

## Decision Outcome

Chosen: `always: true`, because it keeps the retro a normal stage that `decideNext` hands to the session, while a subscriber is a module or shell command (ADR 0005) that cannot run a skill in the session, and an end-only node misses every failed run. Because the nodes it follows may never have run, an `always` node, and every stage inside an `always` container, may consume only optional artifacts, and an `always` node may not read `nodes.*` in its input, `when` or variables.

## Consequences

`always` is part of the workflow YAML contract; removing it breaks workflows that use it. A failed run now spends time on its `always` nodes before it finishes.
