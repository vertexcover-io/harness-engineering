import { randomBytes } from "node:crypto";
import {
  type EmitInput,
  eventError,
  findNodeRuns,
  type JsonValue,
  type NodeRun,
  type State,
  stackOf,
} from "@harness/sdk";
import { z } from "zod";
import { own } from "../stage.ts";
import {
  evaluateBoolean,
  evaluateScalar,
  type NodeResult,
  resolveValue,
  type Scope,
} from "./evaluate.ts";
import {
  type InputDeclarations,
  NodeFailure,
  type PlanAgentNode,
  type PlanExecNode,
  type PlanIncludeNode,
  type PlanLoopNode,
  type PlanNode,
  type PlanStage,
  type PlanSwitchNode,
  type PlanWaitNode,
  WorkflowError,
  type WorkflowPlan,
} from "./types.ts";

export type Leaf = PlanExecNode | PlanWaitNode | PlanAgentNode;

// What `next` replies. The events it recorded on the way are already saved.
export type Decision =
  | Readonly<{ kind: "leaf"; node: Leaf; nodeRunId: string; input: JsonValue }>
  | Readonly<{ kind: "waiting"; nodeRunId: string }>
  | Readonly<{ kind: "blocked"; nodeId: string; stage: string; missing: readonly string[] }>
  | Readonly<{ kind: "finished"; outcome: NonNullable<State["outcome"]> }>;

// Saves one event and gives back the state with it applied.
export type Emit = (state: State, event: EmitInput) => Promise<State>;

// What walking a node or a list of nodes decided: stop with a Decision, or go on to the next node.
type Step = Decision | Readonly<{ kind: "continue" }>;
type Walked = Readonly<{ state: State; step: Step }>;

const CONTINUE: Step = { kind: "continue" };

// Where the walk is: the inputs its expressions read and, inside a loop, the current pass.
type Walk = Readonly<{
  emit: Emit;
  inputs: JsonValue;
  loop: Readonly<{ index: number; previous: JsonValue }> | undefined;
}>;

// Top-level nodes carry no `parents`; state.json puts them at the root of its tree.
export const buildParentsField = (parents: readonly string[]) =>
  parents.length === 0 ? {} : { parents: [...parents] };

const createNodeRunId = (): string => `nr-${randomBytes(8).toString("hex")}`;

const isLeaf = (node: PlanNode): node is Leaf =>
  node.type === "exec" || node.type === "wait" || node.type === "agent";

const findNodeRun = (state: State, node: PlanNode): NodeRun | undefined =>
  own(findNodeRuns(state.nodeRuns, node.parents), node.id);

// The nodes a running container holds now: a loop's body, the included workflow, or the case
// the switch took.
const pickChildren = (node: Exclude<PlanNode, Leaf>, nodeRun: NodeRun): readonly PlanNode[] => {
  if (node.type === "loop") return node.nodes;
  if (node.type === "include") return node.plan.nodes;
  if (nodeRun.branch === "default") return node.default ?? [];
  return node.cases.find((c) => c.id === nodeRun.branch)?.nodes ?? [];
};

const INPUT_TYPES: Record<InputDeclarations[string]["type"], z.ZodType<JsonValue>> = {
  string: z.string(),
  number: z.number(),
  boolean: z.boolean(),
  object: z.record(z.string(), z.json()),
  array: z.array(z.json()),
};

// The workflow's inputs with their defaults filled in; an input that breaks its declaration throws.
const resolveWorkflowInputs = (
  declarations: InputDeclarations,
  given: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> => {
  const fields = Object.entries(declarations).map(([name, declaration]) => {
    const base = INPUT_TYPES[declaration.type];
    if (declaration.default !== undefined) return [name, base.prefault(declaration.default)];
    return [name, declaration.required ? base : base.optional()];
  });
  const parsed = z.strictObject(Object.fromEntries(fields)).safeParse(given);
  if (parsed.success) return parsed.data as Record<string, JsonValue>;
  const [issue] = parsed.error.issues;
  const where =
    issue === undefined || issue.path.length === 0 ? "inputs" : `inputs.${issue.path.join(".")}`;
  throw new WorkflowError("input", `${where}: ${issue?.message ?? "invalid inputs"}`);
};

// An include's input with the included workflow's defaults filled in, or why it does not fit.
const resolveIncludeInputs = (
  node: PlanIncludeNode,
  input: JsonValue,
): Record<string, JsonValue> | NodeFailure => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return new NodeFailure("validation", `${node.id}: include input must be an object`);
  }
  try {
    return resolveWorkflowInputs(node.plan.inputs, input);
  } catch (error) {
    if (!(error instanceof WorkflowError)) throw error;
    return new NodeFailure("validation", error.message, undefined, { cause: error });
  }
};

