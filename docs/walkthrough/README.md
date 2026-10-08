# Harness, for contributors

This walkthrough explains how the harness is built, for people who want to change its code. You
should be able to read TypeScript and have used Claude Code or Codex. You do not need to have read
any of this repo.

Read it in order the first time. After that, jump to what you need.

1. [The 30-second model](01-thirty-second-model.md): what a run is, and the four parts that make one happen
2. [Repo map](02-repo-map.md): what lives in each folder
3. [Running it locally](03-running-locally.md): install, check, run a workflow from your checkout
4. [Who calls what](04-who-calls-what.md): one run followed from `harness run` to the last `done`
5. [The workflow engine](05-workflow-engine.md): how a YAML file becomes nodes, and how `next` picks one
6. [Events and state](06-events-and-state.md): the event log, the registry, run hooks
7. [Agents and hooks](07-agents-and-hooks.md): how Claude and Codex sessions are driven, and how tiers switch the model
8. [Anatomy of a stage](08-anatomy-of-a-stage.md): one skill read top to bottom, then how to add your own
9. [Adding a node to a workflow](09-adding-a-node.md): change a workflow, check it, run it
10. [How we work here](10-how-we-work.md): TDD, Biome, strict TypeScript, Zod, ADRs
11. [Releases and packaging](11-releases-and-packaging.md): how the plugin ships
