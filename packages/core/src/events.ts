import * as z from "zod";
import {
  type Event,
  type NodeRun,
  NonEmptyStringSchema,
  type Result,
  type State,
} from "./contracts.ts";
import type { EventDraft, IEventStore } from "./event-store.ts";
import type { EventHandler, EventHandlers } from "./state.ts";

export const ERROR_MESSAGE_LIMIT = 500;
const ErrorSchema = z.strictObject({
  kind: z.string(),
  message: z.string().max(ERROR_MESSAGE_LIMIT),
  stack: z.string().optional(),
});
const nodeType = z.string().min(1);
const attempts = z.int().nonnegative();

// Each event family adds the top-level fields its events must carry; other envelope
// fields pass through, since EventSchema checks them when the store appends.
const nodeEvent = <P extends z.ZodType>(payload: P) =>
  z.object({ nodeId: NonEmptyStringSchema, nodeRunId: NonEmptyStringSchema, payload });

export const NodeStartedEvent = nodeEvent(z.strictObject({ nodeType }));
export const NodeEndedEvent = nodeEvent(
  z.strictObject({ nodeType, attempts, error: ErrorSchema.optional() }),
);
export const NodeFailedEvent = nodeEvent(
  z.strictObject({ nodeType, attempts, error: ErrorSchema }),
);

const catalog: Readonly<Record<string, z.ZodType>> = {
  "workflow.node.started": NodeStartedEvent,
  "workflow.node.completed": NodeEndedEvent,
  "workflow.node.skipped": NodeEndedEvent,
  "workflow.node.cancelled": NodeEndedEvent,
  "workflow.node.failed": NodeFailedEvent,
};

export type EmitInput = Omit<EventDraft, "id" | "ts" | "runId"> & { readonly id?: string };

export interface IEventEmitter {
  emit(input: EmitInput): Promise<Result<Event>>;
}

const checkCatalog = (input: EmitInput): Result<EmitInput> => {
  const schema = catalog[input.type];
  if (!schema) return { ok: true, value: input };
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `${input.type}: ${z.prettifyError(parsed.error)}` };
  }
  return { ok: true, value: input };
};

export const storeEmitter = (
  store: IEventStore,
  run: { readonly runId: string },
): IEventEmitter => ({
  emit: async (input) => {
    const checked = checkCatalog(input);
    if (!checked.ok) return checked;
    const stored = await store.append({
      ...input,
      runId: run.runId,
      id: input.id ?? crypto.randomUUID(),
      ts: new Date().toISOString(),
    });
    // TODO: trigger event hooks here once hooks exist.
    return stored;
  },
});

const findOrCreateRun = (state: State, nodeId: string, nodeRunId: string): NodeRun =>
  state.nodeRuns[nodeRunId] ?? {
    nodeRunId,
    nodeId,
    index: Object.values(state.nodeRuns).filter((run) => run.nodeId === nodeId).length + 1,
    status: "running",
    startedAt: null,
    completedAt: null,
    result: null,
    artifacts: [],
  };

// activeNodeRuns follows status: a node is listed exactly while it is running.
const saveRun = (state: State, run: NodeRun): State => {
  const others = state.activeNodeRuns.filter((id) => id !== run.nodeRunId);
  return {
    ...state,
    nodeRuns: { ...state.nodeRuns, [run.nodeRunId]: run },
    activeNodeRuns: run.status === "running" ? [...others, run.nodeRunId] : others,
  };
};

const onStarted: EventHandler = (state, event) => {
  const parsed = NodeStartedEvent.safeParse(event);
  if (!parsed.success) return state;
  const run = findOrCreateRun(state, parsed.data.nodeId, parsed.data.nodeRunId);
  return saveRun(state, { ...run, status: "running", startedAt: event.ts });
};

type EndStatus = "completed" | "failed" | "skipped" | "cancelled";

const resultOf = (status: EndStatus, message: string | undefined): string | null =>
  message || (status === "skipped" ? "skipped by the workflow" : null);

const onEnded =
  (status: EndStatus): EventHandler =>
  (state, event) => {
    const parsed = NodeEndedEvent.safeParse(event);
    if (!parsed.success) return state;
    const { nodeId, nodeRunId, payload } = parsed.data;
    const run = findOrCreateRun(state, nodeId, nodeRunId);
    const result = resultOf(status, payload.error?.message);
    return saveRun(state, { ...run, status, completedAt: event.ts, result });
  };

export const coreHandlers: EventHandlers = {
  "workflow.node.started": onStarted,
  "workflow.node.completed": onEnded("completed"),
  "workflow.node.failed": onEnded("failed"),
  "workflow.node.skipped": onEnded("skipped"),
  "workflow.node.cancelled": onEnded("cancelled"),
};
