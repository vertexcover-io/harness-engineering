import { existsSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type ArtifactRef,
  appendRunEvent,
  type Config,
  createState,
  type EmitInput,
  type EventHandlerRefs,
  emitRunEvent,
  eventError,
  findRoot,
  type IGit,
  type ILogger,
  type JsonValue,
  loadConfigOrDefault,
  type Registry,
  type Result,
  type RunLookup,
  type RunRef,
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
import { extensionPath } from "./stage.ts";
import { compileWorkflow } from "./workflow/compile.ts";
import { checkAgentOutput, runStepLeaf } from "./workflow/exec.ts";
import {
  buildParentsField,
  type Decision,
  decideNext,
  type Emit,
  findRunningLeaf,
  type RunningLeaf,
} from "./workflow/next.ts";
import type { NodeRecord, WorkflowPlan } from "./workflow/types.ts";

export type InitOptions = Readonly<{
  registry: Registry;
  runId: string;
  name: string;
  git: IGit;
  log: ILogger;
}>;

type CheckedInit = Readonly<{ run: WorkflowRun; eventHandlers: EventHandlerRefs }>;

const frozenHandlers = (config: Config, root: string): EventHandlerRefs =>
  Object.fromEntries(
    Object.entries(config.eventHandlers).map(([type, list]) => [
      type,
      list.map((ref) => ({ ...ref, module: resolve(root, ref.module) })),
    ]),
  );

const fillRunDir = async (checked: CheckedInit, options: InitOptions): Promise<State> => {
  const { run, eventHandlers } = checked;
  const { name } = options;
  const dir = runDirOf(run.cwd, name);
  await copyFile(run.workflowPath, join(dir, "workflow.yaml"));
  await createState({ runDir: dir, harnessVersion: String(corePackage.version), eventHandlers });
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

const checkInit = async (options: InitOptions): Promise<Result<CheckedInit>> => {
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
  const root = await findRoot(run.cwd);
  if (!root.ok) return root;
  const config = await loadConfigOrDefault(root.value);
  if (!config.ok) return config;
  return { ok: true, value: { run, eventHandlers: frozenHandlers(config.value, root.value) } };
};

export const initializeRun = async (
  options: InitOptions,
): Promise<Result<{ dir: string; state: State }>> => {
  const checked = await checkInit(options);
  if (!checked.ok) return checked;
  const { run } = checked.value;
  const dir = runDirOf(run.cwd, options.name);
  await mkdir(dir, { recursive: true });
  try {
    const state = await fillRunDir(checked.value, options);
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

export type StepReply =
  | Readonly<{
      kind: "exec";
      nodeRunId: string;
      nodeId: string;
      mode: "inline" | "background";
      command: string;
    }>
  | Readonly<{
      kind: "stage";
      nodeRunId: string;
      nodeId: string;
      stage: string;
      skill: string;
      extension: string | null;
      prompt?: string;
      input: JsonValue;
      done: string;
    }>
  | Readonly<{
      kind: "agent";
      nodeRunId: string;
      nodeId: string;
      prompt: string;
      input: JsonValue;
      done: string;
    }>
  | Exclude<Decision, { kind: "leaf" }>;

export type NextOptions = Readonly<{ root: string; config: Config }>;

export type StepOutcome = Readonly<{ output: JsonValue }> | Readonly<{ error: string }>;

export type StepReport = Readonly<{
  nodeRunId: string;
  nodeId: string;
  status: NodeRecord["status"];
  attempts: number;
  error?: Readonly<{ kind: string; message: string }>;
}>;

const buildStepCommand = (verb: "exec" | "done", nodeRunId: string, run: RunRef): string =>
  `bun run orchestrate ${verb} ${nodeRunId} --run ${run.name}`;

const readRunState = async (runDir: string): Promise<State> => {
  const state = await syncState(runDir);
  if (state === null)
    throw new Error(`${runDir}/state.json is missing; run orchestrate init first`);
  return state;
};

const compileWorkflowPlan = (run: RunRef): Promise<WorkflowPlan> =>
  compileWorkflow(join(runDirOf(run.cwd, run.name), "workflow.yaml"), { cwd: run.cwd });

const buildLeafReply = (
  decision: Extract<Decision, { kind: "leaf" }>,
  run: RunRef,
  options: NextOptions,
): StepReply => {
  const { node, nodeRunId, input } = decision;
  if (node.type !== "agent") {
    const mode = node.type === "exec" ? node.mode : "inline";
    return {
      kind: "exec",
      nodeRunId,
      nodeId: node.id,
      mode,
      command: buildStepCommand("exec", nodeRunId, run),
    };
  }
  const done = buildStepCommand("done", nodeRunId, run);
  if (node.stage === undefined) {
    return { kind: "agent", nodeRunId, nodeId: node.id, prompt: node.prompt ?? "", input, done };
  }
  const extension = extensionPath(options.config, node.stage.name);
  return {
    kind: "stage",
    nodeRunId,
    nodeId: node.id,
    stage: node.stage.ref,
    skill: node.stage.skill,
    extension: extension === undefined ? null : join(options.root, extension),
    ...(node.prompt === undefined ? {} : { prompt: node.prompt }),
    input,
    done,
  };
};

// Walks the run to its next step, saving each engine event to event.jsonl as it is recorded.
export const nextStep = async (run: RunRef, options: NextOptions): Promise<Result<StepReply>> => {
  const runDir = runDirOf(run.cwd, run.name);
  const [plan, state] = await Promise.all([compileWorkflowPlan(run), readRunState(runDir)]);
  const emit: Emit = async (_state, event) => {
    const appended = await appendRunEvent(run, event);
    if (!appended.ok) throw new Error(`${event.type} was not stored: ${appended.error}`);
    if (appended.value.state === null) throw new Error(`${runDir}/state.json is missing`);
    return appended.value.state;
  };
  const { decision } = await decideNext(plan, state, emit);
  const reply = decision.kind === "leaf" ? buildLeafReply(decision, run, options) : decision;
  return { ok: true, value: reply };
};

// The step the run is at, when `nodeRunId` is its run, read from its workflow and state.json.
const loadRunningLeaf = async (run: RunRef, nodeRunId: string): Promise<Result<RunningLeaf>> => {
  const runDir = runDirOf(run.cwd, run.name);
  const [plan, state] = await Promise.all([compileWorkflowPlan(run), readRunState(runDir)]);
  const step = findRunningLeaf(plan.nodes, state.nodeRuns, nodeRunId);
  if (step === undefined) {
    return { ok: false, error: `${nodeRunId} is not the step this run is running` };
  }
  return { ok: true, value: step };
};

// The event that records how a step ended.
const buildStepEndEvent = (
  step: RunningLeaf,
  record: NodeRecord,
  artifacts: readonly ArtifactRef[] = [],
): EmitInput => ({
  type: `workflow.node.${record.status}`,
  source: "workflow",
  nodeId: step.node.id,
  nodeRunId: record.path,
  payload: {
    nodeType: record.type,
    attempts: record.attempts,
    ...(record.output === undefined ? {} : { output: record.output }),
    ...(record.error === undefined
      ? {}
      : { error: eventError(record.error.kind, record.error.message, record.error.stack) }),
    ...(artifacts.length === 0 ? {} : { artifacts: [...artifacts] }),
    ...buildParentsField(step.node.parents),
  },
});

const buildReport = (step: RunningLeaf, record: NodeRecord): StepReport => ({
  nodeRunId: step.nodeRun.nodeRunId,
  nodeId: step.node.id,
  status: record.status,
  attempts: record.attempts,
  // The stack stays in event.jsonl; the agent reading this report only needs what went wrong.
  ...(record.error === undefined
    ? {}
    : { error: { kind: record.error.kind, message: record.error.message } }),
});

export const execStep = async (run: RunRef, nodeRunId: string): Promise<Result<StepReport>> => {
  const step = await loadRunningLeaf(run, nodeRunId);
  if (!step.ok) return step;
  const { node } = step.value;
  if (node.type !== "exec" && node.type !== "wait") {
    return {
      ok: false,
      error: `${nodeRunId} is a node of type ${node.type}; exec runs exec and wait nodes`,
    };
  }
  const input = step.value.nodeRun.input ?? null;
  const record = await runStepLeaf(node, input, { cwd: run.cwd, path: nodeRunId });
  const stored = await emitRunEvent(run, buildStepEndEvent(step.value, record));
  return stored.ok ? { ok: true, value: buildReport(step.value, record) } : stored;
};

// Finishes an agent or stage node that next handed out, with the output or error the agent reports.
export const finishStep = async (
  run: RunRef,
  nodeRunId: string,
  outcome: StepOutcome,
  artifacts: readonly ArtifactRef[],
): Promise<Result<StepReport>> => {
  const runDir = runDirOf(run.cwd, run.name);
  const step = await loadRunningLeaf(run, nodeRunId);
  if (!step.ok) return step;
  const { node } = step.value;
  if (node.type !== "agent") {
    return {
      ok: false,
      error: `${nodeRunId} is a node of type ${node.type}; done finishes agent and stage nodes`,
    };
  }
  const absent = artifacts.find((artifact) => !existsSync(join(runDir, artifact.path)));
  if (absent !== undefined) {
    return {
      ok: false,
      error: `artifact ${absent.name}: ${join(runDir, absent.path)} does not exist`,
    };
  }
  const record: NodeRecord =
    "error" in outcome
      ? {
          path: nodeRunId,
          type: node.type,
          status: "failed",
          attempts: 1,
          error: { kind: "exception", message: outcome.error },
        }
      : await checkAgentOutput(node, outcome.output, { cwd: run.cwd, path: nodeRunId });
  const kept = record.status === "completed" ? artifacts : [];
  const stored = await emitRunEvent(run, buildStepEndEvent(step.value, record, kept));
  return stored.ok ? { ok: true, value: buildReport(step.value, record) } : stored;
};
