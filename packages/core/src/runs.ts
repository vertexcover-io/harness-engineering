import { access, copyFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { PaneTarget } from "@harness/agents";
import {
  type ArtifactRef,
  appendRunEvent,
  appendRunEventIf,
  type Config,
  createState,
  type DoneStatus,
  type EmitInput,
  type EventHandlerRefs,
  emitRunEvent,
  eventError,
  findRoot,
  type IGit,
  type ILogger,
  type JsonValue,
  jsonlEventStore,
  loadConfigOrDefault,
  type NodeRun,
  orchestrateCommand,
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
  type StepOutcome,
  type StepReport,
  stackOf,
  syncState,
  type VerifierRun,
  type WorkflowRun,
} from "@harness/sdk";
import * as z from "zod";
import corePackage from "../package.json";
import { extensionPath } from "./stage.ts";
import { compileWorkflow } from "./workflow/compile.ts";
import {
  type CompletionIssue,
  CompletionIssueSchema,
  findConsumedArtifacts,
  findDefaultIssues,
} from "./workflow/done.ts";
import { runStepLeaf } from "./workflow/exec.ts";
import {
  buildParentsField,
  type Decision,
  decideNext,
  type Emit,
  findRunningLeaf,
  type RunningLeaf,
} from "./workflow/next.ts";
import {
  type ContextNode,
  type NodeRecord,
  type PlanAgentNode,
  type PlanContextNode,
  WorkflowError,
  type WorkflowPlan,
} from "./workflow/types.ts";
import { artifactPaths, issuesOf, runVerifiers } from "./workflow/verifiers.ts";

export type InitOptions = Readonly<{
  registry: Registry;
  runId: string;
  name: string;
  git: IGit;
  log: ILogger;
  // the agent's tmux pane, when init runs inside one
  pane?: PaneTarget | undefined;
}>;

export const terminalName = (runName: string, runId: string): string =>
  `claude-${runName}-${runId.slice(-4)}`;

// A failed rename is only logged: the run works, its tmux session just keeps the old name.
const renameTerminal = async (run: WorkflowRun, options: InitOptions): Promise<void> => {
  const { pane: target, registry, name, log } = options;
  if (target === undefined) return;
  const { terminal: tmux, pane } = target;
  const terminal = terminalName(name, run.id);
  try {
    const renamed = await tmux.rename(pane, terminal);
    if (!renamed.ok) {
      log.warn({ runId: run.id, pane, err: renamed.error }, "tmux session not renamed");
      return;
    }
    await registry.setTerminal(run.id, terminal);
  } catch (error) {
    log.warn({ runId: run.id, pane, err: error }, "tmux session not renamed");
  }
};

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
  const version = String(corePackage.version);
  await createState({ runId: run.id, runDir: dir, version, eventHandlers });
  const appended = await emitRunEvent(
    { id: run.id, cwd: run.cwd, name },
    {
      id: "workflow-started",
      type: "workflow.started",
      source: "orchestrate",
      payload: { workflow: run.workflow, inputs: run.inputs, activeSessions: run.sessions },
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
  const taken = await access(runDirOf(run.cwd, name)).then(
    () => true,
    () => false,
  );
  if (taken) {
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
    await renameTerminal(run, options);
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
      variables: Readonly<Record<string, string>>;
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
  | Readonly<{ kind: "context"; nodeRunId: string; nodeId: string; action: ContextNode["action"] }>
  | Exclude<Decision, { kind: "leaf" }>;

type NextOptions = Readonly<{ root: string; config: Config }>;

type Call = Readonly<{ command: "next" | "exec" | "done"; input: JsonValue }>;

// A reply is plain data the CLI prints as JSON; parsing it gives it the type an event payload takes.
const replyOf = (outcome: Result<unknown, string | DoneError> | Error): JsonValue => {
  if (outcome instanceof Error) return eventError("error", outcome.message, stackOf(outcome));
  if (!outcome.ok) {
    const message =
      typeof outcome.error === "string" ? outcome.error : JSON.stringify(outcome.error, null, 2);
    return eventError("error", message, undefined);
  }
  return z.json().parse(outcome.value);
};

// What a done call did to its node, logged beside its reply.
const doneStatusOf = (outcome: Result<StepReport, DoneError> | Error): DoneStatus => {
  if (outcome instanceof Error) return "error";
  if (outcome.ok) return outcome.value.status;
  if (outcome.error.kind === "validation") return "rejected";
  return outcome.error.kind === "verify-exhausted" ? "failed" : "error";
};

// Logs the call to event.jsonl with what it was given and what it replied, even when it threw,
// so the log shows every step the skill took. The call's own result or error is passed on.
const logCall = async <T, E extends string | DoneError = string>(
  run: RunRef,
  call: Call,
  pending: Promise<Result<T, E>>,
  statusOf?: (outcome: Result<T, E> | Error) => DoneStatus,
): Promise<Result<T, E>> => {
  const outcome = await pending.catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  const status = statusOf === undefined ? {} : { status: statusOf(outcome) };
  const logged = await emitRunEvent(run, {
    type: `orchestrate.${call.command}`,
    source: "orchestrate",
    payload: { input: call.input, output: replyOf(outcome), ...status },
  });
  if (outcome instanceof Error) throw outcome;
  if (!logged.ok) throw new Error(`orchestrate.${call.command} was not stored: ${logged.error}`);
  return outcome;
};
export const DoneErrorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("input"),
    retryable: z.literal(true),
    flag: z.string(),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("validation"),
    retryable: z.literal(true),
    nodeRunId: z.string(),
    issues: z.array(CompletionIssueSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("verify-exhausted"),
    retryable: z.literal(false),
    nodeRunId: z.string(),
    issues: z.array(CompletionIssueSchema).min(1),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("not-running"),
    retryable: z.literal(false),
    nodeRunId: z.string(),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("configuration"),
    retryable: z.literal(false),
    code: z.string(),
    path: z.string(),
    message: z.string(),
  }),
  z.strictObject({ kind: z.literal("storage"), retryable: z.literal(false), message: z.string() }),
]);

export type DoneError = z.infer<typeof DoneErrorSchema>;

const readRunState = async (runDir: string): Promise<State> => {
  const state = await syncState(runDir);
  if (state === null)
    throw new Error(`${runDir}/state.json is missing; run orchestrate init first`);
  return state;
};

type RunDirRef = Pick<RunRef, "cwd" | "name">;

const compileWorkflowPlan = (run: RunDirRef): Promise<WorkflowPlan> =>
  compileWorkflow(join(runDirOf(run.cwd, run.name), "workflow.yaml"), { cwd: run.cwd });

const buildLeafReply = (
  decision: Extract<Decision, { kind: "leaf" }>,
  run: RunRef,
  options: NextOptions,
): StepReply => {
  const { node, nodeRunId, input, variables } = decision;
  if (node.type === "context") {
    return { kind: "context", nodeRunId, nodeId: node.id, action: node.action };
  }
  if (node.type !== "agent") {
    const mode = node.type === "exec" ? node.mode : "inline";
    return {
      kind: "exec",
      nodeRunId,
      nodeId: node.id,
      mode,
      command: orchestrateCommand({ verb: "exec", run, nodeRunId }),
    };
  }
  const done = orchestrateCommand({ verb: "done", run, nodeRunId });
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
    variables,
    done,
  };
};

