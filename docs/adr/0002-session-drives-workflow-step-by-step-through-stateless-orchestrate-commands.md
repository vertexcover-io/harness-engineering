---
status: active
date: 2026-09-28
source: .harness/interactive-workflow/design.md
tags: [workflow-engine, orchestrate-script, event-store]
---

# The session drives a workflow step by step through stateless orchestrate commands

## Context and Problem Statement

`runWorkflow` ran a whole v2 workflow in one async call, so the Claude session could not see, log or pace each step. The session needs to drive the run one step at a time and survive a restart between steps.

## Considered Options

- Stateless orchestrate commands: `bun run orchestrate next` decides the next step from `workflow.yaml` and `state.json` and writes the node events itself; `exec` and `done` record how a step ended
- A long-running engine on the harness server that keeps the run in memory and pushes each step to the session
- Keep `runWorkflow` and let the session only start and watch it

## Decision Outcome

Chosen: stateless orchestrate commands, because every decision is recomputed from the saved state, so no process must stay alive and a crashed or compacted session resumes with the next `next`; and the v2 architecture already routes every skill action through the orchestrate script, which calls core directly. The engine, not the skill, evaluates `when`, `switch`, `loop` and `include` and records every node event; the skill only runs the leaf it is handed.

## Consequences

Node events carry input, output and placement (`parentNodeRunId`, `iteration`, `branch`), and `runWorkflow` and `decideNext` must keep the same workflow semantics. Skills write run events without the server, which supersedes ADR 0001.
