#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Command, Option } from "@commander-js/extra-typings";
import {
  type AgentAdapter,
  AgentTypeSchema,
  type ArtifactRef,
  ArtifactRefSchema,
  type CheckoutConfig,
  createGit,
  emitRunEvent,
  type HookDeps,
  harnessHome,
  type ILogger,
  type JsonValue,
  loadPickedConfig,
  type PickRunInput,
  pickRun,
  type Result,
  type RunRef,
  registryPath,
  requireRun,
  runDirOf,
  stopRunningOnSignal,
  tierLaunch,
  type WorkflowRun,
} from "@harness/sdk";
import { AgentStatusSchema, createRegistry, type StepOutcome } from "@harness/sdk/internal";
import { agentAdapters, agentProvider, findSessionAgent, HOOK_AGENTS } from "./agents/index.ts";
import { currentTerminal, harnessTerminalHost } from "./agents/tmux.ts";
import { commentRepliedEvent, isOpen, readComments, replyToComment } from "./comments.ts";
import { runContextStep } from "./context-step.ts";
import { findEnvRun } from "./hooks/common.ts";
import { preToolUseHandlers } from "./hooks/pre-tool-use.ts";
import { sessionStartHandlers } from "./hooks/session-start.ts";
import { stopHandlers } from "./hooks/stop.ts";
import { stopFailureHandlers } from "./hooks/stop-failure.ts";
import { runLimitWait } from "./limit-wait.ts";
import { createLogger, resolveLevel } from "./logging.ts";
import {
  type DoneError,
  DoneErrorSchema,
  execStep,
  finishStep,
  getNodeFacts,
  initializeRun,
  linkRunSession,
  nextStep,
} from "./runs.ts";
import {
  harnessSkillsDir,
  orchestrateArgv,
  resolveExtension,
  resolveReference,
  resolveReferencePath,
} from "./stage.ts";
import { renderStatusline } from "./statusline.ts";
import { WorkflowCompileErrorSchema, WorkflowError } from "./workflow/types.ts";

const RUN_HELP = "spec name of the run, as given to init (default: $HARNESS_RUN_ID)";
const RUN_ID_HELP = "id of the run, instead of its name (default: $HARNESS_RUN_ID)";
const EMPTY_NODE_RUN_ID = "nodeRunId must not be empty";

// stdout carries only command output, so skills can parse it; logs go to stderr.
const log = createLogger(
  { service: "harness-orchestrate" },
  {
    destination: { write: (chunk: string) => void process.stderr.write(chunk) },
    level: resolveLevel(process.env, "warn"),
  },
);

const fail = (error: string): void => {
  console.error(error);
  process.exitCode = 1;
};

const failJson = (error: unknown): void => {
  console.error(JSON.stringify(error, null, 2));
  process.exitCode = 1;
};

const failDone = (error: DoneError): void => failJson(DoneErrorSchema.parse(error));

const runWorkflowCommand = async (work: () => Promise<void>): Promise<void> => {
  try {
    await work();
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    failJson(
      WorkflowCompileErrorSchema.parse({
        kind: "compile",
        retryable: false,
        code: error.code,
        path: error.path,
        message: error.message,
      }),
    );
  }
};

const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const printResult = (result: Result<unknown>): void =>
  result.ok ? printJson(result.value) : fail(result.error);

const registry = () => createRegistry(registryPath(), log);

const parseJsonFlag = (text: string, flag: string): Result<JsonValue> => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: `${flag} is not valid JSON` };
  }
};

const initCommand = () =>
  new Command("init")
    .description("Give the run started by harness run its name and folder, .harness/NAME")
    .argument("<name>", "spec name of the run, used for its folder")
    .option("--run-id <id>", "run id (default: $HARNESS_RUN_ID)")
    .action(async (name, opts) => {
      const runId = opts.runId ?? process.env.HARNESS_RUN_ID;
      if (!runId) return fail("no run: pass --run-id or run inside a harness session");
      const result = await initializeRun({
        registry: registry(),
        runId,
        name,
        git: createGit(),
        log,
        terminal: currentTerminal(),
      });
      printResult(result.ok ? { ok: true, value: { runId, dir: result.value.dir } } : result);
    });

type RunFlags = Readonly<{ run?: string | undefined; runId?: string | undefined }>;

