import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile as copyFileFs, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { GitState, Result, State } from "@harness/core";
import { coreHandlers, emitRunEvent, jsonlEventStore, runDirOf, syncState } from "@harness/core";
import type { IAgentProvider, IGit, ILogger, ITerminal } from "@harness/sdk";
import type { Context } from "hono";
import { Hono } from "hono";
import serverPackage from "../package.json";
import { errorResponse, jsonBody, type Vars } from "./api.ts";
import {
  type EmitBody,
  EmitBodySchema,
  type InitBody,
  InitBodySchema,
  type SessionRef,
  SessionRefSchema,
  type StartRunBody,
  StartRunBodySchema,
  type WorkflowRun,
} from "./protocol.ts";
import type { Registry } from "./registry.ts";

export const readGit = async (cwd: string, git: IGit): Promise<GitState> => {
  const [branch, sha, defaultBranch] = await Promise.all([
    git.currentBranch(cwd),
    git.headSha(cwd),
    git.defaultBranch(cwd),
  ]);
  const branchName = branch.ok ? branch.value : "HEAD";
  return {
    branch: branchName,
    startSha: sha.ok ? sha.value : "",
    baseBranch: defaultBranch ?? branchName,
  };
};

// mkdtemp and other repo folders can hold spaces, mixed case, or symbols the slug schema rejects.
const slug = (value: string): string => {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? "repo" : cleaned;
};

export const initialState = (run: WorkflowRun, name: string, git: GitState): State => {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    lastEventSeq: 0,
    specName: name,
    harnessVersion: String(serverPackage.version),
    workflow: { name: run.workflow, path: "workflow.yaml" },
    input: run.inputs,
    scope: "workflow",
    options: {},
    startedAt: now,
    completedAt: null,
    outcome: null,
    currentFile: null,
    workspace: {
      path: run.cwd,
      repositories: { [slug(basename(run.cwd))]: { path: run.cwd, git } },
    },
    activeNodeRuns: [],
    nodeRuns: {},
  };
};

export type InitDeps = Readonly<{ git: IGit; log: ILogger }>;
export type InitError = "dir-exists" | "not-a-repo";

const fillRunDir = async (
  run: WorkflowRun,
  name: string,
  dir: string,
  deps: InitDeps,
): Promise<State> => {
  await copyFileFs(run.workflowPath, join(dir, "workflow.yaml"));

  const appended = await emitRunEvent(
    { id: run.id, cwd: run.cwd, name },
    {
      id: "workflow-started",
      type: "workflow.started",
      source: "harness-server",
      payload: { workflow: run.workflow, inputs: run.inputs },
    },
  );
  if (!appended.ok) {
    deps.log.error(
      { dir, err: appended.error },
      "could not append workflow.started to event.jsonl",
    );
    throw new Error(appended.error);
  }
  deps.log.debug(
    { seq: appended.value.seq, type: appended.value.type },
    "event appended to event.jsonl",
  );

  const git = await readGit(run.cwd, deps.git);
  const state = await syncState({
    runDir: dir,
    store: jsonlEventStore(dir),
    seed: initialState(run, name, git),
    handlers: coreHandlers,
  });
  deps.log.debug({ lastEventSeq: state.lastEventSeq }, "state.json written from the event log");

  return state;
};

