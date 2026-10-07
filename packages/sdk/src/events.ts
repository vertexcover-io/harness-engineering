import { join } from "node:path";
import * as z from "zod";
import { AgentTypeSchema } from "./agent.ts";
import {
  AbsolutePathSchema,
  ArtifactRefSchema,
  ERROR_MESSAGE_LIMIT,
  ErrorSchema,
  type Event,
  EventSchema,
  EventTypeSchema,
  JsonObjectSchema,
  type JsonValue,
  LayoutSchema,
  type NodeRun,
  NodeTypeSchema,
  NonEmptyStringSchema,
  pickTierModel,
  type ResolvedTiers,
  type Result,
  SessionRefSchema,
  SkipOutputSchema,
  SlugSchema,
  type State,
  type TierModel,
  TierModelSchema,
} from "./contracts.ts";
import type { IEventStore } from "./event-store.ts";
import type { EventHandler, EventHandlers } from "./state.ts";
import { VerifierRunSchema } from "./verifier.ts";

// The thrown error's own stack says where it broke; a wrapper's stack only says who caught it.
export const stackOf = (error: Error): string | undefined =>
  error.cause instanceof Error ? error.cause.stack : error.stack;

// Built without an undefined stack key, so the error stays a JSON value an event payload can carry.
export const eventError = (kind: string, message: string, stack: string | undefined) => {
  const error = { kind, message: message.slice(0, ERROR_MESSAGE_LIMIT) };
  return stack === undefined ? error : { ...error, stack };
};
export type EventError = ReturnType<typeof eventError>;
const attempts = z.int().nonnegative();
// The ids of the loops, switches and includes a node sits inside, outermost first. Top-level nodes
// leave it out. State is a tree keyed by node ids, so this says where in the tree the node goes.
const placement = { parents: z.array(NonEmptyStringSchema).min(1).optional() };

// Each event family adds the top-level fields its events must carry; other envelope
// fields pass through, since EventSchema checks them when the store appends.
const nodeEvent = <P extends z.ZodType>(payload: P) =>
  z.object({ nodeId: NonEmptyStringSchema, nodeRunId: NonEmptyStringSchema, payload });

export const NodeStartedEvent = nodeEvent(
  z.strictObject({
    nodeType: NodeTypeSchema,
    input: z.json().optional(),
    branch: NonEmptyStringSchema.optional(),
    ...placement,
  }),
);
// A script's process record stays in the event log; state.json keeps only the node's output value.
export const ProcessRecordSchema = z.strictObject({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.int(),
});
export type ProcessRecord = z.infer<typeof ProcessRecordSchema>;

const endFields = { nodeType: NodeTypeSchema, attempts, ...placement };

// Keyed by how the node ended; each payload refuses the fields another ending carries.
const nodeEndedEvents = {
  completed: nodeEvent(
    z.strictObject({
      ...endFields,
      output: z.json().optional(),
      process: ProcessRecordSchema.optional(),
      artifacts: z.array(ArtifactRefSchema).optional(),
    }),
  ),
  failed: nodeEvent(
    z.strictObject({ ...endFields, error: ErrorSchema, process: ProcessRecordSchema.optional() }),
  ),
  skipped: nodeEvent(z.strictObject({ ...endFields, skip: SkipOutputSchema })),
  cancelled: nodeEvent(z.strictObject({ ...endFields, error: ErrorSchema.optional() })),
};

// A loop starting its next pass: the pass number, and the result of the pass that just ended.
export const NodeIteratedEvent = nodeEvent(
  z.strictObject({
    nodeType: NodeTypeSchema,
    iteration: z.int().min(2),
    output: z.json(),
    ...placement,
  }),
);

export const WorkflowStartedEvent = z.object({
  payload: z.strictObject({
    workflow: SlugSchema,
    inputs: JsonObjectSchema,
    activeSessions: z.array(SessionRefSchema).optional(),
  }),
});

export const WorkflowEndedEvent = z.object({ payload: z.strictObject({}) });