const runInputFromFlags = (flags: RunFlags): PickRunInput => ({
  registry: registry(),
  name: flags.run,
  id: flags.runId,
  env: process.env,
  cwd: process.cwd(),
});

const linkSessionCommand = () =>
  new Command("link-session")
    .description("Add an agent session to the run")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .addOption(
      new Option("--agent <type>", "agent type")
        .choices(AgentTypeSchema.options)
        .makeOptionMandatory(),
    )
    .requiredOption("--session-id <id>", "agent session id")
    .action(async (opts) => {
      const run = await requireRun(runInputFromFlags(opts));
      if (!run.ok) return fail(run.error);
      const { agent, sessionId } = opts;
      printResult(await linkRunSession({ registry: registry(), run: run.value, agent, sessionId }));
    });

const emitCommand = () =>
  new Command("emit")
    .description("Add an event to the run's event log")
    .argument("<type>", "event type, e.g. custom.review.note")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .requiredOption("--source <name>", "who sent the event, e.g. the skill's name")
    .option("--payload <json>", "event payload as JSON", "{}")
    .option("--id <id>", "event id; a repeated id returns the event stored first")
    .option("--node-id <id>", "node the event belongs to; needs --node-run-id")
    .option("--node-run-id <id>", "node run the event belongs to; needs --node-id")
    .option("--stage <name>", "stage the event belongs to")
    .action(async (type, opts) => {
      const payload = parseJsonFlag(opts.payload, "--payload");
      if (!payload.ok) return fail(payload.error);
      const run = await requireRun(runInputFromFlags(opts));
      if (!run.ok) return fail(run.error);
      const { source, id, nodeId, nodeRunId, stage } = opts;
      const input = { type, payload: payload.value, source, id, nodeId, nodeRunId, stage };
      printResult(await emitRunEvent(run.value, input));
    });

const nextCommand = () =>
  new Command("next")
    .description("Move the run to its next step and print that step as JSON")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .action(async (opts) =>
      runWorkflowCommand(async () => {
        const run = await requireRun(runInputFromFlags(opts));
        if (!run.ok) return fail(run.error);
        printResult(await nextStep(run.value));
      }),
    );

const execCommand = () =>
  new Command("exec")
    .description("Run an exec or wait node that next handed out, and record how it ended")
    .argument("<nodeRunId>", "node run id from next")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .action(async (nodeRunId, opts) =>
      runWorkflowCommand(async () => {
        if (nodeRunId === "") return fail(EMPTY_NODE_RUN_ID);
        const run = await requireRun(runInputFromFlags(opts));
        if (!run.ok) return fail(run.error);
        const report = await execStep(run.value, nodeRunId);
        printResult(report);
        if (report.ok && report.value.status !== "completed") process.exitCode = 1;
      }),
    );

const collect = (value: string, acc: readonly string[]): string[] => [...acc, value];

// A pair with no NAME before its "=" is refused, so a bare path never becomes an artifact name.
const parseArtifact = (pair: string): ArtifactRef | undefined => {
  const index = pair.indexOf("=");
  if (index <= 0) return undefined;
  const parsed = ArtifactRefSchema.safeParse({
    name: pair.slice(0, index),
    path: pair.slice(index + 1),
  });
  return parsed.success ? parsed.data : undefined;
};

const parseArtifacts = (pairs: readonly string[]): Result<ArtifactRef[]> => {
  const refs: ArtifactRef[] = [];
  for (const pair of pairs) {
    const ref = parseArtifact(pair);
    if (ref === undefined) {
      return { ok: false, error: `--artifact must be NAME=artifacts/PATH, got "${pair}"` };
    }
    refs.push(ref);
  }
  return { ok: true, value: refs };
};

// "-" reads the value from stdin, so an agent can pass it in a quoted heredoc (<<'EOF'): the
// shell never parses that text, so quotes, backticks and $(…) in it stay plain text.
const readValue = async (value: string): Promise<string> =>
  value === "-" ? (await Bun.stdin.text()).trimEnd() : value;

const parseOutcome = async (
  flags: Readonly<{ output?: string; error?: string }>,
): Promise<Result<StepOutcome>> => {
  if ((flags.output === undefined) === (flags.error === undefined)) {
    return { ok: false, error: "pass exactly one of --output and --error" };
  }
  if (flags.error !== undefined)
    return { ok: true, value: { error: await readValue(flags.error) } };
  return { ok: true, value: { output: await readValue(flags.output ?? "") } };
};

