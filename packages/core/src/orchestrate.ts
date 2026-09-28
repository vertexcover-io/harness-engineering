#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { Command, Option } from "@commander-js/extra-typings";
import { AgentTypeSchema, createGit, stopRunningOnSignal } from "@harness/sdk";
import { loadConfigOrDefault } from "./config.ts";
import type { JsonValue, Result } from "./contracts.ts";
import type { RunRef } from "./events.ts";
import { createLogger, resolveLevel } from "./logging.ts";
import { createRegistry, registryPath } from "./registry.ts";
import { findRoot, initializeRun, linkRunSession, resolveRun } from "./runs.ts";
import { resolveExtension, resolveReference } from "./stage.ts";
import { captureBaseline } from "./stages/baseline.ts";
import {
  addRepositories,
  createWorkspace,
  removeWorkspace,
  type WorkspaceOptions,
  workspaceInfo,
} from "./stages/workspace.ts";
import { emitRunEvent } from "./state.ts";

const ROOT_HELP = "repo holding orchestrate.config.json and the run (default: main checkout)";
const RUN_HELP = "spec name of the run, as given to init";
const RECORD_HELP = "spec name of the run whose event log records this change (default: none)";
const BASE_HELP =
  "branch a new branch starts from, fetched from origin first (default: origin's default branch)";

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

// The main checkout, even from inside a workspace worktree: that is where runs live.
const rootOf = (root: string | undefined): Promise<Result<string>> =>
  root === undefined
    ? findRoot(process.cwd())
    : Promise.resolve({ ok: true, value: resolve(root) });

const runOf = async (
  root: string,
  name: string | undefined,
): Promise<Result<RunRef | undefined>> =>
  name === undefined
    ? { ok: true, value: undefined }
    : resolveRun({ registry: registry(), root, name });

const splitList = (value: string): string[] =>
  value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

const parsePayload = (text: string): Result<JsonValue> => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, error: "--payload is not valid JSON" };
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
      const root = await rootOf(opts.root);
      if (!root.ok) return fail(root.error);
      const { run: name, agent, sessionId } = opts;
      printResult(
        await linkRunSession({ registry: registry(), root: root.value, name, agent, sessionId }),
      );
    });

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
      const payload = parsePayload(opts.payload);
      if (!payload.ok) return fail(payload.error);
      const root = await rootOf(opts.root);
      if (!root.ok) return fail(root.error);
      const run = await resolveRun({ registry: registry(), root: root.value, name: opts.run });
      if (!run.ok) return fail(run.error);
      const { source, id, nodeId, nodeRunId, stage } = opts;
      const input = { type, payload: payload.value, source, id, nodeId, nodeRunId, stage };
      printResult(await emitRunEvent(run.value, input));
    });