// Why the Stop hook answered as it did. node-not-done and next-not-run send the agent back to
// work; the rest let the turn end.
export const StopReasonSchema = z.enum([
  "run-finished",
  "user-chat",
  "max-blocks-reached",
  "node-not-done",
  "next-not-run",
  "context-node",
  "model-switch",
]);
export type StopReason = z.infer<typeof StopReasonSchema>;

// nodeRunId rides in the payload: the envelope's nodeRunId needs a nodeId beside it.
export const StopCalledEvent = z.object({
  payload: z.strictObject({
    agent: AgentTypeSchema,
    sessionId: NonEmptyStringSchema,
    // null when the hook did not need the transcript, or could not read it
    touchedRun: z.boolean().nullable(),
    decision: z.enum(["allow", "continue"]),
    reason: StopReasonSchema,
    blockStreak: z.int().nonnegative(),
    // the text the agent was sent back with
    message: z.string().optional(),
    nodeRunId: NonEmptyStringSchema.optional(),
  }),
});

export const SessionStartCalledEvent = z.object({
  payload: z.strictObject({
    agent: AgentTypeSchema,
    sessionId: NonEmptyStringSchema,
    // why the session started: startup, clear, compact or resume
    source: NonEmptyStringSchema,
  }),
});

export const PreToolUseCalledEvent = z.object({
  payload: z.strictObject({
    agent: AgentTypeSchema,
    sessionId: NonEmptyStringSchema,
    // the agent's own name for the tool, e.g. Bash or Write
    tool: NonEmptyStringSchema,
    // the registered handler that answered, e.g. record-guard or bash-antipatterns
    handler: NonEmptyStringSchema,
    decision: z.enum(["allow", "deny"]),
    // the text the agent was refused with
    message: z.string().optional(),
    path: z.string().optional(),
  }),
});

// The helper began a context node's action: for `new`, the session id it is starting; for
// `compact`, the session it is compacting. The SessionStart hook matches against it.
export const ContextStartedEvent = z.object({
  payload: z.strictObject({
    nodeRunId: NonEmptyStringSchema,
    action: z.enum(["new", "compact"]),
    sessionId: NonEmptyStringSchema,
  }),
});

// A context node's new session took over from the old one, so it replaces it in activeSessions.
export const SessionReplacedEvent = z.object({
  payload: z.strictObject({
    agent: AgentTypeSchema,
    previousSessionId: NonEmptyStringSchema,
    sessionId: NonEmptyStringSchema,
  }),
});

// next asks for the model a stage's tier maps to; node is the stage's path (nodePath).
const ModelRequestSchema = TierModelSchema.extend({ node: NonEmptyStringSchema });
export const ModelRequestedEvent = z.object({ payload: ModelRequestSchema });

// The helper switched the session to the model of request requestSeq, or says why it could not.
const ModelAnswerSchema = ModelRequestSchema.extend({ requestSeq: z.int().positive() });
export const ModelAppliedEvent = z.object({
  payload: z.discriminatedUnion("applied", [
    ModelAnswerSchema.extend({ applied: z.literal(true) }),
    ModelAnswerSchema.extend({ applied: z.literal(false), reason: NonEmptyStringSchema }),
  ]),
});

// The agent hit its plan's usage limit; message is its error text, which may name the reset time.
export const LimitReachedEvent = z.object({
  payload: z.strictObject({
    agent: AgentTypeSchema,
    sessionId: NonEmptyStringSchema,
    error: NonEmptyStringSchema,
    message: z.string().optional(),
  }),
});

// from: where the reset time was read.
export const LimitWaitingEvent = z.object({
  payload: z.strictObject({
    sessionId: NonEmptyStringSchema,
    limitEventId: NonEmptyStringSchema,
    resumeAt: z.iso.datetime(),
    from: z.enum(["message", "screen", "fallback"]),
  }),
});

export const LimitResumedEvent = z.object({
  payload: z.strictObject({ sessionId: NonEmptyStringSchema, limitEventId: NonEmptyStringSchema }),
});