const doneCommand = () =>
  new Command("done")
    .description("Finish an agent or stage node that next handed out, with its output or error")
    .argument("<nodeRunId>", "node run id from next")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .option(
      "--output <text>",
      "the node's output: plain text, or JSON when the node names an output schema; - reads stdin",
    )
    .option("--error <message>", "why the node failed, or - to read it from stdin")
    .option(
      "--artifact <name=path>",
      "artifact the node wrote, repeatable",
      collect,
      [] as string[],
    )
    .action(async (nodeRunId, opts) => {
      if (nodeRunId === "") return fail(EMPTY_NODE_RUN_ID);
      const outcome = await parseOutcome(opts);
      if (!outcome.ok)
        return failDone({
          kind: "input",
          retryable: true,
          flag: "--output/--error",
          message: outcome.error,
        });
      const artifacts = parseArtifacts(opts.artifact);
      if (!artifacts.ok)
        return failDone({
          kind: "input",
          retryable: true,
          flag: "--artifact",
          message: artifacts.error,
        });
      const run = await requireRun(runInputFromFlags(opts));
      if (!run.ok)
        return failDone({
          kind: "configuration",
          retryable: false,
          code: "run",
          path: opts.runId ?? opts.run ?? (process.env.HARNESS_RUN_ID || ""),
          message: run.error,
        });
      const report = await finishStep(run.value, nodeRunId, outcome.value, artifacts.value);
      if (!report.ok) return failDone(report.error);
      printJson(report.value);
      if (report.ok && report.value.status !== "completed") process.exitCode = 1;
    });

const nodeCommand = () => {
  const node = new Command("node").description("Facts about a node run, for verifier scripts");
  node
    .command("show")
    .description("Print the node run's id, stage, input, attempt, consumed artifacts and run dirs")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .requiredOption("--node-run <id>", "node run id from next")
    .action(async (opts) =>
      runWorkflowCommand(async () => {
        const nodeRunId = opts.nodeRun;
        if (nodeRunId === "") return fail(EMPTY_NODE_RUN_ID);
        const run = await requireRun(runInputFromFlags(opts));
        if (!run.ok) return fail(run.error);
        const { cwd, name } = run.value;
        printJson(await getNodeFacts(name, nodeRunId, cwd));
      }).catch((error: unknown) => fail(error instanceof Error ? error.message : String(error))),
    );
  return node;
};

const configFor = async (flags: RunFlags): Promise<Result<CheckoutConfig>> => {
  const run = await pickRun(runInputFromFlags(flags));
  return run.ok ? loadPickedConfig(run.value, process.cwd()) : run;
};

const printResolved = async (
  skill: string,
  flags: RunFlags,
  resolveText: typeof resolveExtension,
): Promise<void> => {
  const loaded = await configFor(flags);
  if (!loaded.ok) return fail(loaded.error);
  const { root, config } = loaded.value;
  const options = { skillsDir: harnessSkillsDir(), root, config, skill };
  const text = await resolveText(options);
  if (!text.ok) return fail(text.error);
  process.stdout.write(text.value);
};

const skillCommand = () => {
  const skill = new Command("skill").description(
    "Print a skill's references and extension docs with the project's extensions applied",
  );
  skill
    .command("ref")
    .argument("<SKILL.REF>", "skill name, a dot, and a reference from its frontmatter")
    .option("--path", "print where the reference's file is instead of its text, to run it")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .action((target: string, flags) => {
      const dot = target.lastIndexOf(".");
      if (dot <= 0 || dot === target.length - 1) {
        return fail(`expected SKILL.REF, such as baseline.script; got "${target}"`);
      }
      const ref = target.slice(dot + 1);
      return printResolved(target.slice(0, dot), flags, (options) =>
        flags.path
          ? resolveReferencePath({ ...options, ref })
          : resolveReference({ ...options, ref }),
      );
    });
  skill
    .command("extension")
    .argument("<skill>", "skill name")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .action((name, flags) => printResolved(name, flags, resolveExtension));
  return skill;
};

