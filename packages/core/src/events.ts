import { isAbsolute, join } from "node:path";
import * as z from "zod";
import { LayoutSchema } from "./config.ts";
import {
  type Event,
  EventSchema,
  JsonObjectSchema,
  type NodeRun,
  NonEmptyStringSchema,
  type Result,
  SlugSchema,
  type State,
} from "./contracts.ts";
import type { IEventStore } from "./event-store.ts";
import type { EventHandler, EventHandlers } from "./state.ts";

export const ERROR_MESSAGE_LIMIT = 500;
export const ErrorSchema = z.strictObject({
  kind: z.string(),
  message: z.string().max(ERROR_MESSAGE_LIMIT),
  stack: z.string().optional(),
});

// The thrown error's own stack says where it broke; a wrapper's stack only says who caught it.
export const stackOf = (error: Error): string | undefined =>
  error.cause instanceof Error ? error.cause.stack : error.stack;

// Built without an undefined stack key, so the error stays a JSON value an event payload can carry.
export const eventError = (kind: string, message: string, stack: string | undefined) => {
  const error = { kind, message: message.slice(0, ERROR_MESSAGE_LIMIT) };
  return stack === undefined ? error : { ...error, stack };
};
export type EventError = ReturnType<typeof eventError>;
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

export const WorkflowStartedEvent = z.object({
  payload: z.strictObject({ workflow: SlugSchema, inputs: JsonObjectSchema }),
});

const workspaceEvent = <P extends z.ZodType>(payload: P) => z.object({ payload });

const AbsolutePathSchema = NonEmptyStringSchema.refine(isAbsolute, "Expected an absolute path");
const ShaSchema = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "Expected a full commit SHA");

const WorkspaceRepositorySchema = z.strictObject({
  name: NonEmptyStringSchema,
  worktreeDir: AbsolutePathSchema,
  checkoutDir: AbsolutePathSchema,
  baseBranch: NonEmptyStringSchema,
  startSha: ShaSchema,
});

const located = { workspaceDir: AbsolutePathSchema, branch: NonEmptyStringSchema };