// The case a switch takes: the one whose value matches, by type too, else "default" when it has
// one; undefined when none fits, or why the expression cannot be worked out.
const pickBranch = (node: PlanSwitchNode, scope: Scope): string | undefined | NodeFailure => {
  try {
    const value = evaluateScalar(node.expression, scope);
    const matched = node.cases.find((c) => c.value === value)?.id;
    return matched ?? (node.default === undefined ? undefined : "default");
  } catch (error) {
    if (!(error instanceof NodeFailure)) throw error;
    return error;
  }
};

// A container's output: each child that completed, by id.
const collectOutputs = (results: Readonly<Record<string, NodeResult>>): JsonValue =>
  Object.fromEntries(
    Object.entries(results)
      .filter(([, view]) => view.status === "completed")
      .map(([id, view]) => [id, view.output ?? null]),
  );

// The artifacts a stage needs, did not mark optional, and no completed node has listed yet.
const findMissingArtifacts = (stage: PlanStage, state: State): readonly string[] => {
  const listed = (runs: Readonly<Record<string, NodeRun>>): readonly string[] =>
    Object.values(runs).flatMap((run) => [
      ...(run.status === "completed" ? run.artifacts.map((ref) => ref.name) : []),
      ...listed(run.nodes ?? {}),
    ]);
  const written = new Set(listed(state.nodeRuns));
  return stage.consumes
    .filter((consumed) => !consumed.optional && !written.has(consumed.artifact))
    .map((consumed) => consumed.artifact);
};

// An unstarted node either ends before it starts (skipped, or failed with `failure`) or starts.
type Start =
  | Readonly<{ kind: "end"; failure?: NodeFailure }>
  | Readonly<{ kind: "start"; input: JsonValue; scope: Scope }>;

// Whether an unstarted node runs: skipped when a dependency was skipped or its `when` is false,
// failed when its input cannot be worked out. Nodes are walked in dependency order, so its
// dependencies have ended.
const decideStart = (node: PlanNode, walk: Walk, state: State): Start => {
  const results = findNodeRuns(state.nodeRuns, node.parents);
  if (node.dependsOn.some((id) => results[id]?.status === "skipped")) return { kind: "end" };
  const scope: Scope = {
    inputs: walk.inputs,
    nodes: results,
    ...(walk.loop === undefined ? {} : { iteration: { ...walk.loop, nodes: {} } }),
  };
  try {
    if (node.type !== "switch" && node.when !== undefined && !evaluateBoolean(node.when, scope)) {
      return { kind: "end" };
    }
    return { kind: "start", input: resolveValue(node.input, scope), scope };
  } catch (error) {
    if (error instanceof NodeFailure) return { kind: "end", failure: error };
    throw error;
  }
};

const toEventError = (failure: NodeFailure) =>
  eventError(failure.kind, failure.message, stackOf(failure));

const emitNodeEvent = (
  walk: Walk,
  state: State,
  node: PlanNode,
  event: Readonly<{
    type: string;
    nodeRunId: string;
    payload: Readonly<Record<string, JsonValue>>;
  }>,
): Promise<State> =>
  walk.emit(state, {
    type: `workflow.node.${event.type}`,
    source: "workflow",
    nodeId: node.id,
    nodeRunId: event.nodeRunId,
    payload: { nodeType: node.type, ...buildParentsField(node.parents), ...event.payload },
  });

// Records a node that ends before it starts: skipped, or failed with the error that stopped it.
const recordSkipOrFail = async (
  node: PlanNode,
  failure: NodeFailure | undefined,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  const nodeRunId = createNodeRunId();
  const event =
    failure === undefined
      ? { type: "skipped", nodeRunId, payload: { attempts: 0 } }
      : { type: "failed", nodeRunId, payload: { attempts: 0, error: toEventError(failure) } };
  return { state: await emitNodeEvent(walk, state, node, event), step: CONTINUE };
};

// Records that a node started, and gives back the state with its new node run.
const recordStart = async (
  node: PlanNode,
  payload: Readonly<Record<string, JsonValue>>,
  walk: Walk,
  state: State,
): Promise<Readonly<{ state: State; nodeRun: NodeRun }>> => {
  const nodeRunId = createNodeRunId();
  const started = await emitNodeEvent(walk, state, node, { type: "started", nodeRunId, payload });
  const nodeRun = findNodeRun(started, node);
  if (nodeRun === undefined) throw new Error(`${node.id}: no node run after it started`);
  return { state: started, nodeRun };
};