type HookSpec<H> = Readonly<{
  name: string;
  description: string;
  handlers: Readonly<Record<string, H>>;
  answer: (
    adapter: AgentAdapter,
  ) => ((stdin: string, deps: HookDeps, handler: H) => Promise<string>) | undefined;
}>;

// Always exits 0 and prints only the agent's reply: an error here must never trap a session. An
// agent without this hook, or a handler the harness does not know, prints nothing.
const addHookCommand = <H>(hook: Command, spec: HookSpec<H>): void => {
  hook
    .command(spec.name)
    .description(spec.description)
    .addOption(
      new Option("--agent <type>", "agent that called the hook")
        .choices(HOOK_AGENTS)
        .makeOptionMandatory(),
    )
    .requiredOption("--handler <name>", `one of: ${Object.keys(spec.handlers).join(", ")}`)
    .action(async (opts) => {
      const answer = spec.answer(agentAdapters[opts.agent]);
      const handler = Object.hasOwn(spec.handlers, opts.handler)
        ? spec.handlers[opts.handler]
        : undefined;
      if (answer === undefined || handler === undefined) return;
      const deps = { registry: registry(), env: process.env, log };
      process.stdout.write(await answer(await Bun.stdin.text(), deps, handler));
    });
};

const hookCommand = () => {
  const hook = new Command("hook").description(
    "Answer an agent's hook call with the named handler, in that agent's own format",
  );
  addHookCommand(hook, {
    name: "stop",
    description: "Decide whether the agent may end its turn",
    handlers: stopHandlers,
    answer: (adapter) => adapter.stop,
  });
  addHookCommand(hook, {
    name: "session-start",
    description: "Link a newly started agent session to its run",
    handlers: sessionStartHandlers,
    answer: (adapter) => adapter.sessionStart,
  });
  addHookCommand(hook, {
    name: "pre-tool-use",
    description: "Decide whether the agent may make a tool call",
    handlers: preToolUseHandlers,
    answer: (adapter) => adapter.preToolUse,
  });
  addHookCommand(hook, {
    name: "stop-failure",
    description: "Log a turn an API error ended, and wait out a usage limit",
    handlers: stopFailureHandlers,
    answer: (adapter) => adapter.stopFailure,
  });
  return hook;
};

// Always exits 0: Claude shows whatever this prints, and a failure here must not reach the run.
const statuslineCommand = () =>
  new Command("statusline")
    .description("Print the status line Claude Code shows for this run's session")
    .option("--run-id <id>", "look the run up by id and read no stdin (the tmux status bar)")
    .action(async (options: { runId?: string }) => {
      const runId = options.runId ?? process.env.HARNESS_RUN_ID;
      if (!runId) return;
      const stdin = options.runId === undefined ? await Bun.stdin.text().catch(() => "") : "";
      const deps = { registry: registry(), env: { ...process.env, HARNESS_RUN_ID: runId }, log };
      const line = await findEnvRun(deps)
        .then((found) => renderStatusline(stdin, found?.ref))
        .catch((error: unknown) => {
          log.error({ err: error }, "statusline failed");
          return "harness · starting";
        });
      process.stdout.write(`${line}\n`);
    });

const sessionProvider = (
  linked: WorkflowRun | undefined,
  sessionId: string,
  helperLog: ILogger,
) => {
  const agent = findSessionAgent(linked?.sessions ?? [], sessionId);
  if (agent === undefined) return undefined;
  const host = harnessTerminalHost(process.env, helperLog);
  return agentProvider({ agent, host, env: process.env, log: helperLog });
};

const contextCommand = () =>
  new Command("context")
    .description(
      "Carry out an open context node: start a new session in the agent's pane, or compact it (started by the Stop hook)",
    )
    .argument("<nodeRunId>", "node run id of the open context node")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .requiredOption("--session-id <id>", "the agent session whose turn just ended")
    .action(async (nodeRunId, opts) => {
      const picked = await requireRun(runInputFromFlags(opts));
      if (!picked.ok) return fail(picked.error);
      const run = picked.value;
      const helperLog = helperLogger(run, "harness-context", "context.log");
      const linked = await registry().findRun(run.id);
      const provider = sessionProvider(linked, opts.sessionId, helperLog);
      if (provider === undefined) {
        return helperLog.error(
          { sessionId: opts.sessionId },
          "no provider for the session's agent",
        );
      }
      await runContextStep({
        run,
        nodeRunId,
        oldSessionId: opts.sessionId,
        terminal: currentTerminal(process.env, helperLog),
        registry: registry(),
        provider,
        launch: {
          cwd: run.cwd,
          orchestrateArgv: orchestrateArgv(),
          ...tierLaunch(linked?.tier ?? null),
        },
        home: harnessHome(),
        log: helperLog,
      });
    });

