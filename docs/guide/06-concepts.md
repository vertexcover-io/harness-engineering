# Concepts, one at a time

Each section here is one idea: what it is, the shape it has in code, and where it showed up in [One task, end to end](05-one-task-end-to-end.md). The glossary at [GLOSSARY.md](../../GLOSSARY.md) has the one-line definitions. This page has the detail.

## Workflow

A YAML file naming a graph of nodes. The engine walks it top to bottom, starting each node whose dependencies are done. [workflows/task.yaml](../../workflows/task.yaml) is the shipped one.

```yaml
name: task
inputs:
  prompt: { type: string, required: true }
  environment: { type: string, default: default }
doctor:
  - { check: env, key: LINEAR_API_KEY, fix: Set LINEAR_API_KEY in .env }
nodes:
  - id: design
    type: agent
    stage: design
    dependsOn: [baseline]
    input:
      task: "{{ nodes.ticket-fetcher.output.task }}"
```

Top-level keys: `name`, `inputs` (each with a type, `required`, and `default`), `doctor` (extra checks `yok run` makes before starting), `nodes`, and optionally `tiers`, `subscribers`, `notifier`, `env`, and `envFile`. A workflow's copy is frozen into `.yok/RUN_NAME/workflow.yaml` at init.

`yok verify workflows/task.yaml` compiles a workflow and prints the first error, so you can check a change without starting a run.

## Node

One step in the graph. Seven types. The schemas are in [workflow/types.ts](../../packages/core/src/workflow/types.ts).

| Type | What it does | Its own fields |
|---|---|---|
| `agent` | the agent does it: a `stage`, or a plain `prompt` | `stage`, `prompt`, `variables`, `output`, `tier` |
| `exec` | runs a script or a function, no agent | `runtime: sh\|bun` + `script`, or `module` + `functionName`; `mode: inline\|background`; `output` |
| `wait` | pauses the run | `durationMs` |
| `context` | gives the agent a fresh context | `action: new\|compact`, `prompt` for compact |
| `loop` | repeats its children | `until`, `maxIterations`, `nodes` |
| `switch` | picks one case of children by a value | `expression`, `cases` (each `id`, `value`, `nodes`), `default` |
| `include` | runs another workflow file inside this one | `workflow` |

Every node has `id`, `input`, `dependsOn`, `allowFailure`, and `always`. All but `switch` also take `when`. The leaf types (`agent`, `exec`, `wait`, `context`) also take `cwd`, `timeoutMs`, and `retry`.

- `dependsOn` lists node ids that must complete first. A dependency that was skipped skips this node too.
- `when` is an expression. False means skipped, with the reason recorded.
- `allowFailure: true` means this node failing does not fail the run.
- `always: true` means this node still starts after an earlier node in its scope failed. The retro node uses it. See [ADR 0008](../adr/0008-a-node-marked-always-still-starts-after-an-earlier-failure.md).

A **node run** is one execution of a node. A node inside a loop gets a new node run on each pass, so state keeps them apart.

## Expression

Anything in double braces, resolved by [evaluate.ts](../../packages/core/src/workflow/evaluate.ts) when `next` builds a node's input.

| Reads | Means |
|---|---|
| `{{ inputs.prompt }}` | a run input |
| `{{ nodes.design.output }}` | an earlier sibling node's whole output |
| `{{ nodes.ticket-fetcher.output.task }}` | one field of it |
| `{{ iteration.index }}`, `{{ iteration.max }}` | inside a loop, which pass this is |
| `{{ iteration.previous.bugs }}` | the previous pass's output |
| `{{ iteration.nodes.qa.output.status }}` | a child's output in this pass, used by `until` |
| `{{ inputs.mode == 'quick' }}`, `{{ a != 'FAIL' }}`, `{{ n > 1 }}` | comparisons, for `when` and `until` |

Today an expression reaches only sibling nodes. Reading into a loop or include from outside is on the to-do list in `todo.md`.

## Stage

