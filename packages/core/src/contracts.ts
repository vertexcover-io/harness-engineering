import * as z from "zod";

export const NonEmptyStringSchema = z.string().min(1);
export const SlugSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
export const SkillNameSchema = z
  .string()
  .regex(/^(?:[a-z][a-z0-9-]*:)?[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
const UniqueSlugsSchema = z
  .array(SlugSchema)
  .refine((values) => new Set(values).size === values.length, "Names must be unique");
export const JsonObjectSchema = z.record(z.string(), z.json());
export const isNormalizedRelativePath = (value: string): boolean =>
  !value.startsWith("/") &&
  !/^[A-Za-z]:/.test(value) &&
  !value.includes("\\") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const RunPathSchema = NonEmptyStringSchema.refine(
  isNormalizedRelativePath,
  "Expected a normalized path relative to the run folder",
);
const ArtifactPathSchema = RunPathSchema.refine(
  (value) => value.startsWith("artifacts/"),
  "Artifact paths must be inside artifacts/",
);
const SchemaKeySchema = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.v[1-9]\d*$/);

export const ArtifactRefSchema = z.strictObject({
  name: NonEmptyStringSchema,
  path: ArtifactPathSchema,
});

export const ArtifactDeclarationSchema = z.strictObject({
  artifact: SlugSchema,
  optional: z.boolean().default(false),
});

export const StagePortSchema = z.strictObject({
  description: NonEmptyStringSchema,
  schema: SchemaKeySchema,
});

const ReferenceSchema = z.strictObject({
  path: NonEmptyStringSchema.refine(
    isNormalizedRelativePath,
    "Expected a normalized path relative to the skill folder",
  ),
  description: NonEmptyStringSchema,
});

export const StageSchema = z.strictObject({
  name: SlugSchema,
  description: NonEmptyStringSchema,
  mode: z.enum(["inline", "subagent"]),
  tags: UniqueSlugsSchema.optional(),
  "allowed-tools": z.array(NonEmptyStringSchema),
  tier: NonEmptyStringSchema,
  inputs: StagePortSchema,
  outputs: StagePortSchema,
  consumes: z.array(ArtifactDeclarationSchema).optional(),
  produces: z.array(ArtifactDeclarationSchema).optional(),
  protocols: UniqueSlugsSchema,
  scopes: UniqueSlugsSchema,
  references: z.record(SlugSchema, ReferenceSchema).default({}),
});

export const TokenUsageSchema = z.strictObject({
  input: z.int().nonnegative(),
  output: z.int().nonnegative(),
  cachedInput: z.int().nonnegative().optional(),
  cachedOutput: z.int().nonnegative().optional(),
});

export const AgentStateSchema = z.strictObject({
  agent: NonEmptyStringSchema,
  model: NonEmptyStringSchema,
  sessionId: NonEmptyStringSchema.nullable(),
  tokens: TokenUsageSchema.nullable(),
});

export const NodeRunSchema = z
  .strictObject({
    nodeRunId: NonEmptyStringSchema,
    nodeId: NonEmptyStringSchema,
    index: z.int().positive(),
    status: z.enum(["running", "completed", "failed", "skipped", "cancelled", "interrupted"]),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
    result: z.string().max(500).nullable(),
    artifacts: z.array(ArtifactRefSchema),
    parentNodeRunId: NonEmptyStringSchema.optional(),
    iteration: z.int().positive().optional(),
    stage: SlugSchema.optional(),
    agentState: AgentStateSchema.optional(),
  })
  .superRefine((run, context) => {
    if ((run.stage === undefined) !== (run.agentState === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["agentState"],
        message: "Stage and agentState must appear together",
      });
    }
    if (run.status === "skipped" && !run.result?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "A skipped run needs a reason",
      });
    }
  });

export const PullRequestSchema = z.strictObject({
  id: NonEmptyStringSchema,
  url: z.url(),
});

export const GitStateSchema = z.strictObject({
  branch: NonEmptyStringSchema,
  baseBranch: NonEmptyStringSchema,
  startSha: NonEmptyStringSchema,
  pr: PullRequestSchema.optional(),
});

export const RepositorySchema = z.strictObject({
  path: NonEmptyStringSchema,
  git: GitStateSchema,
});