const baselineCommand = () =>
  new Command("baseline")
    .description(
      "Run the config's baseline scripts and record their output as the node run's baseline artifact",
    )
    .requiredOption("--run <name>", RUN_HELP)
    .requiredOption("--node-id <id>", "node the baseline belongs to")
    .requiredOption("--node-run-id <id>", "node run the baseline belongs to")
    .option(
      "--dir <path>",
      "folder the scripts run in (default: the run's workspace.path in state.json)",
      (value: string) => resolve(value),
    )
    .option("--packages <names>", "comma-separated packages to run (default: all)", splitList)
    .option("--root <dir>", ROOT_HELP)
    .action(async (opts) => {
      const root = await rootOf(opts.root);
      if (!root.ok) return fail(root.error);
      const run = await resolveRun({ registry: registry(), root: root.value, name: opts.run });
      if (!run.ok) return fail(run.error);
      const result = await captureBaseline({
        root: root.value,
        run: run.value,
        nodeId: opts.nodeId,
        nodeRunId: opts.nodeRunId,
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

type WorkspaceFlags = Omit<WorkspaceOptions, "run" | "root" | "onOutput" | "log"> &
  Readonly<{ run?: string; root?: string }>;

const changeWorkspace = async (
  command: typeof createWorkspace,
  flags: WorkspaceFlags,
): Promise<void> => {
  const { run: name, root: rootFlag, ...options } = flags;
  const root = await rootOf(rootFlag);
  if (!root.ok) return fail(root.error);
  const run = await runOf(root.value, name);
  if (!run.ok) return fail(run.error);
  const onOutput: WorkspaceOptions["onOutput"] = (line) =>
    process.stderr.write(`[${line.repo}] ${line.text}\n`);
  const result = await command({ ...options, root: root.value, run: run.value, onOutput, log });
  if (!result.ok) return fail(result.error);
  const { eventError, ...report } = result.value;
  printJson(report);
  if (report.repos.some((repo) => repo.status === "failed")) process.exitCode = 1;
  if (eventError !== undefined) {
    fail(`the workspace changed, but its event was not recorded: ${eventError}`);
  }
};

const workspaceCommand = () => {
  const workspace = new Command("workspace").description(
    "Create, inspect, add to and remove the run's workspace: a git worktree per repo, with the project's setup and teardown",
  );
  workspace
    .command("info")
    .description("Print the layout and the packages a workspace can hold")
    .option("--root <dir>", ROOT_HELP)
    .action(async (flags) => {
      const root = await rootOf(flags.root);
      if (!root.ok) return fail(root.error);
      printResult(await workspaceInfo(root.value));
    });
  workspace
    .command("create")
    .argument("<branch>", "branch to create or check out")
    .option("--run <name>", RECORD_HELP)
    .option("--repos <names>", "multi layout: comma-separated packages to branch", splitList)
    .option("--base <branch>", BASE_HELP)
    .option("--root <dir>", ROOT_HELP)
    .action((branch, flags) => changeWorkspace(createWorkspace, { ...flags, branch }));
  workspace
    .command("add")
    .description("Put more repos into a multi-layout workspace that already exists")
    .argument("<branch>", "branch of the existing workspace")
    .option("--run <name>", RECORD_HELP)
    .requiredOption("--repos <names>", "comma-separated packages to add", splitList)
    .option("--base <branch>", BASE_HELP)
    .option("--root <dir>", ROOT_HELP)
    .action((branch, flags) => changeWorkspace(addRepositories, { ...flags, branch }));
  workspace
    .command("remove")
    .argument("<branch>", "branch whose worktrees to remove")
    .option("--run <name>", RECORD_HELP)
    .option("--repos <names>", "multi layout: comma-separated packages (default: all)", splitList)
    .option("--force", "remove worktrees with uncommitted or untracked files")
    .option("--root <dir>", ROOT_HELP)
    .action((branch, flags) => changeWorkspace(removeWorkspace, { ...flags, branch }));
  return workspace;
};

// The skills ship beside this script, so reference text always matches this version.
const skillsDir = (): string =>
  process.env.HARNESS_SKILLS_DIR || join(import.meta.dir, "..", "..", "..", "skills");

const printResolved = async (
  skill: string,
  flags: { root?: string },
  resolveText: typeof resolveExtension,
): Promise<void> => {
  const root = await rootOf(flags.root);
  if (!root.ok) return fail(root.error);
  const config = await loadConfigOrDefault(root.value);
  if (!config.ok) return fail(config.error);
  const options = { skillsDir: skillsDir(), root: root.value, config: config.value, skill };
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

stopRunningOnSignal();

await new Command()
  .name("orchestrate")
  .description("Actions a skill takes on a harness run; each one calls core directly")
  .addCommand(initCommand())
  .addCommand(linkSessionCommand())
  .addCommand(emitCommand())
  .addCommand(baselineCommand())
  .addCommand(workspaceCommand())
  .addCommand(skillCommand())
  .parseAsync(process.argv)
  .catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
