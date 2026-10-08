# How to change it

Recipes for the changes people make most. Each one says where the code goes, what else must move with it, and how to prove it works. The first question for any change is from [Core principles](03-core-principles.md): is this a decision, a performance, or a record? Decisions go in the engine, performances in skills, records through events.

Before any of these: read the repo's `CLAUDE.md`. It has the style rules, and the rule that the project uses test-first development.

## Add a stage

A stage is a skill folder with a stage contract.

1. Make `skills/NAME/SKILL.md`. The frontmatter `name` must equal the folder name. Copy the shape from a small one such as [skills/baseline/SKILL.md](../../skills/baseline/SKILL.md). The fields are explained under Stage in [Concepts](06-concepts.md).
2. If the stage returns JSON, write its output schema in a script beside it and export it as `schemas["NAME.output.v1"]`. Point `outputs.module` at that file. The demo stages do this in [demo-workflows/stages/schemas.ts](../../demo-workflows/stages/schemas.ts).
3. Write the body as instructions to the agent. Say exactly which files to write under `.yok/RUN_NAME/artifacts/` and exactly what to reply. Load the `writing-style` skill while you write it.
4. Add a node to a workflow: `type: agent`, `stage: NAME`, `dependsOn`, and the `input` it needs.
5. `yok-dev verify workflows/task.yaml` must pass.
6. Run it. A demo workflow with your stage in it is faster than the real one.

A stage's scripts are declared as `references` and run with `yok orchestrate skill run NAME.REF`. Never tell the agent to run a script by path. That is what lets a project replace it.

## Change a shipped stage for one project only

Do not edit the skill. In that project's `orchestrate.config.yaml`:

```yaml
extensions:
  implement:
    skill: .yok/extensions/implement.md
    references:
      testing: { extend: docs/testing.md }
```

The agent reads your file after the skill's, and your reference text after the skill's. For a script, `{ command: "…" }` or `{ replace: path }`. The resolution is [loadSkill](../../packages/core/src/stage.ts#L323).

## Add an action a skill can take on a run

Every action a skill takes is a subcommand of `yok orchestrate`. Not a server route, not a `yok` command for people. This is in `CLAUDE.md` and in [principle 9](03-core-principles.md).

1. Put the logic in [packages/core/src/runs.ts](../../packages/core/src/runs.ts) or a sibling, as a plain function that takes a `RunRef` and returns a `Result`.
2. Add the command in [packages/core/src/orchestrate.ts](../../packages/core/src/orchestrate.ts). Take the run with `--run NAME` or `--run-id ID`, falling back to `$YOK_RUN_ID`, the way the others do. Print one JSON reply.
3. If the action changes the run, it must do so by appending an event, never by editing `state.json`.
4. Test it in `orchestrate.e2e.test.ts`, which runs the real command against a temporary repo and home.
5. Tell the agent about it in [skills/orchestrate/SKILL.md](../../skills/orchestrate/SKILL.md) if the agent is meant to call it.

## Add a command a person types

1. Make `packages/cli/src/NAME.ts` exporting `nameCommand()` that returns a Commander `Command`.
2. Register it in [packages/cli/src/index.ts](../../packages/cli/src/index.ts).
3. If it needs the server: parse flags, `await ensureServer()`, call one route through `yokClient()`, print the reply. If it needs a new route, add it in `packages/server/src/` and its typed client method in `client.ts`.
4. Errors go through `fail()` so the exit code and `LOG_LEVEL=debug` behave like the other commands.

## Add a fact to the record

A new event type.

1. Add the name to `EventTypeSchema` in [packages/sdk/src/contracts.ts](../../packages/sdk/src/contracts.ts#L188).
2. Define its payload schema in [packages/sdk/src/events.ts](../../packages/sdk/src/events.ts) beside the others.
3. If it should change state, add a handler to [builtInHandlers](../../packages/sdk/src/events.ts#L816) that returns the new state, and add the field to `StateSchema` in `contracts.ts` if it is new. Handlers are pure: state in, state out.
4. Emit it with `appendRunEvent`. Nothing else writes the log.
5. Add a case to `events.test.ts` and `state.test.ts`.

If the fact only matters to one project, do not add a type. Use `custom.state.updated` through an `eventHandlers` entry in that project's config.

## Change how the next node is chosen

This is the engine's heart. Read [One task, end to end](05-one-task-end-to-end.md) hop 4 first.

- `decideStart` in [next.ts](../../packages/core/src/workflow/next.ts#L227) says whether a node may start. `when`, `dependsOn`, `always`, and consumed artifacts are all here.
- `executeNodes` walks a list. Each container type has its own walker below it.
- Every decision must leave an event. If you add a way for a node to be passed over, record it as `workflow.node.skipped` with a reason.
- `next.test.ts` has a fake stage set in `test-stages.ts`. Add a workflow fixture that shows the new behaviour and assert on the events it writes, not just the reply.

## Add a node type

The most expensive change. Touch, in this order: the schema in `workflow/types.ts`, compilation in `compile.ts`, the walk in `next.ts`, the reply in `runs.ts` `buildLeafReply`, and the `kind` handling in `skills/orchestrate/SKILL.md`. Add it to `demo-workflows/kitchen-sink.yaml` so the e2e suite covers it, and to the Node table in [Concepts](06-concepts.md). Ask whether a `switch` or an `exec` node could do the job first.

## Add or change an agent hook handler

1. Write the handler in `packages/core/src/hooks/NAME.ts` with the handler type for that hook, and add it to that file's handlers map.
2. Register it for Claude in `claudeHooks()` in [claude-hooks.ts](../../packages/core/src/agents/claude-hooks.ts#L351), and for Codex in `codex-hooks.ts` if it applies.
3. A handler must never throw out. The Stop handler wrapper allows the turn to end on any error, because a hook that fails could trap the session. Keep that property.
4. Record what the handler decided as a `hooks.*` event so a run can be read back.

## React to a run from a project

A subscriber, not a hook. In the project's config:

```yaml
subscribers:
  workflow.completed:
    - { name: announce, module: .yok/subs.ts, handler: announce }
```

The module imports `@yok/sdk` and `zod` and nothing else without its own `node_modules`. It gets `{ event, state, run }`. Keep blocking ones under 25 seconds or set `blocking: false`.

## Record a decision

A change that picks one way over another and will bind later code gets an ADR. Run the `adr` skill, or write `docs/adr/NNNN-title.md` by hand and add the row to `docs/adr/INDEX.md`. The planning stage reads the index, so a recorded decision is one the agent will respect.

When you add a noun people will say out loud, add it to [GLOSSARY.md](../../GLOSSARY.md) with the words to avoid.

## Before you open a PR

```bash
bun run check
```

Zero typecheck errors, zero lint errors, zero failed tests. Then the normal flow: a branch, conventional commits, a PR with the change outline. The repo has the `git-commit` and `visual-pr` skills for that. Ask before committing; the one exception is a `yok run` workflow, whose commit and pr stages commit without asking.
