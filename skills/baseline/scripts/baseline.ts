import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type Config,
  createRegistryReader,
  type ILogger,
  jsonLogger,
  LogLevelSchema,
  loadRunConfig,
  NameSchema,
  NOT_FOUND,
  NonEmptyStringSchema,
  type Result,
  type RunRef,
  readState,
  registryPath,
  requireRun,
  runDirOf,
  type SpawnResult,
  spawn,
  stopRunningOnSignal,
  unknownPackage,
} from "@harness/sdk";
import * as z from "zod";

const BaselineEntrySchema = z.strictObject({
  command: NonEmptyStringSchema,
  exitCode: z.int(),
  output: z.json(),
});

export const BaselineSchema = z.strictObject({
  workspace: BaselineEntrySchema.nullable(),
  packages: z.record(NameSchema, BaselineEntrySchema),
});

export type Baseline = z.infer<typeof BaselineSchema>;
type BaselineEntry = z.infer<typeof BaselineEntrySchema>;

export type CapturedBaseline = Readonly<{ path: string; baseline: Baseline }>;

// The stage reports this file as its `baseline` artifact through orchestrate done.
const BASELINE_PATH = "artifacts/baseline.json";

export type BaselineError = Readonly<{
  code: "PACKAGE_UNKNOWN" | "STATE_MISSING" | "CONFIG_STALE" | "WORKTREE_MISSING";
  message: string;
}>;

export type BaselineOptions = Readonly<{
  config: Config;
  run: RunRef;
  dir?: string | undefined;
  packages: readonly string[];
  log: ILogger;
}>;

// package is the package name, or "root" for the top-level script.
type Script = Readonly<{
  scope: "workspace" | "package";
  package: string;
  command: string;
  cwd: string;
  timeoutSeconds: number;
}>;

const WORKSPACE_TIMEOUT_SECONDS = 1200;
// The same cap exec nodes keep on a script's output.
const MAX_OUTPUT_BYTES = 1_048_576;
const TIMED_OUT = 124;
const LAUNCH_FAILURE =
  /command not found|Missing script|is not recognized|Script not found|No packages matched/i;

const failure = (code: BaselineError["code"], message: string): Result<never, BaselineError> => ({
  ok: false,
  error: { code, message },
});

const isFolder = (path: string): boolean =>
  statSync(path, { throwIfNoEntry: false })?.isDirectory() === true;

// A missing folder would make spawn fail with exit 127 and read as a command that cannot start,
// and state.json keeps workspace.path after `workspace.ts remove`, so the folder is checked here.
const resolveWorkspace = async (
  options: BaselineOptions,
): Promise<Result<string, BaselineError>> => {
  const { run, dir } = options;
  const state = dir === undefined ? await readState(runDirOf(run.cwd, run.name)) : null;
  const workspace = dir ?? state?.workspace.path;
  if (workspace === undefined) {
    return failure("STATE_MISSING", `no state.json for run ${run.name}: pass --dir`);
  }
  if (!isFolder(workspace)) return failure("WORKTREE_MISSING", `no run folder at ${workspace}`);
  return { ok: true, value: workspace };
};

// The top-level script first, then each package's, in config order. A script runs in its
// command's cwd when set, else in the workspace folder, or in multi layout the package's repo.
// A multi-layout workspace holds only the repos it checked out: a default run skips the rest,
// but a package the caller named must have its worktree.
const collectScripts = (
  config: Config,
  workspace: string,
  names: readonly string[],
  log: ILogger,
): Result<readonly Script[], BaselineError> => {
  const unknown = unknownPackage(config, names);
  if (unknown !== undefined) {
    const known = Object.keys(config.packages).join(", ");
    return failure("PACKAGE_UNKNOWN", `unknown package "${unknown}"; packages are: ${known}`);
  }
  const scripts: Script[] = [];
  if (config.baseline !== undefined) {
    const { command, cwd, timeoutSeconds } = config.baseline;
    scripts.push({
      scope: "workspace",
      package: "root",
      command,
      cwd: cwd === undefined ? workspace : join(workspace, cwd),
      timeoutSeconds: timeoutSeconds ?? WORKSPACE_TIMEOUT_SECONDS,
    });
  }
  for (const [name, pkg] of Object.entries(config.packages)) {
    if (names.length > 0 && !names.includes(name)) continue;
    const home = config.workspace.layout === "multi" ? join(workspace, pkg.path) : workspace;
    const present = isFolder(home);
    if (!present && names.includes(name)) {
      return failure("WORKTREE_MISSING", `${name}: no worktree at ${home}`);
    }
    if (!present) log.info({ package: name, cwd: home }, "baseline skipped: no worktree");
    const baseline = pkg.commands.baseline;
    if (!present || !baseline) continue;
    scripts.push({
      scope: "package",
      package: name,
      command: baseline.command,
      cwd: baseline.cwd === undefined ? home : join(workspace, baseline.cwd),
      timeoutSeconds: baseline.timeoutSeconds ?? pkg.timeoutSeconds,
    });
  }
  const badCwd = scripts.find(({ cwd }) => !isFolder(cwd));
  if (badCwd !== undefined) {
    return failure(
      "CONFIG_STALE",
      `${badCwd.package}: baseline cwd ${badCwd.cwd} is not a folder. Fix it in orchestrate.config.json`,
    );
  }
  return { ok: true, value: scripts };
};

