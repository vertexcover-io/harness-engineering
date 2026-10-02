import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  type Config,
  defaultConfig,
  loadConfigAt,
  loadConfigFile,
  loadConfigOrDefault,
} from "./config.ts";
import type { Result, State } from "./contracts.ts";
import { type RunRef, runDirOf } from "./events.ts";
import { readIfExists } from "./files.ts";
import { createGit } from "./git.ts";
import type { RegistryReader, WorkflowRun } from "./registry.ts";
import { readState } from "./state.ts";

const git = createGit();

const metaRepoOf = async (repo: string, dir: string): Promise<string | undefined> => {
  const parent = dirname(dir);
  if (parent === dir) return undefined;
  const config = await loadConfigOrDefault(parent);
  const claims =
    config.ok &&
    config.value.workspace.layout === "multi" &&
    Object.values(config.value.packages).some((pkg) => resolve(parent, pkg.path) === repo);
  return claims ? parent : metaRepoOf(repo, parent);
};

// The common git dir is shared by every worktree, so its parent is the main checkout wherever cwd is.
export const findRoot = async (cwd: string): Promise<Result<string>> => {
  const commonDir = await git.commonDir(cwd);
  if (commonDir === null) return { ok: false, error: "not inside a git repo; run from one" };
  const main = dirname(commonDir);
  return { ok: true, value: (await metaRepoOf(main, main)) ?? main };
};

// Unlike findRoot, this stays in a linked worktree: a branch's config applies to runs started there.
export const findConfigRoot = async (cwd: string): Promise<Result<string>> => {
  const top = await git.repoRoot(cwd);
  if (top === null) return { ok: false, error: `${cwd} is not inside a git repo` };
  return { ok: true, value: (await metaRepoOf(top, top)) ?? top };
};

export type CheckoutConfig = Readonly<{ config: Config; path: string | null; root: string }>;

const loadConfigWithRoot = async (path: string, root: string): Promise<Result<CheckoutConfig>> => {
  const loaded = await loadConfigAt(path);
  return loaded.ok ? { ok: true, value: { config: loaded.value.config, path, root } } : loaded;
};

// The file `harness run --config` named; its relative paths resolve against its own folder.
export const loadNamedConfig = (path: string): Promise<Result<CheckoutConfig>> =>
  loadConfigWithRoot(path, dirname(path));

// The config of cwd's checkout; a checkout with none gets the default.
export const loadCheckoutConfig = async (cwd: string): Promise<Result<CheckoutConfig>> => {
  const root = await findConfigRoot(cwd);
  if (!root.ok) return root;
  const loaded = await loadConfigFile(root.value);
  if (loaded.ok) return { ok: true, value: { ...loaded.value, root: root.value } };
  if (loaded.error.code !== "CONFIG_MISSING") return { ok: false, error: loaded.error.message };
  return { ok: true, value: { config: defaultConfig(), path: null, root: root.value } };
};

// The config init recorded in state.json. A recorded file that is gone is an error, never a
// fallback, since reading another config would hide the mistake.
export const loadRunConfig = async (run: RunRef): Promise<Result<CheckoutConfig>> =>
  loadRecordedConfig((await readState(runDirOf(run.cwd, run.name)))?.config, run.cwd);

// A state.json written before init recorded its config has none, so its checkout is searched.
export const loadRecordedConfig = async (
  recorded: State["config"],
  cwd: string,
): Promise<Result<CheckoutConfig>> => {
  if (recorded === undefined) return loadCheckoutConfig(cwd);
  if (recorded.path === null) {
    return { ok: true, value: { config: defaultConfig(), path: null, root: recorded.root } };
  }
  return loadConfigWithRoot(recorded.path, recorded.root);
};

export type RunLookup = Readonly<{ registry: RegistryReader; root: string; name: string }>;

// The folder must still exist, since writing to it would recreate a run folder with no
// workflow.started.
const toRunRef = (run: WorkflowRun, name: string): Result<RunRef> => {
  const dir = runDirOf(run.cwd, name);
  if (!existsSync(dir)) return { ok: false, error: `${dir} no longer exists` };
  return { ok: true, value: { id: run.id, cwd: run.cwd, name } };
};

// harness run saves the folder it started in, which can be a linked worktree or a multi-layout
// sub-repo, so a run belongs to the root its own folder resolves to.
const belongsTo = async (run: WorkflowRun, root: string): Promise<boolean> => {
  if (run.cwd === root) return true;
  const runRoot = await findRoot(run.cwd);
  return runRoot.ok && runRoot.value === root;
};