// One call of one subscriber for one stored event.
export const SubscriberCalledEvent = z.object({
  payload: z.strictObject({
    subscriber: SlugSchema,
    eventId: NonEmptyStringSchema,
    eventSeq: z.int().positive(),
    eventType: EventTypeSchema,
    blocking: z.boolean(),
    status: z.enum(["ok", "failed"]),
    durationMs: z.int().nonnegative(),
    output: z.json().optional(),
    error: ErrorSchema.optional(),
  }),
});

export const AskedQuestionSchema = z.strictObject({
  question: NonEmptyStringSchema,
  header: z.string().optional(),
  options: z.array(z.string()),
});
export type AskedQuestion = z.infer<typeof AskedQuestionSchema>;

const questionCall = {
  agent: AgentTypeSchema,
  sessionId: NonEmptyStringSchema,
  // Claude's id for the AskUserQuestion call; links an answer to its question
  toolUseId: NonEmptyStringSchema.optional(),
};

// The agent asked the person something and is waiting for the answer.
export const QuestionAskedEvent = z.object({
  payload: z.strictObject({ ...questionCall, questions: z.array(AskedQuestionSchema).min(1) }),
});

export const AnsweredQuestionSchema = z.strictObject({
  question: NonEmptyStringSchema,
  answer: z.string(),
  notes: z.string().optional(),
});
export type AnsweredQuestion = z.infer<typeof AnsweredQuestionSchema>;

// The person answered the agent's questions.
export const QuestionAnsweredEvent = z.object({
  payload: z.strictObject({ ...questionCall, answers: z.array(AnsweredQuestionSchema).min(1) }),
});

// A turn an API error ended that waiting will not clear, such as authentication or billing.
export const AgentStoppedEvent = z.object({ payload: LimitReachedEvent.shape.payload });

// The Stop hook let the agent's turn end after sending it back too many times in a row.
export const AgentStuckEvent = z.object({
  payload: z.strictObject({
    agent: AgentTypeSchema,
    sessionId: NonEmptyStringSchema,
    message: z.string().optional(),
  }),
});

// next found a stage it cannot hand out until the artifacts it consumes exist.
export const WorkflowBlockedEvent = z.object({
  payload: z.strictObject({
    nodeId: NonEmptyStringSchema,
    stage: NonEmptyStringSchema,
    missing: z.array(NonEmptyStringSchema).min(1),
  }),
});

// The notifier opened the run's conversation; its later posts reply in this thread.
export const NotificationThreadStartedEvent = z.object({
  payload: z.strictObject({ provider: NonEmptyStringSchema, threadId: NonEmptyStringSchema }),
});

// Values a subscriber or skill keeps between calls. Each top-level key replaces the one in state.custom,
// so a writer keeps its values under its own key.
export const CustomStateUpdatedEvent = z.object({ payload: JsonObjectSchema });

// One id per event and subscriber, so a call is recorded at most once.
export const buildSubscriberCallId = (eventId: string, subscriber: string): string =>
  `subscriber:${eventId}:${subscriber}`;

const workspaceEvent = <P extends z.ZodType>(payload: P) => z.object({ payload });

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

// What orchestrate exec and done print.
const StepReportSchema = z.strictObject({
  nodeRunId: NonEmptyStringSchema,
  nodeId: NonEmptyStringSchema,
  status: z.enum(["completed", "failed"]),
  attempts,
  error: z.strictObject({ kind: z.string(), message: z.string() }).optional(),
});
export type StepReport = z.infer<typeof StepReportSchema>;

// A call of orchestrate next, exec or done: what it was called with, and the reply it printed, or
// the error it failed with. Nothing reads these into state.json.
const callEvent = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O) =>
  z.object({ payload: z.strictObject({ input, output }) });
const reportOrError = z.union([StepReportSchema, ErrorSchema.extend({ kind: z.literal("error") })]);

