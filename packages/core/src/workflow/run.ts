import { resolve } from "node:path";
import { z } from "zod";
import type { JsonValue } from "../contracts.ts";
import { type EmitInput, ERROR_MESSAGE_LIMIT, type IEventEmitter } from "../events.ts";
import { walkNodes } from "./compile.ts";
import {
  evaluateBoolean,
  evaluateScalar,
  type IterationView,
  resolveValue,
  type Scope,
} from "./evaluate.ts";
import { callFunction, importModule, loadFunction, runAgent, runScript } from "./executors.ts";
import {
  type AgentAdapter,
  type AgentNode,
  type ExecNode,
  type IncludeNode,
  type InputDeclarations,
  type LoopNode,
  type NodeContext,
  NodeFailure,
  type NodeRecord,
  type RunResult,
  type SwitchNode,
  WorkflowError,
  type WorkflowFunction,
  type WorkflowNode,
  type WorkflowPlan,
} from "./types.ts";

export type RunOptions = Readonly<{
  cwd?: string;
  maxConcurrency?: number;
  signal?: AbortSignal;
  agents?: Readonly<Record<string, AgentAdapter>>;
  emitter?: IEventEmitter;
}>;

type SchemaLike = {
  safeParse: (value: unknown) => { success: boolean; error?: { message: string } };
};

type Slots = { acquire: () => Promise<() => void> };

type RunContext = Readonly<{
  cwd: string;
  signal: AbortSignal;
  abort: () => void;
  slots: Slots;
  functions: ReadonlyMap<string, WorkflowFunction>;
  schemas: ReadonlyMap<string, SchemaLike>;
  plan: WorkflowPlan;
  agents: Readonly<Record<string, AgentAdapter>>;
  events: NodeEvents;
}>;

type NodeEvents = Readonly<{
  send: (input: Omit<EmitInput, "source">) => Promise<void>;
  lostError: () => WorkflowError | undefined;
}>;

type LeafNode = ExecNode | AgentNode;

type Settled = Readonly<{ self: NodeRecord; records: Record<string, NodeRecord> }>;

