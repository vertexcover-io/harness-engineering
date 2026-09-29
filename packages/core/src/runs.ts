import { existsSync, realpathSync, statSync } from "node:fs";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  type ArtifactRef,
  appendRunEvent,
  appendRunEventIf,
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
  type WorkflowRun,
} from "@harness/sdk";
import * as z from "zod";
import corePackage from "../package.json";
import { extensionPath } from "./stage.ts";
import { compileWorkflow } from "./workflow/compile.ts";
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
  type NodeRecord,
  type PlanStage,
  WorkflowError,
  type WorkflowPlan,
} from "./workflow/types.ts";

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
  const version = String(corePackage.version);
  await createState({ runId: run.id, runDir: dir, version, eventHandlers });
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

// Logs the call to event.jsonl with what it was given and what it replied, even when it threw,
// so the log shows every step the skill took. The call's own result or error is passed on.
const logCall = async <T, E extends string | DoneError = string>(
  run: RunRef,
  call: Call,
  pending: Promise<Result<T, E>>,
): Promise<Result<T, E>> => {
  const outcome = await pending.catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  const logged = await emitRunEvent(run, {
    type: `orchestrate.${call.command}`,
    source: "orchestrate",
    payload: { input: call.input, output: replyOf(outcome) },
  });
  if (outcome instanceof Error) throw outcome;
  if (!logged.ok) throw new Error(`orchestrate.${call.command} was not stored: ${logged.error}`);
  return outcome;
};
export const CompletionIssueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("output-schema"),
    schema: z.string(),
    path: z.string(),
    message: z.string(),
  }),
  z.strictObject({ kind: z.literal("required-artifact"), name: z.string() }),
  z.strictObject({
    kind: z.literal("artifact-file"),
    name: z.string(),
    path: z.string(),
    reason: z.enum(["missing", "not-file", "outside-run", "invalid-artifacts-dir"]),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("artifact-name"),
    name: z.string(),
    reason: z.enum(["duplicate", "undeclared"]),
  }),
]);

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

export type CompletionIssue = z.infer<typeof CompletionIssueSchema>;
export type DoneError = z.infer<typeof DoneErrorSchema>;

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
const verifyArtifacts = (
  options: Readonly<{
    runDir: string;
    stage: PlanStage | undefined;
    artifacts: readonly ArtifactRef[];
  }>,
): readonly CompletionIssue[] => {
  const { runDir, stage, artifacts } = options;
  const names = artifacts.map((artifact) => artifact.name);
  const issues: CompletionIssue[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) issues.push({ kind: "artifact-name", name, reason: "duplicate" });
    seen.add(name);
  }
  if (stage !== undefined) {
    for (const artifact of artifacts) {
      if (!stage.produces.some((produced) => produced.artifact === artifact.name)) {
        issues.push({ kind: "artifact-name", name: artifact.name, reason: "undeclared" });
      }
    }
    for (const produced of stage.produces) {
      if (!produced.optional && !seen.has(produced.artifact)) {
        issues.push({ kind: "required-artifact", name: produced.artifact });
      }
    }
  }
  const artifactsDirPath = join(runDir, "artifacts");
  const invalidArtifactsDir: CompletionIssue = {
    kind: "artifact-file",
    name: "artifacts",
    path: artifactsDirPath,
    reason: "invalid-artifacts-dir",
    message: `run artifacts/ must be a real directory inside ${runDir}`,
  };
  let artifactsDir: string;
  try {
    artifactsDir = realpathSync(artifactsDirPath);
    if (artifactsDir !== join(realpathSync(runDir), "artifacts")) {
      return [...issues, invalidArtifactsDir];
    }
  } catch {
    return [...issues, invalidArtifactsDir];
  }
  for (const artifact of artifacts) {
    const path = join(runDir, artifact.path);
    if (!existsSync(path)) {
      issues.push({
        kind: "artifact-file",
        name: artifact.name,
        path,
        reason: "missing",
        message: `artifact ${artifact.name}: ${path} does not exist`,
      });
      continue;
    }
    try {
      const actual = realpathSync(path);
      const fromArtifacts = relative(artifactsDir, actual);
      const outside =
        isAbsolute(fromArtifacts) || fromArtifacts === ".." || fromArtifacts.startsWith("../");
      if (outside || !statSync(actual).isFile()) {
        issues.push({
          kind: "artifact-file",
          name: artifact.name,
          path,
          reason: outside ? "outside-run" : "not-file",
          message: `artifact ${artifact.name}: ${path} must be a file inside artifacts/`,
        });
      }
    } catch {
      issues.push({
        kind: "artifact-file",
        name: artifact.name,
        path,
        reason: "missing",
        message: `artifact ${artifact.name}: ${path} does not exist`,
      });
    }
  }
  return issues;
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
  const runDir = runDirOf(run.cwd, run.name);
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
    const artifactIssues = verifyArtifacts({ runDir, stage: node.stage, artifacts });
    const schema = node.stage?.outputSchema ?? node.outputSchema ?? z.json();
    const parsed = schema.safeParse(outcome.output);
    const name = node.stage?.outputSchemaName ?? node.output?.zodSchema ?? "json";
    const schemaIssues: CompletionIssue[] = parsed.success
      ? []
      : parsed.error.issues.map(
          (issue): CompletionIssue => ({
            kind: "output-schema",
            schema: name,
            path: issue.path.map(String).join("."),
            message: issue.message,
          }),
        );
    const issues = [...artifactIssues, ...schemaIssues];
    if (issues.length > 0) {
      return { ok: false, error: { kind: "validation", retryable: true, nodeRunId, issues } };
    }
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
  const stored = await appendRunEventIf(
    run,
    buildStepEndEvent(step.value, record, kept),
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
    ? { ok: true, value: buildReport(step.value, record) }
    : { ok: false, error: { kind: "storage", retryable: false, message: stored.error } };
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
  );