const OrchestrateNextEvent = callEvent(z.strictObject({}), z.json());
const OrchestrateExecEvent = callEvent(
  z.strictObject({ nodeRunId: NonEmptyStringSchema }),
  reportOrError,
);
const OutputOutcomeSchema = z.strictObject({ output: z.string() });
const ErrorOutcomeSchema = z.strictObject({ error: z.string() });
const StepOutcomeSchema = z.union([OutputOutcomeSchema, ErrorOutcomeSchema]);
export type StepOutcome = z.infer<typeof StepOutcomeSchema>;

const doneInput = { nodeRunId: NonEmptyStringSchema, artifacts: z.array(ArtifactRefSchema) };
// What a done call did to its node: completed or failed it, rejected it and left it open for
// another try, or broke before it could do either.
export const DoneStatusSchema = z.enum(["completed", "failed", "rejected", "error"]);
export type DoneStatus = z.infer<typeof DoneStatusSchema>;
const OrchestrateDoneEvent = z.object({
  payload: z.strictObject({
    input: z.union([OutputOutcomeSchema.extend(doneInput), ErrorOutcomeSchema.extend(doneInput)]),
    output: reportOrError,
    status: DoneStatusSchema,
  }),
});

const OrchestrateVerifierEvent = z.object({ payload: VerifierRunSchema });

// Where a comment points: the quote with the words around it, plus the Markdown source lines and
// section, or the element path inside an HTML artifact.
export const AnchorSchema = z.strictObject({
  quote: NonEmptyStringSchema,
  before: z.string(),
  after: z.string(),
  lines: z.tuple([z.int().positive(), z.int().positive()]).optional(),
  heading: z.string().optional(),
  selector: z.string().optional(),
});
export type Anchor = z.infer<typeof AnchorSchema>;

export const CommentStatusSchema = z.enum(["sent", "delivered", "answered", "changed", "declined"]);
export const AgentStatusSchema = CommentStatusSchema.extract(["answered", "changed", "declined"]);

export const CommentFieldsSchema = z.strictObject({
  // relative to the run folder (.yok/NAME), always under artifacts/: "artifacts/design.md"
  file: NonEmptyStringSchema,
  kind: z.enum(["comment", "delete", "replace", "global"]),
  text: z.string(),
  anchor: AnchorSchema.optional(),
});

export const CommentDraftSchema = CommentFieldsSchema.refine(
  (c) => c.kind === "global" || c.anchor !== undefined,
  "a comment on part of a file needs an anchor",
).refine((c) => c.kind === "delete" || c.text.trim() !== "", "the comment has no text");
export type CommentDraft = z.infer<typeof CommentDraftSchema>;

const CommentAddedEvent = z.object({
  payload: z.strictObject({
    comments: z.array(CommentFieldsSchema.extend({ id: NonEmptyStringSchema })).min(1),
  }),
});
const CommentDeliveredEvent = z.object({
  payload: z.strictObject({ ids: z.array(NonEmptyStringSchema).min(1) }),
});
const CommentRepliedEvent = z.object({
  payload: CommentFieldsSchema.omit({ kind: true, text: true }).extend({
    id: NonEmptyStringSchema,
    by: z.enum(["user", "agent"]),
    status: CommentStatusSchema.exclude(["delivered"]),
    text: NonEmptyStringSchema,
  }),
});

