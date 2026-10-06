---
status: active
date: 2026-10-05
source: .harness/stage-tier-model-mapping/artifacts/design.md
tags: [workflow-engine, orchestrate-script]
---

# A stage's tier switches the Claude session's model between stages, by resuming the session on that model

## Context and Problem Statement

Stages declare a `tier` in their SKILL.md, but a run used one model for every stage, so cheap stages ran on the deep model. A stage must run on the model its tier maps to without losing the session's conversation.

## Considered Options

- Switch the live session's model between stages
- Run each stage as a sub-agent on its tier's model
- Start a fresh session on the tier's model at each switch

## Decision Outcome

Chosen: switching the live session, because it keeps the conversation and the questions design and planning ask the user; a sub-agent cannot ask the user questions, and a fresh session drops the chat at every switch. An agent node runs on the first tier set of: its own workflow `tier:`, its stage's SKILL.md `tier:` (optional), the run's default tier; a node with neither runs on the default, so the session switches back to it. `orchestrate next` returns a `model` reply before an agent node whose model differs; the agent ends its turn; a helper started by the Stop hook relaunches the same session in its pane with `claude --resume SESSION --model X --effort Y`, records `workflow.model.applied`, and passes the resume prompt as the first message. Typing `/model` was rejected: Claude saves it as the user's default for every new session.

A run's tiers merge three layers in order: the harness's built-in set (Claude and Codex each have one: `default: deep`, `fast` and `deep` models), the config's `agents.AGENT.tiers`, then the workflow's `tiers`, each `{ default, models }`; a later layer's model replaces an earlier one's of the same name, and the last `default` wins. The server merges them once at launch, stores the set on the run's registry record and launches on `models[default]`; `orchestrate init` copies that set into state.json without merging again, and fails when an agent node's tier, its own or its stage's, is not in the set. Switch progress is never stored in state.json: `next`, the Stop hook and the helper fold it from the event log, where each `workflow.model.applied` names the `requestSeq` it answers.

## Consequences

The orchestrate skill's `model` reply, the `tiers:` shape and the applied event's `requestSeq` are contracts; a failed relaunch fails that stage, and an unmapped node or stage tier fails init.
Codex launches on its default tier's model, `gpt-6-sol` at high effort unless the config or workflow changes it, and keeps that model for the whole run, since only Claude switches mid-session.
