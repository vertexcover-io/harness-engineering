# Core principles

These are the rules the design keeps. Each one says what it is, why we hold it, and what breaks if you ignore it. When a change feels awkward, check it against this list first. The awkwardness is usually a principle pushing back.

## 1. The engine decides and records. The agent performs.

`yok orchestrate next` evaluates every `when`, `dependsOn`, loop, switch, and template, and writes the start event. `yok orchestrate done` validates the result and writes the end event. The agent reads one card, does one piece of work, and reports.

**Why.** When the agent was the scheduler, one skipped sentence stopped a run or lost a record. Code does not skip sentences.

**If you ignore it.** You put a decision in a skill's prose, and one day the agent reads it differently. Put decisions in `packages/core/src/workflow` and nowhere else. Source: [ADR 0002](../adr/0002-session-drives-workflow-step-by-step-through-stateless-orchestrate-commands.md).

## 2. Nothing stays in memory between steps.

Every orchestrate command reads `state.json` and `event.jsonl`, recompiles the workflow, decides, writes, and exits. No daemon holds the run.

**Why.** Sessions crash, get compacted, hit usage limits, and switch models. A run must survive all of that, and a laptop reboot. If the truth is on disk, any process can pick up where the last one stopped.

**If you ignore it.** You cache something across calls and a resumed session gets a stale answer. Recompute from files. It is cheap.

## 3. Events are the truth. State is a summary.

`appendRunEvent` takes a lock, appends to `event.jsonl`, folds the event into `state.json`, and only then calls subscribers. Nothing else writes those files. A PreToolUse hook refuses any agent tool call that tries.

**Why.** A log you can replay is a run you can audit, resume, and learn from. A state file edited by hand is a story someone told.

**If you ignore it.** You write a field into state without an event and the next replay loses it. Add an event type and a handler that folds it. The guard is [recordGuard](../../packages/core/src/hooks/pre-tool-use.ts#L61); the fold is [applyEvent](../../packages/sdk/src/state.ts#L33).

## 4. A stage passes only with proof that code can check.

A stage's frontmatter declares its output schema, the artifacts it produces, and its verifiers. `done` refuses an output that does not parse, a required artifact that is missing, and a verifier that reports findings. Three rejections fail the node.

**Why.** "PASS" in prose shipped broken code. A schema does not have opinions about what the agent meant.

**If you ignore it.** You let a stage return free text and the next stage parses it with a regex. Declare the schema. The contract is [StageSchema](../../packages/core/src/stage.ts#L75); the gates are in [done.ts](../../packages/core/src/workflow/done.ts).

## 5. One binary. The user's machine has nothing else.

The release is a single compiled `yok` that carries the CLI, the engine, the server, the SDK, and zod. The skills ship as an agent plugin at the same version. Skill text says plain `yok`, and a PATH shim makes that word mean the program that started the session.

**Why.** A user's project has no bun, no node, and no checkout of this repo. Anything that assumes otherwise breaks on their laptop and not on ours.

**If you ignore it.** You spawn `bun`, read a `.ts` file beside your source, or import from `node_modules` at run time. Route it through the binary. Sources: [ADR 0010](../adr/0010-v2-ships-as-one-compiled-yok-binary-plus-a-version-matched-agent-plugin.md), [ADR 0011](../adr/0011-the-binary-serves-the-sdk-zod-and-notifier-to-extension-files.md), [ADR 0012](../adr/0012-skills-call-plain-yok-a-per-program-path-shim-picks-the-program.md).

## 6. Projects extend. They do not fork.

A project changes a shipped skill through `extensions` in its `orchestrate.config.yaml`: its own skill text, and references it replaces, extends, adds, or swaps for a command. A project reacts to events through subscribers. Neither can change what the engine decides.

**Why.** Twenty projects with twenty copies of `implement/SKILL.md` is twenty places to fix a bug.

**If you ignore it.** You copy a skill into a project to tweak one paragraph. Use `extensions.STAGE.skill` instead. Subscribers observe and never halt a run: [ADR 0005](../adr/0005-a-subscriber-is-a-module-export-or-shell-command-from-config-and-workflow.md), [ADR 0006](../adr/0006-the-sdk-calls-an-events-subscribers-right-after-storing-it.md), [ADR 0007](../adr/0007-a-subscriber-fires-at-most-once-per-event.md).

## 7. The person can leave.

The Stop hook sends an agent back when it ends a turn with work owed. The limit wait pauses and resumes when a usage cap resets. A model switch between stages needs no one. A comment left in the browser is typed into the agent's terminal by the server.

**Why.** The two audited runs spent most of their hours waiting on a human. Every wait we remove is hours saved.

**If you ignore it.** You add a step that needs a person to press a key, and the unattended run stalls there overnight. Ask only through the agent's question tool, which the harness records and surfaces. Sources: [stop.ts](../../packages/core/src/hooks/stop.ts), [ADR 0004](../adr/0004-harness-server-types-review-comments-into-the-run-tmux-session.md), [ADR 0009](../adr/0009-a-stage-tier-switches-the-live-claude-session-model-between-stages.md).

## 8. The engine knows nothing about software.

`next` and `done` know nodes, dependencies, expressions, artifacts, and events. They do not know what a plan is, what a test is, or what a PR is. All of that lives in skills and in the workflow file.

**Why.** Version one hard-coded the pipeline into a skill, so changing it for one ticket or one project meant editing prose and hoping. A workflow file you can edit per task is the whole point of the rewrite.

**If you ignore it.** You teach the engine about a stage by name, and the next workflow that does not have that stage breaks. Put it in the stage's contract or in the workflow instead.

## 9. Two entry points, split by who calls them.

`yok run`, `yok doctor`, `yok view` are for people. They parse flags, make sure the server is up, call one route, and print. `yok orchestrate …` is for skills. Every action a skill takes on a run is a subcommand there, and it calls core directly, never the server.

**Why.** A skill that needs the server fails when the server is down. A person who needs the engine's internals is using the wrong tool.

**If you ignore it.** You add a server route for something a skill needs. Add an orchestrate subcommand instead. This rule is also in the repo's `CLAUDE.md`.

## 10. Schemas first. Types come from them.

Every shape is a Zod schema, and its TypeScript type is inferred from it. Config, workflow, events, state, stage contracts, outputs. A schema gets a name only when it adds a rule or is shared.

**Why.** One definition means one place that can be wrong. Parsing at the boundary means the inside of the program never sees a bad shape.

**If you ignore it.** You write an interface and a schema that drift apart. Delete the interface.

## 11. No backward compatibility, yet.

This repo is not in production. Old runs, old state files, old config shapes are broken freely. No migrations.

**Why.** Every migration is code that exists only to carry a mistake forward. While nobody depends on the old shape, fix the shape.

**If you ignore it.** You write a `schemaVersion` branch to read last month's state. Bump the literal and move on. This changes the day a release has users we cannot ask to re-run.

Next: [Architecture](04-architecture.md).