export const initializeRun = async (
  run: WorkflowRun,
  name: string,
  deps: InitDeps,
): Promise<Result<{ dir: string; state: State }, InitError>> => {
  const dir = runDirOf(run.cwd, name);
  if (existsSync(dir)) return { ok: false, error: "dir-exists" };
  if ((await deps.git.repoRoot(run.cwd)) === null) return { ok: false, error: "not-a-repo" };

  await mkdir(dir, { recursive: true });
  try {
    const state = await fillRunDir(run, name, dir, deps);
    return { ok: true, value: { dir, state } };
  } catch (error) {
    // A half-built folder would make every retry answer "already exists".
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
};

export type RunDeps = Readonly<{
  registry: Registry;
  provider: IAgentProvider;
  terminal: ITerminal;
  git: IGit;
  home: string;
}>;

const startRun = async (c: Context<{ Variables: Vars }>, deps: RunDeps, body: StartRunBody) => {
  const log = c.get("log").child({ component: "runs" });
  const { workflow, workflowPath, inputs, cwd } = body;

  if (!existsSync(workflowPath) || !existsSync(cwd)) {
    return errorResponse(c, 400, "bad-request", "workflowPath and cwd must exist");
  }

  const id = `r-${randomBytes(4).toString("hex")}`;
  const runLog = log.child({ runId: id });
  // Saved before the agent starts: its first step is `harness init`, which must find the run.
  const pending: WorkflowRun = {
    id,
    workflow,
    workflowPath,
    inputs,
    cwd,
    sessions: [],
    name: null,
    createdAt: new Date().toISOString(),
  };
  await deps.registry.addRun(pending);

  // A run whose agent never started is removed, so a failed start records nothing.
  const launched = await deps.provider
    .launch({
      cwd,
      prompt: `/orchestrate-v2 --workflow ${workflowPath} --inputs ${JSON.stringify(inputs)}`,
      env: { HARNESS_RUN_ID: id, HARNESS_HOME: deps.home },
    })
    .catch(async (error: unknown) => {
      await deps.registry.removeRun(id);
      throw error;
    });
  if (!launched.ok) {
    await deps.registry.removeRun(id);
    runLog.error(
      { err: String(launched.error) },
      "run not started: the agent session failed to launch",
    );
    return errorResponse(c, 502, "agent-failed", String(launched.error));
  }

  const { sessionId } = launched.value;
  const session = { agent: deps.provider.type, sessionId };
  await deps.registry.linkSession(id, session);
  const run = (await deps.registry.findRun(id)) ?? { ...pending, sessions: [session] };
  runLog.info({ workflow, cwd, agent: deps.provider.type, sessionId }, "run started");
  return c.json({ run, attach: [...deps.terminal.attachCommand(sessionId)] }, 201);
};

const initRun = async (
  c: Context<{ Variables: Vars }>,
  deps: RunDeps,
  runId: string,
  { name }: InitBody,
) => {
  const log = c.get("log").child({ component: "runs", runId });

  const run = await deps.registry.findRun(runId);
  if (run === undefined) return errorResponse(c, 404, "not-found", `run ${runId} not found`);
  if (run.name !== null) {
    return errorResponse(c, 409, "conflict", `run is already initialized as ${run.name}`);
  }

  const result = await initializeRun(run, name, { git: deps.git, log });
  if (!result.ok) {
    if (result.error === "dir-exists") {
      return errorResponse(c, 409, "conflict", `.harness/${name} already exists`);
    }
    return errorResponse(c, 400, "bad-request", `${run.cwd} is not inside a git repository`);
  }

  const { dir, state } = result.value;
  await deps.registry.initRun(run.id, name);
  log.info({ name, dir }, "run initialized");
  return c.json({ run: { ...run, name }, dir, state }, 201);
};

const linkSession = async (
  c: Context<{ Variables: Vars }>,
  deps: RunDeps,
  runId: string,
  session: SessionRef,
) => {
  const log = c.get("log").child({ component: "runs", runId });

  const run = await deps.registry.findRun(runId);
  if (run === undefined) return errorResponse(c, 404, "not-found", `run ${runId} not found`);

  const added = await deps.registry.linkSession(run.id, session);
  const updated = (await deps.registry.findRun(run.id)) ?? run;
  log.info(
    { agent: session.agent, sessionId: session.sessionId },
    added ? "session linked to the run" : "session was already linked; nothing changed",
  );
  return c.json({ run: updated }, 200);
};

const postEvent = async (
  c: Context<{ Variables: Vars }>,
  deps: RunDeps,
  runId: string,
  body: EmitBody,
) => {
  const log = c.get("log").child({ component: "runs", runId });

  const run = await deps.registry.findRun(runId);
  if (run === undefined) return errorResponse(c, 404, "not-found", `run ${runId} not found`);
  if (run.name === null) {
    return errorResponse(c, 409, "conflict", "run has no task: run harness init first");
  }

  const dir = runDirOf(run.cwd, run.name);
  // Appending would recreate the folder and start a log with no workflow.started.
  if (!existsSync(dir)) return errorResponse(c, 409, "conflict", `${dir} no longer exists`);
  const result = await emitRunEvent({ id: run.id, cwd: run.cwd, name: run.name }, body);
  if (!result.ok) {
    log.warn({ type: body.type, err: result.error }, "event refused");
    return errorResponse(c, 400, "bad-request", result.error);
  }
  log.info({ type: result.value.type, seq: result.value.seq }, "event stored");
  return c.json({ event: result.value }, 200);
};

// Mounted at /runs by app.ts. Chained, so each route's input and output types reach AppType.
export const runRoutes = (deps: RunDeps) =>
  new Hono<{ Variables: Vars }>()
    .post("/", jsonBody(StartRunBodySchema), (c) => startRun(c, deps, c.req.valid("json")))
    .post("/:id/init", jsonBody(InitBodySchema), (c) =>
      initRun(c, deps, c.req.param("id"), c.req.valid("json")),
    )
    .post("/:id/link-session", jsonBody(SessionRefSchema), (c) =>
      linkSession(c, deps, c.req.param("id"), c.req.valid("json")),
    )
    .post("/:id/emit", jsonBody(EmitBodySchema), (c) =>
      postEvent(c, deps, c.req.param("id"), c.req.valid("json")),
    );
