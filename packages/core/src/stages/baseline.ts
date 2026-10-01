import { statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type Config,
  type ILogger,
  loadConfig,
  NameSchema,
  NOT_FOUND,
  NonEmptyStringSchema,
  type Result,
  type RunRef,
  runDirOf,
  type SpawnResult,
  spawn,
  unknownPackage,
} from "@harness/sdk";
import { readState } from "@harness/sdk/internal";
import * as z from "zod";
import { MAX_OUTPUT_BYTES } from "../workflow/executors.ts";

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
  code:
    | "CONFIG_MISSING"
    | "CONFIG_AMBIGUOUS"
    | "CONFIG_INVALID"
    | "PACKAGE_UNKNOWN"
    | "STATE_MISSING"
    | "CONFIG_STALE"
    | "WORKTREE_MISSING";
  message: string;
}>;

export type BaselineOptions = Readonly<{
  root: string;
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
  const config = await loadConfig(options.root);
  if (!config.ok) return config;
  const workspace = await resolveWorkspace(options);
  if (!workspace.ok) return workspace;
  const log = options.log.child({ component: "baseline" });
  const scripts = collectScripts(config.value, workspace.value, options.packages, log);
  if (!scripts.ok) return scripts;
  if (scripts.value.length === 0) return { ok: true, value: null };
  const baseline = await runScripts(scripts.value, log);
  if (!baseline.ok) return baseline;
  const path = join(runDirOf(options.run.cwd, options.run.name), BASELINE_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(baseline.value, null, 2)}\n`);
  return { ok: true, value: { path, baseline: baseline.value } };
};