// Ends a container: failed with `failure` or, without one, with its first failed child;
// otherwise completed with its children's outputs.
const endContainer = async (
  node: PlanNode,
  nodeRun: NodeRun,
  walk: Walk,
  state: State,
  ending: Readonly<{ attempts: number; failure?: NodeFailure }> = { attempts: 1 },
): Promise<Walked> => {
  const results = findNodeRuns(state.nodeRuns, [...node.parents, node.id]);
  const failedChild = Object.keys(results).find((id) => results[id]?.status === "failed");
  const failure =
    ending.failure ??
    (failedChild === undefined
      ? undefined
      : new NodeFailure("exception", `${node.id}.${failedChild} failed`));
  const payload =
    failure === undefined
      ? { attempts: ending.attempts, output: collectOutputs(results) }
      : { attempts: ending.attempts, error: toEventError(failure) };
  const type = failure === undefined ? "completed" : "failed";
  const event = { type, nodeRunId: nodeRun.nodeRunId, payload };
  return { state: await emitNodeEvent(walk, state, node, event), step: CONTINUE };
};

// An exec, wait or agent node: handed to the skill once it can start, then waited on.
const executeLeaf = async (
  node: Leaf,
  nodeRun: NodeRun | undefined,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  if (nodeRun?.status === "running") {
    return { state, step: { kind: "waiting", nodeRunId: nodeRun.nodeRunId } };
  }
  const start = decideStart(node, walk, state);
  if (start.kind === "end") return recordSkipOrFail(node, start.failure, walk, state);
  if (node.type === "agent" && node.stage !== undefined) {
    const missing = findMissingArtifacts(node.stage, state);
    if (missing.length > 0) {
      return { state, step: { kind: "blocked", nodeId: node.id, stage: node.stage.ref, missing } };
    }
  }
  const { input } = start;
  const started = await recordStart(node, { input }, walk, state);
  const { nodeRunId } = started.nodeRun;
  return { state: started.state, step: { kind: "leaf", node, nodeRunId, input } };
};

// A switch: starts on the case whose value matches (or its default), walks that case's nodes,
// then ends. No matching case skips it.
const executeSwitch = async (
  node: PlanSwitchNode,
  nodeRun: NodeRun | undefined,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  if (nodeRun === undefined) {
    const start = decideStart(node, walk, state);
    if (start.kind === "end") return recordSkipOrFail(node, start.failure, walk, state);
    const branch = pickBranch(node, start.scope);
    if (branch === undefined || branch instanceof NodeFailure) {
      return recordSkipOrFail(node, branch, walk, state);
    }
    const started = await recordStart(node, { input: start.input, branch }, walk, state);
    return executeSwitch(node, started.nodeRun, walk, started.state);
  }
  const inside: Walk = { ...walk, inputs: nodeRun.input ?? null, loop: undefined };
  const walked = await executeNodes(pickChildren(node, nodeRun), inside, state);
  if (walked.step.kind !== "continue") return walked;
  return endContainer(node, nodeRun, walk, walked.state);
};

// An include: starts once its input fits the included workflow's inputs, walks that workflow's
// nodes, then ends.
const executeInclude = async (
  node: PlanIncludeNode,
  nodeRun: NodeRun | undefined,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  if (nodeRun === undefined) {
    const start = decideStart(node, walk, state);
    if (start.kind === "end") return recordSkipOrFail(node, start.failure, walk, state);
    // Recorded with its defaults filled in, so the included nodes read it as their inputs.
    const input = resolveIncludeInputs(node, start.input);
    if (input instanceof NodeFailure) return recordSkipOrFail(node, input, walk, state);
    const started = await recordStart(node, { input }, walk, state);
    return executeInclude(node, started.nodeRun, walk, started.state);
  }
  const inside: Walk = { ...walk, inputs: nodeRun.input ?? null, loop: undefined };
  const walked = await executeNodes(node.plan.nodes, inside, state);
  if (walked.step.kind !== "continue") return walked;
  return endContainer(node, nodeRun, walk, walked.state);
};

