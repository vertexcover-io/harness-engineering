---
status: active
date: 2026-10-02
source: VER-294, .harness/hooks-notifier/artifacts/design.md
tags: [run-hooks, orchestrate-config, workflow-engine]
---

# A run hook is a module export or a shell command, declared in the config and added to per workflow

## Context and Problem Statement

Projects need their own code to run on run events, as v1 allowed (andromeda's Asana hooks). v2 must say what a hook is, what it receives, and where a project declares it.

## Considered Options

- A module export or a shell command, keyed by event type, declared under `hooks` in `orchestrate.config.yaml` and added to by the workflow file; frozen into `state.json` at init, config first
- Module exports only, like `eventHandlers`
- One place to declare: the config only, or the workflow only

## Decision Outcome

Chosen: module export or shell command, from config and workflow, because a project's hooks may be in any language (a shell command reads `{ event, state, run }` as JSON on stdin), and a project wants defaults for every workflow plus extras for one. Hooks are keyed by v2 event types, not v1's named moments, so a hook can listen to any event the log records. A hook keeps values between calls by storing `custom.state.updated`, which merges into `state.custom` by top-level key. v1's `required` and `prompt` hooks are not carried over: no hook may halt the run.

## Consequences

The stdin payload `{ event, state, run }`, the `hooks` keys (with `blocking` and `timeoutSeconds`) and the hook names (unique per event type; `notifier` is reserved for the built-in Slack notifier) are a contract project hooks depend on.