// stderr is detached, so a helper logs to a file in the run's folder.
const helperLogger = (run: RunRef, service: string, file: string) => {
  const path = join(runDirOf(run.cwd, run.name), file);
  return createLogger(
    { service, run: run.name },
    { destination: { write: (chunk: string) => void appendFileSync(path, chunk) }, level: "debug" },
  );
};

const limitWaitCommand = () =>
  new Command("limit-wait")
    .description(
      "Wait out a usage limit, then have the agent continue in its terminal (started by the StopFailure hook)",
    )
    .argument("<eventId>", "id of the agent.limit.reached event")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .requiredOption("--session-id <id>", "the agent session the limit stopped")
    .action(async (limitEventId, opts) => {
      const picked = await requireRun(runInputFromFlags(opts));
      if (!picked.ok) return fail(picked.error);
      const run = picked.value;
      const log = helperLogger(run, "harness-limit-wait", "limit-wait.log");
      const linked = await registry().findRun(run.id);
      const provider = sessionProvider(linked, opts.sessionId, log);
      await runLimitWait({
        run,
        sessionId: opts.sessionId,
        limitEventId,
        agents: provider === undefined ? {} : { [provider.type]: provider },
        // the hook that started this helper ran inside the agent's terminal, and left it in env
        terminal: currentTerminal(process.env, log),
        log,
      }).catch((error: unknown) => log.error({ err: error }, "limit wait threw"));
    });

const commentsCommand = () => {
  const comments = new Command("comments").description("Review comments from the viewer on a run");
  comments
    .command("list")
    .description("Print the run's open comments (sent or delivered) as JSON")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .option("--all", "include answered, changed and declined comments")
    .action(async (opts) => {
      const run = await requireRun(runInputFromFlags(opts));
      if (!run.ok) return fail(run.error);
      const { cwd, name } = run.value;
      const read = await readComments(runDirOf(cwd, name));
      if (!read.ok) return fail(read.error);
      printJson({ comments: read.value.comments.filter((c) => opts.all || isOpen(c)) });
    });
  comments
    .command("reply")
    .description("Answer a comment and record the reply in the run's event log")
    .option("--run <name>", RUN_HELP)
    .option("--run-id <id>", RUN_ID_HELP)
    .requiredOption("--id <id>", "comment id from the message, e.g. c4")
    .addOption(
      new Option("--status <status>", "what you did about it")
        .choices(AgentStatusSchema.options)
        .makeOptionMandatory(),
    )
    .requiredOption("--text <text>", "the reply; - reads stdin")
    .action(async (opts) => {
      const picked = await requireRun(runInputFromFlags(opts));
      if (!picked.ok) return fail(picked.error);
      const run = picked.value;
      const text = await readValue(opts.text);
      const replied = await replyToComment(
        runDirOf(run.cwd, run.name),
        opts.id,
        { status: opts.status, text },
        new Date(),
      );
      if (!replied.ok) return fail(replied.error);
      const logged = await emitRunEvent(run, commentRepliedEvent("orchestrate", replied.value));
      if (!logged.ok) return fail(logged.error);
      printJson(replied.value);
    });
  return comments;
};

stopRunningOnSignal();

await new Command()
  .name("orchestrate")
  .description("Actions a skill takes on a harness run; each one calls core directly")
  .addCommand(initCommand())
  .addCommand(linkSessionCommand())
  .addCommand(emitCommand())
  .addCommand(nextCommand())
  .addCommand(execCommand())
  .addCommand(doneCommand())
  .addCommand(nodeCommand())
  .addCommand(skillCommand())
  .addCommand(hookCommand())
  .addCommand(statuslineCommand())
  .addCommand(contextCommand())
  .addCommand(limitWaitCommand())
  .addCommand(commentsCommand())
  .parseAsync(process.argv)
  .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