export const WorkspaceSchema = z.strictObject({
  path: NonEmptyStringSchema,
  repositories: z
    .record(SlugSchema, RepositorySchema)
    .refine(
      (repositories) => Object.keys(repositories).length > 0,
      "At least one repository is required",
    ),
});

export const TicketSchema = z.record(NonEmptyStringSchema, z.json());
export const NotificationSchema = z.record(NonEmptyStringSchema, z.json());

export const WorkflowRefSchema = z.strictObject({
  name: SlugSchema,
  path: z.literal("workflow.yaml"),
});

export const StateSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    lastEventSeq: z.int().nonnegative(),
    specName: SlugSchema,
    harnessVersion: NonEmptyStringSchema,
    workflow: WorkflowRefSchema,
    input: JsonObjectSchema,
    scope: NonEmptyStringSchema,
    options: JsonObjectSchema,
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    outcome: z.enum(["completed", "failed", "cancelled"]).nullable(),
    currentFile: NonEmptyStringSchema.nullable(),
    workspace: WorkspaceSchema,
    ticket: TicketSchema.optional(),
    notification: NotificationSchema.optional(),
    activeNodeRuns: z.array(NonEmptyStringSchema),
    nodeRuns: z.record(NonEmptyStringSchema, NodeRunSchema),
  })
  .superRefine((state, context) => {
    const active = new Set(state.activeNodeRuns);
    if (active.size !== state.activeNodeRuns.length) {
      context.addIssue({
        code: "custom",
        path: ["activeNodeRuns"],
        message: "Active IDs must be unique",
      });
    }
    for (const [id, run] of Object.entries(state.nodeRuns)) {
      if (id !== run.nodeRunId) {
        context.addIssue({
          code: "custom",
          path: ["nodeRuns", id],
          message: "Key must equal nodeRunId",
        });
      }
      if (run.parentNodeRunId && !state.nodeRuns[run.parentNodeRunId]) {
        context.addIssue({
          code: "custom",
          path: ["nodeRuns", id, "parentNodeRunId"],
          message: "Parent run is missing",
        });
      }
    }
    for (const id of active) {
      if (state.nodeRuns[id]?.status !== "running") {
        context.addIssue({
          code: "custom",
          path: ["activeNodeRuns"],
          message: `Run ${id} is not running`,
        });
      }
    }
  });

const EventTypeSchema = z
  .string()
  .refine(
    (value) =>
      /^(workflow|artifact|hooks|workspace|forge|learning|agent)(\.[a-z][a-z0-9_-]*)+$/.test(
        value,
      ) ||
      /^stage\.[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/.test(value) ||
      /^custom\.[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/.test(value),
    "Unknown event namespace or invalid event name",
  );

export const EventSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    seq: z.int().positive(),
    id: NonEmptyStringSchema,
    ts: z.iso.datetime(),
    type: EventTypeSchema,
    source: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    nodeId: NonEmptyStringSchema.optional(),
    nodeRunId: NonEmptyStringSchema.optional(),
    stage: SlugSchema.optional(),
    payload: z.json(),
  })
  .superRefine((event, context) => {
    if ((event.nodeId === undefined) !== (event.nodeRunId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["nodeRunId"],
        message: "Node IDs must appear together",
      });
    }
    if (event.stage !== undefined && event.nodeId === undefined) {
      context.addIssue({ code: "custom", path: ["stage"], message: "A stage needs node IDs" });
    }
    const isStageEvent = event.type.startsWith("stage.");
    if (isStageEvent && (event.stage !== event.type.split(".")[1] || event.nodeId === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["stage"],
        message: "Stage events need matching stage and node IDs",
      });
    }
  });

export type JsonValue = z.infer<z.ZodJSONSchema>;
export type JsonObject = z.infer<typeof JsonObjectSchema>;
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type ArtifactDeclaration = z.infer<typeof ArtifactDeclarationSchema>;
export type StagePort = z.infer<typeof StagePortSchema>;
export type Stage = z.infer<typeof StageSchema>;

export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type AgentState = z.infer<typeof AgentStateSchema>;
export type NodeRun = z.infer<typeof NodeRunSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;
export type GitState = z.infer<typeof GitStateSchema>;
export type Repository = z.infer<typeof RepositorySchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
export type Ticket = z.infer<typeof TicketSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type WorkflowRef = z.infer<typeof WorkflowRefSchema>;
export type State = z.infer<typeof StateSchema>;
export type Event = z.infer<typeof EventSchema>;

export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