export const resolveRun = async ({ registry, root, name }: RunLookup): Promise<Result<RunRef>> => {
  const named = await registry.findRunsByName(name);
  const owned = await Promise.all(named.map((candidate) => belongsTo(candidate, root)));
  const run = named.find((_, index) => owned[index]);
  if (run === undefined) {
    return {
      ok: false,
      error: `no run named "${name}" in ${root}; start one with orchestrate init`,
    };
  }
  return toRunRef(run, name);
};

// A run id is unique everywhere; a run name only within a repo, so it comes with that repo's root.
export type RunTarget = Readonly<{ runId: string } | { name: string; root: string }>;

const findRunById = async (
  registry: RegistryReader,
  runId: string,
): Promise<Result<WorkflowRun>> => {
  const run = await registry.findRun(runId);
  return run === undefined
    ? { ok: false, error: `run ${runId} not found` }
    : { ok: true, value: run };
};

// A name resolves the way orchestrate resolves it (resolveRun), so a run started in a linked
// worktree or a sub-repo of `root` is found too.
export const findRunByIdOrName = async (
  registry: RegistryReader,
  target: RunTarget,
): Promise<Result<WorkflowRun>> => {
  if ("runId" in target) return findRunById(registry, target.runId);
  const found = await resolveRun({ registry, root: target.root, name: target.name });
  return found.ok ? findRunById(registry, found.value.id) : found;
};

const findInitializedRun = async (
  registry: RegistryReader,
  runId: string,
): Promise<Result<RunRef>> => {
  const run = await findRunById(registry, runId);
  if (!run.ok) return run;
  const { name } = run.value;
  if (name === null) {
    return { ok: false, error: `run ${runId} is not initialized; run orchestrate init` };
  }
  return toRunRef(run.value, name);
};

const findRunByName = async (
  registry: RegistryReader,
  name: string,
  cwd: string,
): Promise<Result<RunRef>> => {
  const root = await findRoot(cwd);
  return root.ok ? resolveRun({ registry, root: root.value, name }) : root;
};

export type PickRunInput = Readonly<{
  registry: RegistryReader;
  name?: string | undefined;
  id?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  // runs are named per main checkout, the one this folder belongs to
  cwd: string;
}>;

// --run-id, else --run, else $HARNESS_RUN_ID: a flag always wins over the session's environment.
// Nothing naming a run picks none, for the commands that can go on without one.
export const pickRun = async (input: PickRunInput): Promise<Result<RunRef | undefined>> => {
  const { registry, name, cwd } = input;
  const id = input.id ?? (name === undefined ? input.env.HARNESS_RUN_ID || undefined : undefined);
  if (id === undefined) {
    return name === undefined ? { ok: true, value: undefined } : findRunByName(registry, name, cwd);
  }
  const run = await findInitializedRun(registry, id);
  if (!run.ok || name === undefined || run.value.name === name) return run;
  return {
    ok: false,
    error: `--run ${name} and --run-id ${id} name different runs; ${id} is ${run.value.name}`,
  };
};

export const requireRun = async (input: PickRunInput): Promise<Result<RunRef>> => {
  const picked = await pickRun(input);
  if (!picked.ok) return picked;
  return picked.value === undefined
    ? { ok: false, error: "no run: pass --run or --run-id, or run inside a harness session" }
    : { ok: true, value: picked.value };
};

export const loadPickedConfig = (
  run: RunRef | undefined,
  cwd: string,
): Promise<Result<CheckoutConfig>> =>
  run === undefined ? loadCheckoutConfig(cwd) : loadRunConfig(run);

// The checkout's .env when it has one, else the main checkout's: the whole file, never merged.
// The checkout's folder is its config folder, so a multi-layout sub-repo reads the meta folder's.
const readEnvFile = async (cwd: string): Promise<string | null> => {
  const folder = await findConfigRoot(cwd);
  const own = await readIfExists(join(folder.ok ? folder.value : cwd, ".env"));
  if (own !== null) return own;
  const main = await findRoot(cwd);
  return main.ok ? readIfExists(join(main.value, ".env")) : null;
};

// Read on every call so a long-running process never sees stale values. A key the file sets
// wins; otherwise the process environment supplies it.
export const readProjectEnv = async (cwd: string, key: string): Promise<string | undefined> =>
  parseEnv((await readEnvFile(cwd)) ?? "")[key] ?? process.env[key];