// A loop's node run holds only its current pass: `iteration` numbers it, and `output` is the result
// of the pass before it, which the pass reads as `iteration.previous`. Once a pass ends, until
// decides: stop, fail, or record the next pass (which clears the children) and walk it.
const executeLoop = async (
  node: PlanLoopNode,
  nodeRun: NodeRun | undefined,
  walk: Walk,
  state: State,
): Promise<Walked> => {
  if (nodeRun === undefined) {
    const start = decideStart(node, walk, state);
    if (start.kind === "end") return recordSkipOrFail(node, start.failure, walk, state);
    const started = await recordStart(node, { input: start.input }, walk, state);
    return executeLoop(node, started.nodeRun, walk, started.state);
  }
  const index = nodeRun.iteration ?? 1;
  const previous = nodeRun.output ?? null;
  const inside: Walk = { ...walk, inputs: nodeRun.input ?? null, loop: { index, previous } };
  const walked = await executeNodes(node.nodes, inside, state);
  if (walked.step.kind !== "continue") return walked;
  const results = findNodeRuns(walked.state.nodeRuns, [...node.parents, node.id]);
  const ending = { attempts: index };
  if (Object.values(results).some((result) => result.status === "failed")) {
    return endContainer(node, nodeRun, walk, walked.state, ending);
  }
  try {
    const iteration = { index, previous, nodes: results };
    if (evaluateBoolean(node.until, { inputs: inside.inputs, nodes: {}, iteration })) {
      return endContainer(node, nodeRun, walk, walked.state, ending);
    }
  } catch (error) {
    if (!(error instanceof NodeFailure)) throw error;
    return endContainer(node, nodeRun, walk, walked.state, { ...ending, failure: error });
  }
  if (index >= node.maxIterations) {
    const message = `${node.id} ran ${node.maxIterations} times and until never held`;
    const failure = new NodeFailure("exhausted", message);
    return endContainer(node, nodeRun, walk, walked.state, { ...ending, failure });
  }
  const output = collectOutputs(results);
  const event = {
    type: "iterated",
    nodeRunId: nodeRun.nodeRunId,
    payload: { iteration: index + 1, output },
  };
  const next = await emitNodeEvent(walk, walked.state, node, event);
  return executeLoop(node, findNodeRun(next, node), walk, next);
};

// Walks nodes in dependency order until one needs the skill. Once a node in this scope has
// failed nothing more starts: the container around it sees the failure and ends failed.
async function executeNodes(nodes: readonly PlanNode[], walk: Walk, state: State): Promise<Walked> {
  let current = state;
  for (const node of nodes) {
    const nodeRuns = Object.values(findNodeRuns(current.nodeRuns, node.parents));
    if (nodeRuns.some((run) => run.status === "failed")) break;
    const nodeRun = findNodeRun(current, node);
    if (nodeRun !== undefined && nodeRun.status !== "running") continue;
    let walked: Walked;
    switch (node.type) {
      case "switch":
        walked = await executeSwitch(node, nodeRun, walk, current);
        break;
      case "include":
        walked = await executeInclude(node, nodeRun, walk, current);
        break;
      case "loop":
        walked = await executeLoop(node, nodeRun, walk, current);
        break;
      default:
        walked = await executeLeaf(node, nodeRun, walk, current);
    }
    if (walked.step.kind !== "continue") return walked;
    current = walked.state;
  }
  return { state: current, step: CONTINUE };
}

// One `next`: walks the workflow from the top, recording the engine's own events as it goes,
// until a node needs the skill or nothing is left, which ends the run.
export const decideNext = async (
  plan: WorkflowPlan,
  state: State,
  emit: Emit,
): Promise<Readonly<{ state: State; decision: Decision }>> => {
  if (state.outcome !== null) {
    return { state, decision: { kind: "finished", outcome: state.outcome } };
  }
  const inputs = resolveWorkflowInputs(plan.inputs, state.input);
  const walked = await executeNodes(plan.nodes, { emit, inputs, loop: undefined }, state);
  if (walked.step.kind !== "continue") return { state: walked.state, decision: walked.step };
  const outcome = Object.values(walked.state.nodeRuns).some((run) => run.status === "failed")
    ? "failed"
    : "completed";
  const event = { type: `workflow.${outcome}`, source: "workflow", payload: {} };
  return { state: await emit(walked.state, event), decision: { kind: "finished", outcome } };
};

// A running leaf and its node run in state.json.
export type RunningLeaf = Readonly<{ node: Leaf; nodeRun: NodeRun }>;

// The running leaf whose run is `nodeRunId`, for exec and done.
export const findRunningLeaf = (
  nodes: readonly PlanNode[],
  nodeRuns: Readonly<Record<string, NodeRun>>,
  nodeRunId: string,
): RunningLeaf | undefined => {
  for (const node of nodes) {
    const nodeRun = own(nodeRuns, node.id);
    if (nodeRun?.status !== "running") continue;
    if (isLeaf(node)) {
      if (nodeRun.nodeRunId === nodeRunId) return { node, nodeRun };
      continue;
    }
    const found = findRunningLeaf(pickChildren(node, nodeRun), nodeRun.nodes ?? {}, nodeRunId);
    if (found !== undefined) return found;
  }
  return undefined;
};