const catalog: Readonly<Record<string, z.ZodType>> = {
  "workflow.started": WorkflowStartedEvent,
  "workflow.completed": WorkflowEndedEvent,
  "workflow.failed": WorkflowEndedEvent,
  "workflow.node.started": NodeStartedEvent,
  "workflow.node.completed": nodeEndedEvents.completed,
  "workflow.node.skipped": nodeEndedEvents.skipped,
  "workflow.node.cancelled": nodeEndedEvents.cancelled,
  "workflow.node.failed": nodeEndedEvents.failed,
  "workflow.node.iterated": NodeIteratedEvent,
  "workflow.session.replaced": SessionReplacedEvent,
  "workflow.context.started": ContextStartedEvent,
  "workflow.blocked": WorkflowBlockedEvent,
  "workflow.model.requested": ModelRequestedEvent,
  "workflow.model.applied": ModelAppliedEvent,
  "workspace.created": WorkspaceCreatedEvent,
  "workspace.create-failed": WorkspaceCreateFailedEvent,
  "workspace.repository.added": WorkspaceRepositoryAddedEvent,
  "workspace.repository.add-failed": WorkspaceRepositoryAddFailedEvent,
  "workspace.repository.removed": WorkspaceRepositoryRemovedEvent,
  "workspace.repository.remove-failed": WorkspaceRepositoryRemoveFailedEvent,
  "workspace.removed": WorkspaceRemovedEvent,
  "workspace.remove-failed": WorkspaceRemoveFailedEvent,
  "orchestrate.next": OrchestrateNextEvent,
  "orchestrate.exec": OrchestrateExecEvent,
  "orchestrate.done": OrchestrateDoneEvent,
  "orchestrate.verifier": OrchestrateVerifierEvent,
  "hooks.stop.called": StopCalledEvent,
  "hooks.pre-tool-use.called": PreToolUseCalledEvent,
  "hooks.session-start.called": SessionStartCalledEvent,
  "agent.limit.reached": LimitReachedEvent,
  "agent.limit.waiting": LimitWaitingEvent,
  "agent.limit.resumed": LimitResumedEvent,
  "agent.question.asked": QuestionAskedEvent,
  "agent.question.answered": QuestionAnsweredEvent,
  "agent.stopped": AgentStoppedEvent,
  "agent.stuck": AgentStuckEvent,
  "subscriber.called": SubscriberCalledEvent,
  "notification.thread.started": NotificationThreadStartedEvent,
  "custom.state.updated": CustomStateUpdatedEvent,
  "artifact.comment.added": CommentAddedEvent,
  "artifact.comment.delivered": CommentDeliveredEvent,
  "artifact.comment.replied": CommentRepliedEvent,
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
  return stored;
};

export const runDirOf = (cwd: string, name: string): string => join(cwd, ".yok", name);

export type RunRef = Readonly<{ id: string; cwd: string; name: string }>;

type Nodes = Readonly<Record<string, NodeRun>>;

// A node's path in the workflow: the containers above it, then its own id.
export const nodePath = (parents: readonly string[], id: string): string =>
  [...parents, id].join(".");

// Where the run's model switches stand, folded from its events in order.
export type ModelSwitch = Readonly<{
  // the model the session is on: its launch model until a switch is applied
  current: TierModel | null;
  // the request no helper has answered yet; seq is its event's
  pending: (z.infer<typeof ModelRequestSchema> & Readonly<{ seq: number }>) | null;
  // a switch that failed; it stands until next fails the stage at that node
  failed: Readonly<{ node: string; reason: string }> | null;
}>;

const stepModelSwitch = (progress: ModelSwitch, event: Event): ModelSwitch => {
  switch (event.type) {
    case "workflow.model.requested": {
      const parsed = ModelRequestedEvent.safeParse(event);
      if (!parsed.success) return progress;
      return { ...progress, pending: { ...parsed.data.payload, seq: event.seq } };
    }
    case "workflow.model.applied": {
      const parsed = ModelAppliedEvent.safeParse(event);
      // an answer to an earlier request than the open one is stale
      if (!parsed.success || parsed.data.payload.requestSeq !== progress.pending?.seq) {
        return progress;
      }
      const { payload } = parsed.data;
      if (payload.applied) return { ...progress, current: pickTierModel(payload), pending: null };
      return { ...progress, pending: null, failed: { node: payload.node, reason: payload.reason } };
    }
    case "workflow.node.failed": {
      const parsed = nodeEndedEvents.failed.safeParse(event);
      if (!parsed.success) return progress;
      const { nodeId, payload } = parsed.data;
      const path = nodePath(payload.parents ?? [], nodeId);
      return path === progress.failed?.node ? { ...progress, failed: null } : progress;
    }
    default:
      return progress;
  }
};

// The session starts on the default tier's model.
export const foldModelSwitch = (
  events: readonly Event[],
  tiers: ResolvedTiers | null,
): ModelSwitch => {
  const current = tiers === null ? null : (tiers.models[tiers.default] ?? null);
  return events.reduce(stepModelSwitch, { current, pending: null, failed: null });
};