const spawnScript = async (script: Script, log: ILogger): Promise<SpawnResult> => {
  const { package: name, command, cwd } = script;
  log.info({ package: name, command, cwd }, "baseline script started");
  const started = Date.now();
  const line =
    (stream: "stdout" | "stderr") =>
    (text: string): void =>
      log.debug({ package: name, stream }, text);
  const run = await spawn("sh", ["-c", command], {
    cwd,
    timeoutMs: script.timeoutSeconds * 1000,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    env: { CI: "1" },
    onStdout: line("stdout"),
    onStderr: line("stderr"),
  });
  const code = run.stopped === "timeout" ? TIMED_OUT : run.code;
  log.info(
    { package: name, exitCode: code, durationMs: Date.now() - started },
    "baseline script ended",
  );
  return { ...run, code };
};

// A command that never launched writes a line or two to stderr and nothing to stdout. A suite
// that merely failed writes plenty, and its own output can quote these phrases.
const couldNotStart = (run: SpawnResult): boolean => {
  if (run.code === NOT_FOUND) return true;
  if (run.stdout.trim() !== "") return false;
  return LAUNCH_FAILURE.test(run.stderr.split("\n").slice(0, 3).join("\n"));
};

const parseJsonOrText = (stdout: string): BaselineEntry["output"] => {
  try {
    const parsed = z.json().safeParse(JSON.parse(stdout));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON: the script's text is its output.
  }
  return stdout.trim();
};

const runScript = async (
  script: Script,
  log: ILogger,
): Promise<Result<BaselineEntry, BaselineError>> => {
  const run = await spawnScript(script, log);
  if (couldNotStart(run)) {
    const reason = run.stderr.trim().split("\n")[0] ?? "";
    return failure(
      "CONFIG_STALE",
      `${script.package}: baseline "${script.command}" could not start in ${script.cwd}: ${reason}. Fix the command in orchestrate.config.json`,
    );
  }
  return {
    ok: true,
    value: { command: script.command, exitCode: run.code, output: parseJsonOrText(run.stdout) },
  };
};

// One at a time, never in parallel: the first script that cannot start stops the rest.
const runScripts = async (
  scripts: readonly Script[],
  log: ILogger,
): Promise<Result<Baseline, BaselineError>> => {
  const baseline: Baseline = { workspace: null, packages: {} };
  for (const script of scripts) {
    const entry = await runScript(script, log);
    if (!entry.ok) return entry;
    if (script.scope === "workspace") baseline.workspace = entry.value;
    else baseline.packages[script.package] = entry.value;
  }
  return { ok: true, value: baseline };
};

export const captureBaseline = async (
  options: BaselineOptions,
): Promise<Result<CapturedBaseline | null, BaselineError>> => {
  const workspace = await resolveWorkspace(options);
  if (!workspace.ok) return workspace;
  const log = options.log.child({ component: "baseline" });
  const scripts = collectScripts(options.config, workspace.value, options.packages, log);
  if (!scripts.ok) return scripts;
  if (scripts.value.length === 0) return { ok: true, value: null };
  const baseline = await runScripts(scripts.value, log);
  if (!baseline.ok) return baseline;
  const path = join(runDirOf(options.run.cwd, options.run.name), BASELINE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(baseline.value, null, 2)}\n`);
  return { ok: true, value: { path, baseline: baseline.value } };
};

// stdout carries only the report, so failures are logged to stderr, at warn unless LOG_LEVEL says otherwise.
const log = jsonLogger({ level: LogLevelSchema.catch("warn").parse(process.env.LOG_LEVEL) });

const USAGE = `usage: baseline.ts [--run NAME | --run-id ID] [--packages A,B] [--dir DIR]

Runs the run's config's baseline scripts in its workspace (--dir, else state.json's
workspace.path), writes artifacts/baseline.json and prints { path, workspace, packages }.
With neither --run nor --run-id, the run is $HARNESS_RUN_ID.
`;

const FLAGS = {
  run: { type: "string" },
  "run-id": { type: "string" },
  packages: { type: "string" },
  dir: { type: "string" },
} as const;

const fail = (error: string): void => {
  console.error(error);
  process.exitCode = 1;
};

const splitList = (value: string): string[] =>
  value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

const main = async (argv: readonly string[]): Promise<void> => {
  if (argv.includes("--help") || argv.includes("-h")) return void process.stdout.write(USAGE);
  // parseArgs throws on an unknown flag; main's caller prints that error.
  const flags = parseArgs({ args: [...argv], options: FLAGS }).values;
  const { packages, dir } = flags;
  const run = await requireRun({
    registry: createRegistryReader(registryPath()),
    name: flags.run,
    id: flags["run-id"],
    env: process.env,
    cwd: process.cwd(),
  });
  if (!run.ok) return fail(run.error);
  const config = await loadRunConfig(run.value);
  if (!config.ok) return fail(config.error);
  const result = await captureBaseline({
    config: config.value.config,
    run: run.value,
    dir: dir === undefined ? undefined : resolve(dir),
    packages: packages === undefined ? [] : splitList(packages),
    log,
  });
  if (!result.ok) return fail(`${result.error.code}: ${result.error.message}`);
  if (result.value === null) {
    return void console.log(JSON.stringify({ path: null, workspace: null, packages: {} }, null, 2));
  }
  // The scripts' output is in baseline.json; the report carries only the exit codes.
  const { path, baseline } = result.value;
  const codes = Object.entries(baseline.packages).map(([pkg, { exitCode }]) => [pkg, exitCode]);
  const workspace = baseline.workspace?.exitCode ?? null;
  console.log(JSON.stringify({ path, workspace, packages: Object.fromEntries(codes) }, null, 2));
};

if (import.meta.main) {
  stopRunningOnSignal();
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