const nonEmpty = (record: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(record).length > 0;

const WorkspaceCreatedPayload = z
  .strictObject({
    ...located,
    layout: LayoutSchema,
    repositories: z
      .record(SlugSchema, WorkspaceRepositorySchema)
      .refine(nonEmpty, "At least one repository is required"),
  })
  .refine(
    (payload) => payload.layout === "multi" || Object.keys(payload.repositories).length === 1,
    {
      path: ["repositories"],
      message: "Mono has one repository",
    },
  );

const RepositoryAddedPayload = z.strictObject({
  ...located,
  repoId: SlugSchema,
  repository: WorkspaceRepositorySchema,
});

const RepositoryAddFailedPayload = z.strictObject({
  ...located,
  repoId: SlugSchema,
  name: NonEmptyStringSchema,
  worktreeDir: AbsolutePathSchema,
  checkoutDir: AbsolutePathSchema,
  error: ErrorSchema,
});

const RepositoryRemovedPayload = z.strictObject({
  ...located,
  repoId: SlugSchema,
  name: NonEmptyStringSchema,
  worktreeDir: AbsolutePathSchema,
});

const RepositoryRemoveFailedPayload = RepositoryRemovedPayload.extend({
  error: ErrorSchema,
});

const WorkspaceRemovedPayload = z.strictObject({
  ...located,
  repositories: z.array(SlugSchema).min(1),
});

// A check that fails before any repo is touched records no event, so every error names its repo.
const WorkspaceFailedPayload = z.strictObject({
  ...located,
  errors: z.array(ErrorSchema.extend({ repoId: SlugSchema })).min(1),
});

export const WorkspaceCreatedEvent = workspaceEvent(WorkspaceCreatedPayload);
export const WorkspaceCreateFailedEvent = workspaceEvent(WorkspaceFailedPayload);
export const WorkspaceRepositoryAddedEvent = workspaceEvent(RepositoryAddedPayload);
export const WorkspaceRepositoryAddFailedEvent = workspaceEvent(RepositoryAddFailedPayload);
export const WorkspaceRepositoryRemovedEvent = workspaceEvent(RepositoryRemovedPayload);
export const WorkspaceRepositoryRemoveFailedEvent = workspaceEvent(RepositoryRemoveFailedPayload);
export const WorkspaceRemovedEvent = workspaceEvent(WorkspaceRemovedPayload);
export const WorkspaceRemoveFailedEvent = workspaceEvent(WorkspaceFailedPayload);

const catalog: Readonly<Record<string, z.ZodType>> = {
  "workflow.started": WorkflowStartedEvent,
  "workflow.node.started": NodeStartedEvent,
  "workflow.node.completed": NodeEndedEvent,
  "workflow.node.skipped": NodeEndedEvent,
  "workflow.node.cancelled": NodeEndedEvent,
  "workflow.node.failed": NodeFailedEvent,
  "workspace.created": WorkspaceCreatedEvent,
  "workspace.create-failed": WorkspaceCreateFailedEvent,
  "workspace.repository.added": WorkspaceRepositoryAddedEvent,
  "workspace.repository.add-failed": WorkspaceRepositoryAddFailedEvent,
  "workspace.repository.removed": WorkspaceRepositoryRemovedEvent,
  "workspace.repository.remove-failed": WorkspaceRepositoryRemoveFailedEvent,
  "workspace.removed": WorkspaceRemovedEvent,
  "workspace.remove-failed": WorkspaceRemoveFailedEvent,
};

// An event before the emitter fills runId, ts and (when not given) id. Built from the shape,
// since EventSchema's refinements rule out omit(); the store checks the whole event on append.
const { id, type, source, nodeId, nodeRunId, stage, payload } = EventSchema.shape;
export const EmitInputSchema = z.strictObject({
  type,
  payload,
  source,
  id: id.optional(),
  nodeId,
  nodeRunId,
  stage,
});
export type EmitInput = z.input<typeof EmitInputSchema>;

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

export const emitEvent = async (
  store: IEventStore,
  runId: string,
  input: EmitInput,
): Promise<Result<Event>> => {
  const checked = checkCatalog(input);
  if (!checked.ok) return checked;
  // A corrupt log or a failed write throws inside the store; callers get it as a failed Result.
  const stored = await store
    .append({ ...input, runId, id: input.id ?? crypto.randomUUID(), ts: new Date().toISOString() })
    .catch((error: unknown) => ({
      ok: false as const,
      error: `event not stored: ${error instanceof Error ? error.message : String(error)}`,
    }));
  // TODO: trigger event hooks here once hooks exist.
  return stored;
};

export const runDirOf = (cwd: string, name: string): string => join(cwd, ".harness", name);

export type RunRef = Readonly<{ id: string; cwd: string; name: string }>;

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

type WorkspaceRepository = z.infer<typeof WorkspaceRepositorySchema>;

// state.json keeps its own `path` names; only payloads use the worktreeDir naming.
const toRepositoryState = (repo: WorkspaceRepository, branch: string) => ({
  path: repo.worktreeDir,
  git: { branch, baseBranch: repo.baseBranch, startSha: repo.startSha },
});

const onWorkspaceCreated: EventHandler = (state, event) => {
  const parsed = WorkspaceCreatedEvent.safeParse(event);
  if (!parsed.success) return state;
  const { workspaceDir, branch, repositories } = parsed.data.payload;
  const entries = Object.entries(repositories).map(
    ([key, repo]) => [key, toRepositoryState(repo, branch)] as const,
  );
  return { ...state, workspace: { path: workspaceDir, repositories: Object.fromEntries(entries) } };
};

const onRepositoryAdded: EventHandler = (state, event) => {
  const parsed = WorkspaceRepositoryAddedEvent.safeParse(event);
  if (!parsed.success) return state;
  const { payload } = parsed.data;
  const repositories = {
    ...state.workspace.repositories,
    [payload.repoId]: toRepositoryState(payload.repository, payload.branch),
  };
  return { ...state, workspace: { ...state.workspace, repositories } };
};

const onRepositoryRemoved: EventHandler = (state, event) => {
  const parsed = WorkspaceRepositoryRemovedEvent.safeParse(event);
  if (!parsed.success) return state;
  const repositories = Object.fromEntries(
    Object.entries(state.workspace.repositories).filter(
      ([key]) => key !== parsed.data.payload.repoId,
    ),
  );
  return { ...state, workspace: { ...state.workspace, repositories } };
};

const onWorkflowStarted: EventHandler = (state, event) => {
  const parsed = WorkflowStartedEvent.safeParse(event);
  if (!parsed.success) return { ...state, startedAt: event.ts };
  return { ...state, startedAt: event.ts, input: parsed.data.payload.inputs };
};

export const coreHandlers: EventHandlers = {
  "workflow.started": onWorkflowStarted,
  "workflow.node.started": onStarted,
  "workflow.node.completed": onEnded("completed"),
  "workflow.node.failed": onEnded("failed"),
  "workflow.node.skipped": onEnded("skipped"),
  "workflow.node.cancelled": onEnded("cancelled"),
  "workspace.created": onWorkspaceCreated,
  "workspace.repository.added": onRepositoryAdded,
  "workspace.repository.removed": onRepositoryRemoved,
};