// The node runs inside the containers named by `parents`: the read side of updateNode.
export const findNodeRuns = (nodeRuns: Nodes, parents: readonly string[]): Nodes =>
  parents.reduce<Nodes>(
    (runs, id) => (Object.hasOwn(runs, id) ? (runs[id]?.nodes ?? {}) : {}),
    nodeRuns,
  );

// Rewrites the entry for `nodeId` inside the containers named by `parents`, rebuilding each
// container on the way down. A container missing from state means an event came before the event
// that started its container, which the engines never emit, so it is refused.
const updateNode = (
  nodes: Nodes,
  parents: readonly string[],
  nodeId: string,
  update: (current: NodeRun | undefined) => NodeRun,
): Nodes => {
  const [container, ...rest] = parents;
  if (container === undefined) return { ...nodes, [nodeId]: update(nodes[nodeId]) };
  const holder = nodes[container];
  if (holder === undefined) {
    throw new Error(`${nodeId}: its container ${container} is not in state.json`);
  }
  return {
    ...nodes,
    [container]: { ...holder, nodes: updateNode(holder.nodes ?? {}, rest, nodeId, update) },
  };
};

const CONTAINER_TYPES = new Set<z.infer<typeof NodeTypeSchema>>(["loop", "switch", "include"]);

// A node started again (a new loop pass, or a re-run) replaces its entry: state keeps the latest run.
const onStarted: EventHandler = (state, event) => {
  const parsed = NodeStartedEvent.safeParse(event);
  if (!parsed.success) return state;
  const { nodeId, nodeRunId, payload } = parsed.data;
  const run: NodeRun = {
    nodeRunId,
    nodeType: payload.nodeType,
    status: "running",
    startedAt: event.ts,
    completedAt: null,
    artifacts: [],
    ...(payload.input === undefined ? {} : { input: payload.input }),
    ...(payload.branch === undefined ? {} : { branch: payload.branch }),
    ...(payload.nodeType === "loop" ? { iteration: 1 } : {}),
    ...(CONTAINER_TYPES.has(payload.nodeType) ? { nodes: {} } : {}),
  };
  return {
    ...state,
    nodeRuns: updateNode(state.nodeRuns, payload.parents ?? [], nodeId, () => run),
  };
};

type EndStatus = keyof typeof nodeEndedEvents;
type NodeEndedPayload = z.infer<(typeof nodeEndedEvents)[EndStatus]>["payload"];

// A completed node's output is its value; a failed or cancelled node's is its error, without the
// stack; a skipped node's is why.
const endOutputOf = (payload: NodeEndedPayload): JsonValue | undefined => {
  if ("skip" in payload) return payload.skip;
  if ("error" in payload && payload.error !== undefined) {
    return { kind: payload.error.kind, message: payload.error.message };
  }
  return "output" in payload ? payload.output : undefined;
};

// A node that did not complete drops what a loop's earlier pass left in its output.
const withoutOutput = ({ output: _, ...run }: NodeRun): NodeRun => run;

// A node can end without starting (skipped, cancelled, failed before it ran), so the end event
// creates the entry when no entry holds this run. A skipped node never runs, so it starts and ends
// at the skip.
const onEnded = (status: EndStatus, state: State, event: Event): State => {
  const parsed = nodeEndedEvents[status].safeParse(event);
  if (!parsed.success) return state;
  const { nodeId, nodeRunId, payload } = parsed.data;
  const output = endOutputOf(payload);
  const artifacts = "artifacts" in payload ? payload.artifacts : undefined;
  const end = (current: NodeRun | undefined): NodeRun => {
    const run: NodeRun =
      current?.nodeRunId === nodeRunId
        ? current
        : {
            nodeRunId,
            nodeType: payload.nodeType,
            status,
            startedAt: status === "skipped" ? event.ts : null,
            completedAt: null,
            artifacts: [],
          };
    return {
      ...(status === "completed" ? run : withoutOutput(run)),
      ...(output === undefined ? {} : { output }),
      artifacts: artifacts ?? run.artifacts,
      status,
      completedAt: event.ts,
    };
  };
  return { ...state, nodeRuns: updateNode(state.nodeRuns, payload.parents ?? [], nodeId, end) };
};