const createSlots = (limit: number): Slots => {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      active -= 1;
      return;
    }
    next();
  };
  return {
    acquire: () => {
      if (active < limit) {
        active += 1;
        return Promise.resolve(release);
      }
      return new Promise((grant) => waiting.push(() => grant(release)));
    },
  };
};

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((done, reject) => {
    if (signal.aborted) return reject(new NodeFailure("aborted", "run aborted"));
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new NodeFailure("aborted", "run aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      done();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

type InputDeclaration = InputDeclarations[string];

const INPUT_TYPES: Record<InputDeclaration["type"], z.ZodType<JsonValue>> = {
  string: z.string(),
  number: z.number(),
  boolean: z.boolean(),
  object: z.record(z.string(), z.json()),
  array: z.array(z.json()),
};

const inputField = (declaration: InputDeclaration): z.ZodType<JsonValue | undefined> => {
  const base = INPUT_TYPES[declaration.type];
  if (declaration.default !== undefined) return base.prefault(declaration.default);
  return declaration.required ? base : base.optional();
};

export const resolveWorkflowInputs = (
  declarations: InputDeclarations,
  given: Readonly<Record<string, JsonValue>>,
): Record<string, JsonValue> => {
  const schema = z.strictObject(
    Object.fromEntries(
      Object.entries(declarations).map(([name, declaration]) => [name, inputField(declaration)]),
    ),
  );
  const parsed = schema.safeParse(given);
  if (parsed.success) return parsed.data as Record<string, JsonValue>;
  const [issue] = parsed.error.issues;
  const where =
    issue === undefined || issue.path.length === 0 ? "inputs" : `inputs.${issue.path.join(".")}`;
  throw new WorkflowError("input", `${where}: ${issue?.message ?? "invalid inputs"}`);
};

const functionKey = (node: ExecNode): string => `${node.module}#${node.functionName}`;

const preflightFunctions = async (
  nodes: readonly WorkflowNode[],
  cwd: string,
): Promise<ReadonlyMap<string, WorkflowFunction>> => {
  const modules = nodes.flatMap((node) =>
    node.type === "exec" && node.module !== undefined && node.functionName !== undefined
      ? [{ key: functionKey(node), module: node.module, functionName: node.functionName }]
      : [],
  );
  const loaded = await Promise.all(
    modules.map(async (m) => [m.key, await loadFunction(m.module, m.functionName, cwd)] as const),
  );
  return new Map(loaded);
};

// The stack of the error a node actually threw, not of the NodeFailure wrapping it.
const stackOf = (failure: NodeFailure): string | undefined =>
  failure.cause instanceof Error ? failure.cause.stack : failure.stack;

const toFailure = (error: unknown): NodeFailure =>
  error instanceof NodeFailure
    ? error
    : new NodeFailure(
        "exception",
        error instanceof Error ? error.message : String(error),
        undefined,
        {
          cause: error,
        },
      );

const parseJson = (stdout: string, path: string): JsonValue => {
  try {
    return JSON.parse(stdout.trim()) as JsonValue;
  } catch {
    throw new NodeFailure("validation", `${path} printed stdout that is not JSON`);
  }
};

const execute = async (
  node: LeafNode,
  input: JsonValue,
  context: NodeContext,
  ctx: RunContext,
): Promise<JsonValue> => {
  if (node.type === "agent") {
    const adapter = ctx.agents[node.adapter];
    if (adapter === undefined)
      throw new NodeFailure("exception", `${context.path}: adapter was not preflighted`);
    return runAgent(adapter, node, input, context);
  }
  if (node.runtime !== undefined && node.script !== undefined) {
    const result = await runScript({
      runtime: node.runtime,
      script: node.script,
      input,
      cwd: context.cwd,
      timeoutMs: node.timeoutMs,
      signal: context.signal,
    });
    if (result.exitCode !== 0)
      throw new NodeFailure("exit", `${context.path} exited with code ${result.exitCode}`, result);
    return node.output?.format === "json"
      ? { ...result, value: parseJson(result.stdout, context.path) }
      : result;
  }
  const fn = ctx.functions.get(functionKey(node));
  if (fn === undefined)
    throw new NodeFailure("exception", `${context.path}: function was not preflighted`);
  return callFunction(fn, input, context, node.timeoutMs);
};

const failedRecord = (
  node: WorkflowNode,
  path: string,
  startedAt: number,
  failure: NodeFailure,
  input?: JsonValue,
): NodeRecord => ({
  path,
  type: node.type,
  status: failure.kind === "aborted" ? "cancelled" : "failed",
  attempts: 1,
  startedAt,
  endedAt: Date.now(),
  error: { kind: failure.kind, message: failure.message, stack: stackOf(failure) },
  ...(input === undefined ? {} : { input }),
  ...(failure.output === undefined ? {} : { output: failure.output }),
});

const validateOutput = (
  node: LeafNode,
  output: JsonValue,
  path: string,
  ctx: RunContext,
): JsonValue => {
  const ref = node.output;
  if (ref?.module === undefined || ref.zodSchema === undefined) return output;
  const result = ctx.schemas.get(schemaKey(ref.module, ref.zodSchema))?.safeParse(output);
  if (result?.success !== true) {
    const detail = result?.error?.message ?? "";
    throw new NodeFailure(
      "validation",
      `${path} output does not match ${ref.module} schemas.${ref.zodSchema}: ${detail}`,
    );
  }
  return output;
};

const runLeaf = (
  node: LeafNode,
  input: JsonValue,
  path: string,
  startedAt: number,
  ctx: RunContext,
): Promise<NodeRecord> => {
  const maxAttempts = node.retry?.maxAttempts ?? 1;
  const attemptOnce = async (attempt: number): Promise<JsonValue> => {
    const release = await ctx.slots.acquire();
    try {
      if (ctx.signal.aborted) throw new NodeFailure("aborted", "run aborted");
      const context = { path, cwd: resolve(ctx.cwd, node.cwd ?? "."), attempt, signal: ctx.signal };
      return validateOutput(node, await execute(node, input, context, ctx), path, ctx);
    } finally {
      release();
    }
  };
  const tryFrom = async (attempt: number): Promise<NodeRecord> => {
    try {
      const output = await attemptOnce(attempt);
      return {
        path,
        type: node.type,
        status: "completed",
        input,
        output,
        attempts: attempt,
        startedAt,
        endedAt: Date.now(),
      };
    } catch (error) {
      const failure = toFailure(error);
      const final =
        attempt >= maxAttempts || failure.kind === "validation" || failure.kind === "aborted";
      if (final)
        return { ...failedRecord(node, path, startedAt, failure, input), attempts: attempt };
      await sleep(node.retry?.delayMs ?? 0, ctx.signal);
      return tryFrom(attempt + 1);
    }
  };
  return tryFrom(1);
};

const idleRecord = (
  node: WorkflowNode,
  path: string,
  status: "skipped" | "cancelled",
): NodeRecord => ({
  path,
  type: node.type,
  status,
  attempts: 0,
});

const containerRecord = (
  node: WorkflowNode,
  path: string,
  input: JsonValue,
  startedAt: number,
  views: Readonly<Record<string, NodeRecord>>,
): NodeRecord => {
  const children = Object.entries(views);
  const base = { path, type: node.type, input, attempts: 1, startedAt, endedAt: Date.now() };
  const failed = children.find(([, r]) => r.status === "failed");
  const cancelled = children.find(([, r]) => r.status === "cancelled");
  const broken = failed ?? cancelled;
  if (broken !== undefined) {
    const [id, record] = broken;
    return {
      ...base,
      status: failed === undefined ? "cancelled" : "failed",
      error: { kind: record.error?.kind ?? "aborted", message: `${path}.${id} ${record.status}` },
    };
  }
  const output = Object.fromEntries(
    children.filter(([, r]) => r.status === "completed").map(([id, r]) => [id, r.output ?? null]),
  );
  return { ...base, status: "completed", output };
};

const only = (self: NodeRecord): Settled => ({ self, records: {} });

const runSwitch = async (
  node: SwitchNode,
  input: JsonValue,
  scope: Scope,
  path: string,
  startedAt: number,
  ctx: RunContext,
): Promise<Settled> => {
  const value = evaluateScalar(node.expression, scope);
  const selected = node.cases.find((c) => c.value === value);
  const branch =
    selected ?? (node.default === undefined ? undefined : { id: "default", nodes: node.default });
  if (branch === undefined)
    return only({ ...idleRecord(node, path, "skipped"), input, startedAt, endedAt: Date.now() });
  const child = await runScope(branch.nodes, input, `${path}.${branch.id}.`, ctx);
  return {
    self: containerRecord(node, path, input, startedAt, child.views),
    records: child.records,
  };
};

const toValidation = <T>(work: () => T): T => {
  try {
    return work();
  } catch (error) {
    throw error instanceof WorkflowError
      ? new NodeFailure("validation", error.message, undefined, { cause: error })
      : error;
  }
};

const runInclude = async (
  node: IncludeNode,
  input: JsonValue,
  path: string,
  startedAt: number,
  ctx: RunContext,
): Promise<Settled> => {
  const included = ctx.plan.includes.get(node.workflow);
  if (included === undefined)
    throw new NodeFailure("exception", `${path}: include "${node.workflow}" was not compiled`);
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new NodeFailure("validation", `${path}: include input must be an object`);
  }
  const inputs = toValidation(() => resolveWorkflowInputs(included.inputs, input));
  const child = await runScope(included.nodes, inputs, `${path}.`, { ...ctx, plan: included });
  return {
    self: containerRecord(node, path, input, startedAt, child.views),
    records: child.records,
  };
};

const runLoop = (
  node: LoopNode,
  input: JsonValue,
  path: string,
  startedAt: number,
  ctx: RunContext,
): Promise<Settled> => {
  const pass = async (
    index: number,
    previous: JsonValue,
    earlier: Record<string, NodeRecord>,
  ): Promise<Settled> => {
    const child = await runScope(node.nodes, input, `${path}[${index}].`, ctx, {
      index,
      previous,
      nodes: {},
    });
    const records = { ...earlier, ...child.records };
    const self = containerRecord(node, path, input, startedAt, child.views);
    if (self.status !== "completed") return { self, records };
    try {
      const iteration = { index, previous, nodes: child.views };
      if (evaluateBoolean(node.until, { inputs: input, nodes: {}, iteration })) {
        return { self: { ...self, attempts: index }, records };
      }
    } catch (error) {
      return { self: failedRecord(node, path, startedAt, toFailure(error), input), records };
    }
    if (index >= node.maxIterations) {
      const failure = new NodeFailure(
        "exhausted",
        `${path} ran ${node.maxIterations} times and until never held`,
      );
      return {
        self: { ...failedRecord(node, path, startedAt, failure, input), attempts: index },
        records,
      };
    }
    return pass(index + 1, self.output ?? null, records);
  };
  return pass(1, null, {});
};

// send never throws: runNode's catch would turn a thrown error into one failed node, but a
// lost event must stop the whole run. So the first loss is kept, the run is aborted, later
// sends are dropped, and runWorkflow throws lostError() once every node has settled.
const guardedEmitter = (emitter: IEventEmitter | undefined, abort: () => void): NodeEvents => {
  let lost: WorkflowError | undefined;
  const send = async (input: Omit<EmitInput, "source">): Promise<void> => {
    if (emitter === undefined || lost !== undefined) return;
    const stop = (reason: string, cause?: unknown): void => {
      lost ??= new WorkflowError(
        "event-lost",
        `${input.type} for ${input.nodeRunId} was not stored: ${reason}`,
        input.nodeRunId ?? "",
        { cause },
      );
      abort();
    };
    try {
      const result = await emitter.emit({ ...input, source: "workflow" });
      if (!result.ok) stop(result.error);
    } catch (error) {
      stop(error instanceof Error ? error.message : String(error), error);
    }
  };
  return { send, lostError: () => lost };
};

const nodeStarted = (ctx: RunContext, node: WorkflowNode, path: string): Promise<void> =>
  ctx.events.send({
    type: "workflow.node.started",
    nodeId: node.id,
    nodeRunId: path,
    payload: { nodeType: node.type },
  });

const nodeEnded = (ctx: RunContext, nodeId: string, record: NodeRecord): Promise<void> =>
  ctx.events.send({
    type: `workflow.node.${record.status}`,
    nodeId,
    nodeRunId: record.path,
    payload: {
      nodeType: record.type,
      attempts: record.attempts,
      ...(record.error === undefined
        ? {}
        : {
            error: {
              kind: record.error.kind,
              message: record.error.message.slice(0, ERROR_MESSAGE_LIMIT),
              ...(record.error.stack === undefined ? {} : { stack: record.error.stack }),
            },
          }),
    },
  });

const runNode = async (
  node: WorkflowNode,
  scope: Scope,
  prefix: string,
  ctx: RunContext,
): Promise<Settled> => {
  const path = prefix + node.id;
  const startedAt = Date.now();
  try {
    if (node.type !== "switch" && node.when !== undefined && !evaluateBoolean(node.when, scope)) {
      return only(idleRecord(node, path, "skipped"));
    }
    await nodeStarted(ctx, node, path);
    const input = resolveValue(node.input, scope);
    if (node.type === "exec" || node.type === "agent") {
      return only(await runLeaf(node, input, path, startedAt, ctx));
    }
    if (node.type === "include") return await runInclude(node, input, path, startedAt, ctx);
    if (node.type === "loop") return await runLoop(node, input, path, startedAt, ctx);
    if (node.type === "wait") {
      await sleep(node.durationMs, ctx.signal);
      return only({
        path,
        type: node.type,
        status: "completed",
        input,
        output: input,
        attempts: 1,
        startedAt,
        endedAt: Date.now(),
      });
    }
    return await runSwitch(node, input, scope, path, startedAt, ctx);
  } catch (error) {
    return only(failedRecord(node, path, startedAt, toFailure(error)));
  }
};

const readiness = (
  node: WorkflowNode,
  views: Readonly<Record<string, NodeRecord>>,
  signal: AbortSignal,
): "wait" | "ready" | "skipped" | "cancelled" => {
  if (signal.aborted) return "cancelled";
  const statuses = node.dependsOn.map((dep) => views[dep]?.status);
  if (statuses.some((s) => s === undefined)) return "wait";
  if (statuses.some((s) => s === "failed" || s === "cancelled")) return "cancelled";
  if (statuses.some((s) => s === "skipped")) return "skipped";
  return "ready";
};

async function runScope(
  nodes: readonly WorkflowNode[],
  inputs: JsonValue,
  prefix: string,
  ctx: RunContext,
  iteration?: IterationView,
): Promise<{ views: Record<string, NodeRecord>; records: Record<string, NodeRecord> }> {
  const views: Record<string, NodeRecord> = Object.create(null);
  const records: Record<string, NodeRecord> = Object.create(null);
  const running = new Map<string, Promise<void>>();
  // Only `self` is emitted: nested records already had their end event in their own scope.
  const settle = async (id: string, { self, records: nested }: Settled): Promise<void> => {
    await nodeEnded(ctx, id, self);
    running.delete(id);
    views[id] = self;
    Object.assign(records, nested, { [self.path]: self });
    if (self.status === "failed") ctx.abort();
  };
  for (;;) {
    for (const node of nodes) {
      if (views[node.id] !== undefined || running.has(node.id)) continue;
      const state = readiness(node, views, ctx.signal);
      if (state === "wait") continue;
      if (state !== "ready") {
        await settle(node.id, only(idleRecord(node, prefix + node.id, state)));
        continue;
      }
      const scope =
        iteration === undefined ? { inputs, nodes: views } : { inputs, nodes: views, iteration };
      running.set(
        node.id,
        runNode(node, scope, prefix, ctx).then((s) => settle(node.id, s)),
      );
    }
    if (running.size === 0) return { views, records };
    await Promise.race(running.values());
  }
}

const isSchema = (value: unknown): value is SchemaLike =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { safeParse?: unknown }).safeParse === "function";

const schemaKey = (module: string, name: string): string => `${module}#${name}`;

const preflightSchemas = async (
  nodes: readonly WorkflowNode[],
  cwd: string,
): Promise<ReadonlyMap<string, SchemaLike>> => {
  const refs = nodes.flatMap((n) =>
    (n.type === "exec" || n.type === "agent") &&
    n.output?.module !== undefined &&
    n.output.zodSchema !== undefined
      ? [{ module: n.output.module, name: n.output.zodSchema }]
      : [],
  );
  const modules = [...new Set(refs.map((ref) => ref.module))];
  const registries = new Map(
    await Promise.all(modules.map(async (m) => [m, (await importModule(m, cwd)).schemas] as const)),
  );
  const found = refs.map(({ module, name }) => {
    const registry = registries.get(module);
    const schema =
      typeof registry === "object" && registry !== null && Object.hasOwn(registry, name)
        ? (registry as Record<string, unknown>)[name]
        : undefined;
    if (!isSchema(schema))
      throw new WorkflowError("missing-schema", `${module} has no schemas.${name}`, name);
    return [schemaKey(module, name), schema] as const;
  });
  return new Map(found);
};

const plansOf = (plan: WorkflowPlan): WorkflowPlan[] => [
  plan,
  ...[...plan.includes.values()].flatMap(plansOf),
];

const preflightAgents = (
  nodes: readonly WorkflowNode[],
  agents: Readonly<Record<string, AgentAdapter>>,
): void => {
  for (const node of nodes) {
    if (node.type === "agent" && agents[node.adapter] === undefined) {
      throw new WorkflowError(
        "missing-adapter",
        `${node.id}: no adapter "${node.adapter}"`,
        node.id,
      );
    }
  }
};

const concurrencyLimit = (plan: WorkflowPlan, requested: number | undefined): number => {
  if (!z.number().int().positive().optional().safeParse(requested).success) {
    throw new WorkflowError("input", `maxConcurrency must be a positive integer, got ${requested}`);
  }
  return Math.min(plan.maxConcurrency, requested ?? plan.maxConcurrency);
};

export const runWorkflow = async (
  plan: WorkflowPlan,
  inputs: Readonly<Record<string, JsonValue>>,
  options: RunOptions = {},
): Promise<RunResult> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const limit = concurrencyLimit(plan, options.maxConcurrency);
  const workflowInputs = resolveWorkflowInputs(plan.inputs, inputs);
  const allNodes = plansOf(plan).flatMap((p) => walkNodes(p.nodes));
  const agents = options.agents ?? {};
  preflightAgents(allNodes, agents);
  const functions = await preflightFunctions(allNodes, cwd);
  const schemas = await preflightSchemas(allNodes, cwd);
  const controller = new AbortController();
  options.signal?.addEventListener("abort", () => controller.abort(), { once: true });
  if (options.signal?.aborted) controller.abort();
  const ctx: RunContext = {
    cwd,
    signal: controller.signal,
    abort: () => controller.abort(),
    slots: createSlots(limit),
    functions,
    schemas,
    plan,
    agents,
    events: guardedEmitter(options.emitter, () => controller.abort()),
  };
  const { records } = await runScope(plan.nodes, workflowInputs, "", ctx);
  const lost = ctx.events.lostError();
  if (lost !== undefined) throw lost;
  const failed = Object.values(records).some(
    (r) => r.status === "failed" || r.status === "cancelled",
  );
  return {
    status: failed ? "failed" : "completed",
    nodes: records,
  };
};
