#!/usr/bin/env bun
import { resolve } from "node:path";
import { Command, Option } from "@commander-js/extra-typings";
import { HOOK_AGENTS, stopHooks } from "@harness/agents";
import {
  AgentTypeSchema,
  type ArtifactRef,
  ArtifactRefSchema,
  createGit,
  createRegistry,
  emitRunEvent,
  type JsonValue,
  loadConfigOrDefault,
  type Result,
  type RunRef,
  registryPath,
  resolveRoot,
  resolveRun,
  type StepOutcome,
  stopRunningOnSignal,
} from "@harness/sdk";
import { createLogger, resolveLevel } from "./logging.ts";
import { execStep, finishStep, initializeRun, linkRunSession, nextStep } from "./runs.ts";
import { harnessSkillsDir, resolveExtension, resolveReference } from "./stage.ts";
import { captureBaseline } from "./stages/baseline.ts";

const ROOT_HELP = "repo holding orchestrate.config.json and the run (default: main checkout)";
const RUN_HELP = "spec name of the run, as given to init";
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

const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const printResult = (result: Result<unknown>): void =>
  result.ok ? printJson(result.value) : fail(result.error);

const registry = () => createRegistry(registryPath(), log);

const splitList = (value: string): string[] =>
  value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

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
      });
      printResult(result.ok ? { ok: true, value: { runId, dir: result.value.dir } } : result);
    });

const linkSessionCommand = () =>
  new Command("link-session")
    .description("Add an agent session to the run")
    .requiredOption("--run <name>", RUN_HELP)
    .addOption(
      new Option("--agent <type>", "agent type")
        .choices(AgentTypeSchema.options)
        .makeOptionMandatory(),
    )
    .requiredOption("--session-id <id>", "agent session id")
    .option("--root <dir>", ROOT_HELP)
    .action(async (opts) => {
      const root = await resolveRoot(opts.root);
      if (!root.ok) return fail(root.error);
      const { run: name, agent, sessionId } = opts;
      printResult(
        await linkRunSession({ registry: registry(), root: root.value, name, agent, sessionId }),
      );
    });

const getWorkflowRun = async (
  name: string,
  rootFlag: string | undefined,
): Promise<Result<Readonly<{ root: string; run: RunRef }>>> => {
  const root = await resolveRoot(rootFlag);
  if (!root.ok) return root;
  const run = await resolveRun({ registry: registry(), root: root.value, name });
  return run.ok ? { ok: true, value: { root: root.value, run: run.value } } : run;
};

const emitCommand = () =>
  new Command("emit")
    .description("Add an event to the run's event log")
    .argument("<type>", "event type, e.g. custom.review.note")
    .requiredOption("--run <name>", RUN_HELP)
    .requiredOption("--source <name>", "who sent the event, e.g. the skill's name")
    .option("--payload <json>", "event payload as JSON", "{}")
    .option("--id <id>", "event id; a repeated id returns the event stored first")
    .option("--node-id <id>", "node the event belongs to; needs --node-run-id")
    .option("--node-run-id <id>", "node run the event belongs to; needs --node-id")
    .option("--stage <name>", "stage the event belongs to")
    .option("--root <dir>", ROOT_HELP)
    .action(async (type, opts) => {
      const payload = parseJsonFlag(opts.payload, "--payload");
      if (!payload.ok) return fail(payload.error);
      const target = await getWorkflowRun(opts.run, opts.root);
      if (!target.ok) return fail(target.error);
      const { source, id, nodeId, nodeRunId, stage } = opts;
      const input = { type, payload: payload.value, source, id, nodeId, nodeRunId, stage };
      printResult(await emitRunEvent(target.value.run, input));
    });

const nextCommand = () =>
  new Command("next")
    .description("Move the run to its next step and print that step as JSON")
    .requiredOption("--run <name>", RUN_HELP)
    .option("--root <dir>", ROOT_HELP)
    .action(async (opts) => {
      const target = await getWorkflowRun(opts.run, opts.root);
      if (!target.ok) return fail(target.error);
      printResult(await nextStep(target.value.run, target.value.root));
    });

const execCommand = () =>
  new Command("exec")
    .description("Run an exec or wait node that next handed out, and record how it ended")
    .argument("<nodeRunId>", "node run id from next")
    .requiredOption("--run <name>", RUN_HELP)
    .option("--root <dir>", ROOT_HELP)
    .action(async (nodeRunId, opts) => {
      if (nodeRunId === "") return fail(EMPTY_NODE_RUN_ID);
      const target = await getWorkflowRun(opts.run, opts.root);
      if (!target.ok) return fail(target.error);
      const report = await execStep(target.value.run, nodeRunId);
      printResult(report);
      if (report.ok && report.value.status !== "completed") process.exitCode = 1;
    });

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
  const output = parseJsonFlag(await readValue(flags.output ?? ""), "--output");
  return output.ok ? { ok: true, value: { output: output.value } } : output;
};