A skill that can run as a node. Its `SKILL.md` frontmatter is the contract, parsed by [StageSchema](../../packages/core/src/stage.ts#L75).

```yaml
name: planning              # must equal the folder name
description: …
mode: inline
allowed-tools: [Agent, Bash, Read, Write, …]
tier: deep
inputs:  { description: …, schema: planning.input.v1 }
outputs: { description: …, schema: planning.output.v1, module: scripts/plan.ts }
consumes: [{ artifact: design }]
produces: [{ artifact: plan }]
references:
  plan-format: { path: references/plan-sections.md, description: … }
verifiers:
  - { id: has-phases, module: scripts/verify.ts, functionName: hasPhases }
variables:
  provider: { description: …, default: auto }
```

- `outputs.schema` names a key in the `schemas` object the `module` file exports. `done` parses the output with it.
- `produces` and `consumes` are artifact names. A required produced artifact must be passed to `done`. A consumed one must exist before `next` will start the stage.
- `references` are files the agent loads on demand with `yok orchestrate skill ref STAGE.REF`, never by path, so a project's extension applies. A reference that is a script runs with `yok orchestrate skill run STAGE.REF ARGS`.
- `verifiers` run inside `done`. Each is a function (`module` + `functionName`) or a script (`runtime` + `script`) and must return `{ pass, findings }`.
- `variables` are named values the workflow's node can set, handed to the skill with the card.
- `tier` names the model class the stage wants.
- `mode`, `scopes`, and `protocols` are parsed and checked but nothing reads them yet. See "Not built yet" at the end of this page.

## Artifact

A file a stage writes under `.yok/RUN_NAME/artifacts/` and names when it calls `done`:

```bash
yok orchestrate done NODE_RUN_ID --run RUN_NAME --output - --artifact design=artifacts/design.md <<'OUT'
…
OUT
```

`done` checks the file is a real file inside `artifacts/`. Later, a stage that `consumes: [design]` gets the newest such artifact from any completed node. The lookup is [findConsumedArtifacts](../../packages/core/src/workflow/done.ts#L169). Outputs carry small values between nodes; artifacts carry documents.

## Verifier

A check a stage declares that `done` runs before accepting. It receives the run name, the node run id, the output, the artifacts by name, and its `args`. It returns `{ pass: boolean, findings: [{ message, path?, line?, hint? }] }`. A failing result needs at least one finding. The contract is [verifier.ts](../../packages/sdk/src/verifier.ts).

A finding sends the agent back to fix the work with the same node run id. A verifier that throws, times out, exits non-zero, or returns a bad shape is a `verifier-error`, also retryable. Every run of a verifier is recorded as an `orchestrate.verifier` event with its duration.

## Extension

A project's change to a shipped skill, in `orchestrate.config.yaml`:

```yaml
extensions:
  implement:
    skill: .yok/extensions/implement.md          # read after the skill; wins on conflict
    references:
      testing: { extend: docs/our-testing.md }   # appended after the skill's reference
      style:   { replace: docs/style.md }        # used instead of the skill's
      runbook: { add: docs/runbook.md, description: … }   # a new reference
  baseline:
    references:
      script: { command: "python tools/baseline.py" }  # runs instead of the skill's script
```

`next` puts the extension skill's path on the card. `yok orchestrate skill ref` and `skill run` apply the reference changes. The code is [loadSkill](../../packages/core/src/stage.ts#L323).

## Config

`orchestrate.config.yaml` at the repo root, `version: 2`. The schema is [ConfigSchema](../../packages/sdk/src/config.ts#L208).

| Key | What |
|---|---|
| `packages` | each part of the repo: `path`, `runner`, `commands` (`typecheck`, `lint`, `testAll`, `testFile`, `build`, …), `timeoutSeconds` |
| `baseline` | one command whose output the baseline stage stores |
| `doctor` | an extra check command |
| `environments` | named targets qa verifies against, with a `default` |
| `workspace` | `layout: mono\|multi`, `path` template, `baseBranch`, `setup`, `teardown` |
| `agents.claude.tiers`, `agents.codex.tiers` | model per tier, and the default tier |
| `extensions` | see above |
| `subscribers` | see below |
| `eventHandlers` | project functions that fold an event into `state.custom` |
| `env`, `envFile` | variables every session starts with |
| `notifier` | `{ enabled, type: slack }` |

Init freezes which config file a run uses into `state.json`, so a run keeps its settings even if you edit the file mid-run.

## Tier

A named model class. Built in for Claude: `fast` is `claude-sonnet-5-5`, `deep` is `claude-opus-5-5` at high effort, default `deep`. Layers merge in order: built-in, then the config's `agents.AGENT.tiers`, then the workflow's `tiers`. A later layer replaces a tier of the same name. An agent node runs on its own `tier`, else its stage's, else the run's default.

The server resolves the merged set once at launch and init copies it into state. When the next agent node's tier maps to a different model than the session is on, `next` replies `kind: model` and the Stop hook relaunches Claude on it with `--resume`. Codex does not switch. [ADR 0009](../adr/0009-a-stage-tier-switches-the-live-claude-session-model-between-stages.md).

## Event and state

An event is one line in `event.jsonl`: `seq`, `ts`, `type`, `source`, `runId`, optional `nodeId`, `nodeRunId`, `stage`, and a `payload`. The types are listed in [events.ts](../../packages/sdk/src/events.ts#L463). Families: `workflow.*` for the engine's decisions, `orchestrate.*` for each command call, `hooks.*` for agent hook calls, `agent.*` for limits, questions, and getting stuck, `artifact.comment.*`, `subscriber.called`, `workspace.*`, `custom.state.updated`.

`state.json` is the fold of every event through [applyEvent](../../packages/sdk/src/state.ts#L33). Its fields: `status`, `nodeRuns` (one entry per node, nested for containers), `workspace`, `activeSessions`, `tiers`, `stopHook`, `custom`, `config`. It is rewritten atomically after every event. Nobody edits it.

## Subscriber

Code your config or workflow attaches to an event type. It runs right after the event is stored and receives `{ event, state, run }`.

```yaml
subscribers:
  workflow.node.completed:
    - { name: notify-team, module: .yok/subs.ts, handler: onNodeDone }
    - { name: log-it, command: "jq .event.type >> /tmp/yok.log", blocking: false }
```

A module subscriber is an exported function. A command subscriber reads the JSON on stdin. Blocking subscribers are awaited, with a cap of 25 seconds because they may run inside an agent hook that Claude kills at 30. Detached ones get 60 seconds in a background runner. Config subscribers run before the workflow's. A subscriber fires at most once per event and is never retried. None can halt the run. The built-in Slack notifier is a subscriber named `notifier`. [ADR 0005](../adr/0005-a-subscriber-is-a-module-export-or-shell-command-from-config-and-workflow.md), [ADR 0006](../adr/0006-the-sdk-calls-an-events-subscribers-right-after-storing-it.md), [ADR 0007](../adr/0007-a-subscriber-fires-at-most-once-per-event.md).

## Agent hook

A point in the agent's own session where it calls out and waits for an answer. Yok registers five for Claude through `--settings` at launch, each answered by `yok orchestrate hook NAME --handler HANDLER`:

| Hook | Handler | What it does |
|---|---|---|
| SessionStart | `link-session` | records the session id on the run |
| Stop | `continue-workflow` | sends the agent back when it ends a turn with work owed |
| StopFailure | `resume-after-limit`, `record-agent-error` | on an API error that is a usage limit, pauses and resumes the run; otherwise records the error |
| PreToolUse | `record-guard`, `bash-antipatterns`, `question-notice` | refuses writes to the run's records, flags risky shell, records a question being asked |
| PostToolUse | `answer-notice` | records the person's answers to questions |

Agent hooks are about the session. Subscribers are about the run. They are different things with the same English word. The handlers live in [packages/core/src/hooks](../../packages/core/src/hooks).

## Context step and model switch

A `context` node with `action: new` replaces the session with a fresh one in the same tmux pane. `compact` compacts the one it has. Both start only when the agent ends its turn, because the Stop hook is what launches the helper. The new or compacted session receives `/yok:orchestrate --resume RUN_NAME` and continues. A model switch works the same way but keeps the conversation, using `claude --resume` on the new model. Codex has neither. The code is [context-step.ts](../../packages/core/src/context-step.ts).

## Limit wait

When Claude reports a usage limit, the StopFailure hook reads the reset time from the screen and starts a helper that waits, then types `continue`. With no reset time it waits 15 minutes and tries again, up to 20 times. Events `agent.limit.reached`, `agent.limit.waiting`, `agent.limit.resumed` record it. The code is [limit-wait.ts](../../packages/core/src/limit-wait.ts).

## Comment

A note you leave on an artifact in the viewer at `http://127.0.0.1:PORT/runs/RUN_ID`. The server stores it in `comments.json`, then types it into the run's tmux session the next time Claude's input box is empty. The agent answers with `yok orchestrate comments reply`. Nothing in a skill watches for comments. [ADR 0004](../adr/0004-harness-server-types-review-comments-into-the-run-tmux-session.md).

## Workspace

Where a run writes code. `layout: mono` means one repo: a worktree at `.worktrees/RUN_NAME` on a new branch off `baseBranch`. `layout: multi` means a folder with one worktree per repo the task touches. The create-workspace stage makes it and reports it as output. Every later stage reads `workspace` from its input and works in the `worktreeDir`.

## Registry and homes

`registry.json` in the yok home lists every run on the machine: id, workflow, inputs, cwd, name, tmux session, Claude session ids, tiers. The server adds a run; init names it; the SessionStart hook links sessions. It is read and written under a file lock by both the server and orchestrate.

The release binary's home is `~/.yok`. The dev build's is `~/.yok-dev`. Each has its own server, socket, and registry, so a dev run never reaches the release server or the other way round. `YOK_HOME` points either at another folder.

## Doctor

`yok doctor` checks what a run needs: git and a repo, jq, curl, tmux 3.3 or newer, the agent binary, the plugin at the binary's version, `.yok/` in `.gitignore`, exactly one `orchestrate.config.yaml`, and for QA `agent-browser` and `ffmpeg`. `gh` and `samskara` are optional. A workflow adds its own `doctor` block. `yok run` runs the same checks first and stops on any failure. The list is [CHECKS](../../packages/core/src/doctor.ts#L153).

## Not built yet

These show up in schemas or in conversation but have no behaviour behind them today. Knowing the list saves you a search.

| Thing | Where you see it | What it will mean |
|---|---|---|
| parallel nodes | two nodes with no `dependsOn` between them | they still run one at a time; `next` replies `waiting` while any step is open |
| `mode: subagent` | a stage's frontmatter | the stage would run in a sub-agent so another could run beside it; a detached mode as a separate headless session is also planned |
| `scopes` | a stage's frontmatter | a named level of rigour for a run, such as experiment or enterprise, that stages would read to decide how much to do |
| `protocols` | a stage's frontmatter | shared rules, such as a writing style, loaded into a stage without the skill naming them |
| `pi`, `opencode` | the agent type enum | more agents; only Claude and Codex have providers |
| auto mode | the roadmap | an unattended run that reports over chat when a ticket is beyond it, instead of asking questions |

Next: [Setup and first run](07-setup-and-first-run.md).
