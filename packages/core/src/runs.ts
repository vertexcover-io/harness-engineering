import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createState,
  emitRunEvent,
  type IGit,
  type ILogger,
  type Registry,
  type Result,
  type RunLookup,
  resolveRun,
  runDirOf,
  type SessionRef,
  SessionRefSchema,
  SlugSchema,
  type State,
  syncState,
  type WorkflowRun,
} from "@harness/sdk";
import * as z from "zod";
import corePackage from "../package.json";

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
  await createState(dir, String(corePackage.version));
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