// The next pass of a loop starts empty: the last pass's children are history now (event.jsonl).
const onIterated: EventHandler = (state, event) => {
  const parsed = NodeIteratedEvent.safeParse(event);
  if (!parsed.success) return state;
  const { nodeId, payload } = parsed.data;
  const nextPass = (current: NodeRun | undefined): NodeRun => {
    if (current === undefined)
      throw new Error(`${nodeId}: a loop that never started cannot iterate`);
    return { ...current, iteration: payload.iteration, output: payload.output, nodes: {} };
  };
  return {
    ...state,
    nodeRuns: updateNode(state.nodeRuns, payload.parents ?? [], nodeId, nextPass),
  };
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
  const { workspaceDir, branch, layout, repositories } = parsed.data.payload;
  const entries = Object.entries(repositories).map(
    ([key, repo]) => [key, toRepositoryState(repo, branch)] as const,
  );
  const workspace = { type: layout, path: workspaceDir, repositories: Object.fromEntries(entries) };
  return { ...state, workspace };
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
  const { inputs, activeSessions } = parsed.data.payload;
  return {
    ...state,
    startedAt: event.ts,
    input: inputs,
    ...(activeSessions === undefined ? {} : { activeSessions }),
  };
};

const onWorkflowEnded = (status: "completed" | "failed", state: State, event: Event): State => ({
  ...state,
  status,
  completedAt: event.ts,
});

const onStopCalled: EventHandler = (state, event) => {
  const parsed = StopCalledEvent.safeParse(event);
  if (!parsed.success) return state;
  return { ...state, stopHook: { blockStreak: parsed.data.payload.blockStreak, seq: event.seq } };
};

const onSessionReplaced: EventHandler = (state, event) => {
  const parsed = SessionReplacedEvent.safeParse(event);
  if (!parsed.success) return state;
  const { agent, previousSessionId, sessionId } = parsed.data.payload;
  const fresh = { agent, sessionId };
  const known = state.activeSessions.some((s) => s.sessionId === previousSessionId);
  const activeSessions = known
    ? state.activeSessions.map((s) => (s.sessionId === previousSessionId ? fresh : s))
    : [...state.activeSessions, fresh];
  return { ...state, activeSessions };
};

const onThreadStarted: EventHandler = (state, event) => {
  const parsed = NotificationThreadStartedEvent.safeParse(event);
  if (!parsed.success) return state;
  return { ...state, notification: { ...state.notification, ...parsed.data.payload } };
};

const onCustomStateUpdated: EventHandler = (state, event) => {
  const parsed = CustomStateUpdatedEvent.safeParse(event);
  if (!parsed.success) return state;
  return { ...state, custom: { ...state.custom, ...parsed.data.payload } };
};

export const builtInHandlers: EventHandlers = {
  "workflow.started": onWorkflowStarted,
  "workflow.completed": (state, event) => onWorkflowEnded("completed", state, event),
  "workflow.failed": (state, event) => onWorkflowEnded("failed", state, event),
  "workflow.node.started": onStarted,
  "workflow.node.completed": (state, event) => onEnded("completed", state, event),
  "workflow.node.failed": (state, event) => onEnded("failed", state, event),
  "workflow.node.skipped": (state, event) => onEnded("skipped", state, event),
  "workflow.node.cancelled": (state, event) => onEnded("cancelled", state, event),
  "workflow.node.iterated": onIterated,
  "workspace.created": onWorkspaceCreated,
  "workspace.repository.added": onRepositoryAdded,
  "workspace.repository.removed": onRepositoryRemoved,
  "hooks.stop.called": onStopCalled,
  "workflow.session.replaced": onSessionReplaced,
  "notification.thread.started": onThreadStarted,
  "custom.state.updated": onCustomStateUpdated,
};