const doneCommand = () =>
  new Command("done")
    .description("Finish an agent or stage node that next handed out, with its output or error")
    .argument("<nodeRunId>", "node run id from next")
    .requiredOption("--run <name>", RUN_HELP)
    .option("--output <json>", "the node's output as JSON, or - to read it from stdin")
    .option("--error <message>", "why the node failed, or - to read it from stdin")
    .option(
      "--artifact <name=path>",
      "artifact the node wrote, repeatable",
      collect,
      [] as string[],
    )
    .option("--root <dir>", ROOT_HELP)
    .action(async (nodeRunId, opts) => {
      if (nodeRunId === "") return fail(EMPTY_NODE_RUN_ID);
      const outcome = await parseOutcome(opts);
      if (!outcome.ok) return fail(outcome.error);
      const artifacts = parseArtifacts(opts.artifact);
      if (!artifacts.ok) return fail(artifacts.error);
      const target = await getWorkflowRun(opts.run, opts.root);
      if (!target.ok) return fail(target.error);
      const report = await finishStep(target.value.run, nodeRunId, outcome.value, artifacts.value);
      printResult(report);
      if (report.ok && report.value.status !== "completed") process.exitCode = 1;
    });

const baselineCommand = () =>
  new Command("baseline")
    .description(
      "Run the config's baseline scripts and write their output to the run's artifacts/baseline.json",
    )
    .requiredOption("--run <name>", RUN_HELP)
    .option(
      "--dir <path>",
      "folder the scripts run in (default: the run's workspace.path in state.json)",
      (value: string) => resolve(value),
    )
    .option("--packages <names>", "comma-separated packages to run (default: all)", splitList)
    .option("--root <dir>", ROOT_HELP)
    .action(async (opts) => {
      const target = await getWorkflowRun(opts.run, opts.root);
      if (!target.ok) return fail(target.error);
      const result = await captureBaseline({
        root: target.value.root,
        run: target.value.run,
        dir: opts.dir,
        packages: opts.packages ?? [],
        log,
      });
      if (!result.ok) return fail(result.error.message);
      if (result.value === null) return printJson({ path: null, workspace: null, packages: {} });
      // The scripts' output is in baseline.json; a skill reading stdout needs only the exit codes.
      const { path, baseline } = result.value;
      const exitCodes = Object.entries(baseline.packages).map(([name, { exitCode }]) => [
        name,
        exitCode,
      ]);
      const workspace = baseline.workspace?.exitCode ?? null;
      printJson({ path, workspace, packages: Object.fromEntries(exitCodes) });
    });

const printResolved = async (
  skill: string,
  flags: { root?: string },
  resolveText: typeof resolveExtension,
): Promise<void> => {
  const root = await resolveRoot(flags.root);
  if (!root.ok) return fail(root.error);
  const config = await loadConfigOrDefault(root.value);
  if (!config.ok) return fail(config.error);
  const options = { skillsDir: harnessSkillsDir(), root: root.value, config: config.value, skill };
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
    .argument("<skill>", "skill name")
    .argument("<ref>", "reference name from the skill's frontmatter")
    .option("--root <dir>", ROOT_HELP)
    .action((name, ref, flags) =>
      printResolved(name, flags, (options) => resolveReference({ ...options, ref })),
    );
  skill
    .command("extension")
    .argument("<skill>", "skill name")
    .option("--root <dir>", ROOT_HELP)
    .action((name, flags) => printResolved(name, flags, resolveExtension));
  return skill;
};

const hookCommand = () => {
  const hook = new Command("hook").description(
    "Answer an agent's hook call with that agent's own hook function",
  );
  // Always exits 0 and prints only the agent's reply: an error here must never trap a session.
  hook
    .command("stop")
    .description("Decide from the run's state.json whether the agent may end its turn")
    .addOption(
      new Option("--agent <type>", "agent that called the hook")
        .choices(HOOK_AGENTS)
        .makeOptionMandatory(),
    )
    .action(async (opts) => {
      const deps = { registry: registry(), env: process.env, log };
      process.stdout.write(await stopHooks[opts.agent](await Bun.stdin.text(), deps));
    });
  return hook;
};

stopRunningOnSignal();

await new Command()
  .name("orchestrate")
  .description("Actions a skill takes on a harness run; each one calls core directly")
  .addCommand(initCommand())
  .addCommand(linkSessionCommand())
  .addCommand(emitCommand())
  .addCommand(baselineCommand())
  .addCommand(nextCommand())
  .addCommand(execCommand())
  .addCommand(doneCommand())
  .addCommand(skillCommand())
  .addCommand(hookCommand())
  .parseAsync(process.argv)
  .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