// Walks the run to its next step, saving each engine event to event.jsonl as it is recorded.
const walkToNextStep = async (run: RunRef, root: string): Promise<Result<StepReply>> => {
  const config = await loadConfigOrDefault(root);
  if (!config.ok) return config;
  const runDir = runDirOf(run.cwd, run.name);
  const [plan, state] = await Promise.all([compileWorkflowPlan(run), readRunState(runDir)]);
  const emit: Emit = async (_state, event) => {
    const appended = await appendRunEvent(run, event);
    if (!appended.ok) throw new Error(`${event.type} was not stored: ${appended.error}`);
    if (appended.value.state === null) throw new Error(`${runDir}/state.json is missing`);
    return appended.value.state;
  };
  const { decision } = await decideNext(plan, state, emit);
  const options = { root, config: config.value };
  const reply = decision.kind === "leaf" ? buildLeafReply(decision, run, options) : decision;
  return { ok: true, value: reply };
};

export const nextStep = (run: RunRef, root: string): Promise<Result<StepReply>> =>
  logCall(run, { command: "next", input: {} }, walkToNextStep(run, root));

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
    ...(record.process === undefined ? {} : { process: record.process }),
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

const runExecStep = async (run: RunRef, nodeRunId: string): Promise<Result<StepReport>> => {
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

export const execStep = (run: RunRef, nodeRunId: string): Promise<Result<StepReport>> =>
  logCall(run, { command: "exec", input: { nodeRunId } }, runExecStep(run, nodeRunId));
type ContextLeaf = RunningLeaf & Readonly<{ node: PlanContextNode }>;

const loadContextLeaf = async (run: RunRef, nodeRunId: string): Promise<Result<ContextLeaf>> => {
  const step = await loadRunningLeaf(run, nodeRunId);
  if (!step.ok) return step;
  const { node, nodeRun } = step.value;
  if (node.type !== "context") {
    return { ok: false, error: `${nodeRunId} is a node of type ${node.type}, not a context node` };
  }
  return { ok: true, value: { node, nodeRun } };
};

// The open context node `nodeRunId` names: what it asks for (action, and prompt for a compact).
export const findContextPlanNode = async (
  run: RunRef,
  nodeRunId: string,
): Promise<Result<PlanContextNode>> => {
  const leaf = await loadContextLeaf(run, nodeRunId);
  return leaf.ok ? { ok: true, value: leaf.value.node } : leaf;
};

// A context node always completes: a new session or a compact that did not happen leaves the
// agent with the context it had, which is no reason to skip the steps after it. Its output says
// whether the action was applied.
export const completeContextStep = async (
  run: RunRef,
  nodeRunId: string,
  output: JsonValue,
): Promise<Result<StepReport>> => {
  const leaf = await loadContextLeaf(run, nodeRunId);
  if (!leaf.ok) return leaf;
  const record: NodeRecord = {
    path: nodeRunId,
    type: "context",
    status: "completed",
    attempts: 1,
    output,
  };
  const stored = await emitRunEvent(run, buildStepEndEvent(leaf.value, record));
  return stored.ok ? { ok: true, value: buildReport(leaf.value, record) } : stored;
};

const isRunningNodeRun = (runs: Readonly<Record<string, NodeRun>>, nodeRunId: string): boolean =>
  Object.values(runs).some(
    (nodeRun) =>
      nodeRun.status === "running" &&
      (nodeRun.nodeRunId === nodeRunId || isRunningNodeRun(nodeRun.nodes ?? {}, nodeRunId)),
  );

// Finishes an agent or stage node that next handed out, with the output or error the agent reports.
const recordStepEnd = async (
  run: RunRef,
  nodeRunId: string,
  outcome: StepOutcome,
  artifacts: readonly ArtifactRef[],
): Promise<Result<StepReport, DoneError>> => {
  try {
    return await finishStepChecked(run, nodeRunId, outcome, artifacts);
  } catch (error) {
    if (error instanceof WorkflowError) {
      return {
        ok: false,
        error: {
          kind: "configuration",
          retryable: false,
          code: error.code,
          path: error.path,
          message: error.message,
        },
      };
    }
    return {
      ok: false,
      error: {
        kind: "storage",
        retryable: false,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
};

const finishStepChecked = async (
  run: RunRef,
  nodeRunId: string,
  outcome: StepOutcome,
  artifacts: readonly ArtifactRef[],
): Promise<Result<StepReport, DoneError>> => {
  const step = await loadRunningLeaf(run, nodeRunId);
  if (!step.ok) {
    return {
      ok: false,
      error: { kind: "not-running", retryable: false, nodeRunId, message: step.error },
    };
  }
  const { node } = step.value;
  if (node.type !== "agent") {
    return {
      ok: false,
      error: {
        kind: "configuration",
        retryable: false,
        code: "wrong-node-type",
        path: nodeRunId,
        message: `${nodeRunId} is a node of type ${node.type}; done finishes agent and stage nodes`,
      },
    };
  }
  if (!("error" in outcome)) {
    const { issues, rejected } = await checkCompletion(
      run,
      node,
      nodeRunId,
      outcome.output,
      artifacts,
    );
    if (issues.length > 0) return rejectDone(run, step.value, issues, rejected);
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
      : {
          path: nodeRunId,
          type: node.type,
          status: "completed",
          attempts: 1,
          output: outcome.output,
        };
  const kept = record.status === "completed" ? artifacts : [];
  return storeStepEnd(run, step.value, record, kept);
};

const storeStepEnd = async (
  run: RunRef,
  step: RunningLeaf,
  record: NodeRecord,
  artifacts: readonly ArtifactRef[],
): Promise<Result<StepReport, DoneError>> => {
  const nodeRunId = step.nodeRun.nodeRunId;
  const stored = await appendRunEventIf(
    run,
    buildStepEndEvent(step, record, artifacts),
    (state) => state !== null && isRunningNodeRun(state.nodeRuns, nodeRunId),
  );
  if (!stored.ok && stored.error === "condition-failed") {
    return {
      ok: false,
      error: {
        kind: "not-running",
        retryable: false,
        nodeRunId,
        message: `${nodeRunId} is no longer running`,
      },
    };
  }
  return stored.ok
    ? { ok: true, value: buildReport(step, record) }
    : { ok: false, error: { kind: "storage", retryable: false, message: stored.error } };
};

// What rejects this done, and how many earlier dones were rejected. The log is only read when this
// done could be rejected.
const checkCompletion = async (
  run: RunRef,
  node: PlanAgentNode,
  nodeRunId: string,
  output: JsonValue,
  artifacts: readonly ArtifactRef[],
): Promise<Readonly<{ issues: readonly CompletionIssue[]; rejected: number }>> => {
  const defaults = await findDefaultIssues(node, output, artifacts, runDirOf(run.cwd, run.name));
  const verifiers = node.stage?.verifiers ?? [];
  if (defaults.length === 0 && verifiers.length === 0) return { issues: [], rejected: 0 };
  const rejected = await countRejectedDones(run, nodeRunId);
  if (defaults.length > 0) return { issues: defaults, rejected };
  const input = {
    run: run.name,
    nodeRunId,
    output,
    artifacts: artifactPaths(runDirOf(run.cwd, run.name), artifacts),
  };
  const runs = await runVerifiers(verifiers, input, run.cwd, rejected + 1);
  await logVerifierRuns(run, node, nodeRunId, runs);
  return { issues: issuesOf(runs), rejected };
};

// One orchestrate.verifier event per verifier, in the order the stage lists them.
const logVerifierRuns = async (
  run: RunRef,
  node: PlanAgentNode,
  nodeRunId: string,
  runs: readonly VerifierRun[],
): Promise<void> => {
  for (const verifierRun of runs) {
    const logged = await emitRunEvent(run, {
      type: "orchestrate.verifier",
      source: "orchestrate",
      nodeId: node.id,
      nodeRunId,
      stage: node.stage?.name,
      payload: z.json().parse(verifierRun),
    });
    if (!logged.ok) throw new Error(`orchestrate.verifier was not stored: ${logged.error}`);
  }
};

const MAX_REJECTED_DONES = 3;

const RejectedDoneEventSchema = z.object({
  type: z.literal("orchestrate.done"),
  payload: z.object({
    input: z.object({ nodeRunId: z.string() }),
    status: z.literal("rejected"),
  }),
});

// Earlier rejected done calls for this node run, counted from the calls logCall keeps.
const countRejectedDones = async (run: RunDirRef, nodeRunId: string): Promise<number> => {
  const events = await jsonlEventStore(runDirOf(run.cwd, run.name)).read();
  return events.filter((event) => {
    const parsed = RejectedDoneEventSchema.safeParse(event);
    return parsed.success && parsed.data.payload.input.nodeRunId === nodeRunId;
  }).length;
};

const rejectDone = async (
  run: RunRef,
  step: RunningLeaf,
  issues: readonly CompletionIssue[],
  rejected: number,
): Promise<Result<StepReport, DoneError>> => {
  const nodeRunId = step.nodeRun.nodeRunId;
  if (rejected + 1 < MAX_REJECTED_DONES) {
    return {
      ok: false,
      error: { kind: "validation", retryable: true, nodeRunId, issues: [...issues] },
    };
  }
  const message = `done was rejected ${MAX_REJECTED_DONES} times; the node is failed`;
  const record: NodeRecord = {
    path: nodeRunId,
    type: step.node.type,
    status: "failed",
    attempts: MAX_REJECTED_DONES,
    error: { kind: "exhausted", message },
  };
  const stored = await storeStepEnd(run, step, record, []);
  if (!stored.ok) return stored;
  return {
    ok: false,
    error: { kind: "verify-exhausted", retryable: false, nodeRunId, issues: [...issues], message },
  };
};

export const finishStep = (
  run: RunRef,
  nodeRunId: string,
  outcome: StepOutcome,
  artifacts: readonly ArtifactRef[],
): Promise<Result<StepReport, DoneError>> =>
  logCall(
    run,
    { command: "done", input: { nodeRunId, ...outcome, artifacts: [...artifacts] } },
    recordStepEnd(run, nodeRunId, outcome, artifacts),
    doneStatusOf,
  );

// Helpers for verifiers. A run is found by its name and the folder it was started in, which a
// function verifier gets as context.cwd and a script verifier as its working directory.

// Everything a verifier can ask about a node run, reading the workflow, state.json and the log once.
export const getNodeFacts = async (run: string, nodeRunId: string, cwd: string) => {
  const ref = { cwd, name: run };
  const runDir = runDirOf(cwd, run);
  const [plan, state, rejected] = await Promise.all([
    compileWorkflowPlan(ref),
    readRunState(runDir),
    countRejectedDones(ref, nodeRunId),
  ]);
  const step = findRunningLeaf(plan.nodes, state.nodeRuns, nodeRunId);
  if (step === undefined) throw new Error(`${nodeRunId} is not the step this run is running`);
  const { node, nodeRun } = step;
  const stage = node.type === "agent" ? node.stage : undefined;
  const consumed = stage === undefined ? [] : findConsumedArtifacts(stage, state.nodeRuns);
  return {
    nodeRunId,
    nodeId: node.id,
    stage: stage?.name ?? null,
    input: nodeRun.input ?? null,
    attempt: rejected + 1,
    consumed: artifactPaths(runDir, consumed),
    runDir,
    artifactsDir: join(runDir, "artifacts"),
  };
};

export const getNodeRun = async (run: string, nodeRunId: string, cwd: string) => {
  const { nodeId, stage, input, attempt } = await getNodeFacts(run, nodeRunId, cwd);
  return { nodeId, stage, input, attempt };
};

export const getConsumed = async (
  run: string,
  nodeRunId: string,
  cwd: string,
): Promise<Readonly<Record<string, string>>> => (await getNodeFacts(run, nodeRunId, cwd)).consumed;
