import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createGit, type IGit, type ILogger } from "@harness/sdk";
import * as z from "zod";
import { loadConfigOrDefault } from "./config.ts";
import { type Result, SlugSchema, type State } from "./contracts.ts";
import { type RunRef, runDirOf } from "./events.ts";
import { type Registry, type SessionRef, SessionRefSchema, type WorkflowRun } from "./registry.ts";
import { createState, emitRunEvent, syncState } from "./state.ts";

export type InitOptions = Readonly<{
  registry: Registry;
  runId: string;
  name: string;
  git: IGit;
  log: ILogger;
}>;

const fillRunDir = async (run: WorkflowRun, name: string, options: InitOptions): Promise<State> => {
  const dir = runDirOf(run.cwd, name);
  await copyFile(run.workflowPath, join(dir, "workflow.yaml"));
  await createState(dir);
  const appended = await emitRunEvent(
    { id: run.id, cwd: run.cwd, name },
    {
      id: "workflow-started",
      type: "workflow.started",
      source: "orchestrate",
      payload: { workflow: run.workflow, inputs: run.inputs },
    },
  );
  if (!appended.ok) throw new Error(appended.error);
  const state = await syncState(dir);
  if (state === null) throw new Error(`${dir}/state.json disappeared during init`);
  options.log.debug({ dir, lastEventSeq: state.lastEventSeq }, "run folder written");
  return state;
};

const checkInit = async (options: InitOptions): Promise<Result<WorkflowRun>> => {
  const { registry, runId, name, git } = options;
  const parsed = SlugSchema.safeParse(name);
  if (!parsed.success) {
    return { ok: false, error: `invalid run name "${name}": ${z.prettifyError(parsed.error)}` };
  }
  const run = await registry.findRun(runId);
  if (run === undefined) return { ok: false, error: `run ${runId} not found` };
  if (run.name !== null) {
    return { ok: false, error: `run ${runId} is already initialized as ${run.name}` };
  }
  if (existsSync(runDirOf(run.cwd, name))) {
    return { ok: false, error: `.harness/${name} already exists` };
  }
  if ((await git.repoRoot(run.cwd)) === null) {
    return { ok: false, error: `${run.cwd} is not inside a git repository` };
  }
  return { ok: true, value: run };
};

export const initializeRun = async (
  options: InitOptions,
): Promise<Result<{ dir: string; state: State }>> => {
  const checked = await checkInit(options);
  if (!checked.ok) return checked;
  const run = checked.value;
  const dir = runDirOf(run.cwd, options.name);
  await mkdir(dir, { recursive: true });
  try {
    const state = await fillRunDir(run, options.name, options);
    await options.registry.initRun(run.id, options.name);
    options.log.info({ runId: run.id, name: options.name, dir }, "run initialized");
    return { ok: true, value: { dir, state } };
  } catch (error) {
    // A half-built folder would make every retry answer "already exists".
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
};

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
  if (commonDir === null) {
    return { ok: false, error: "not inside a git repo; run from one or pass --root" };
  }
  const main = dirname(commonDir);
  return { ok: true, value: (await metaRepoOf(main, main)) ?? main };
};

type RunLookup = Readonly<{ registry: Registry; root: string; name: string }>;

// Every action after init names its run by spec name; the folder must still exist, since
// writing to it would recreate a run folder with no workflow.started.
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
  const dir = runDirOf(run.cwd, name);
  if (!existsSync(dir)) return { ok: false, error: `${dir} no longer exists` };
  return { ok: true, value: { id: run.id, cwd: run.cwd, name } };
};

export const linkRunSession = async (
  options: RunLookup & Readonly<{ agent: string; sessionId: string }>,
): Promise<Result<readonly SessionRef[]>> => {
  const session = SessionRefSchema.safeParse({
    agent: options.agent,
    sessionId: options.sessionId,
  });
  if (!session.success) return { ok: false, error: z.prettifyError(session.error) };
  const run = await resolveRun(options);
  if (!run.ok) return run;
  await options.registry.linkSession(run.value.id, session.data);
  const linked = await options.registry.findRun(run.value.id);
  return { ok: true, value: linked?.sessions ?? [session.data] };
};
