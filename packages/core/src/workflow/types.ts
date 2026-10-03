import {
  AgentTypeSchema,
  EnvLayerSchema,
  type JsonValue,
  NameSchema,
  NodeTypeSchema,
  NonEmptyStringSchema,
  type ProcessRecord,
  ProcessRecordSchema,
} from "@harness/sdk";
import { z } from "zod";
import type { ArtifactDeclaration, Stage } from "../stage.ts";

export const NodeIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, "ids may use letters, digits, _ and - only")
  .refine((id) => !["__proto__", "prototype", "constructor"].includes(id), "id is reserved");

const ExpressionSchema = z.string().regex(/^\{\{.*\}\}$/s, 'must be one quoted "{{ expression }}"');

export const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const RetrySchema = z.strictObject({
  maxAttempts: z.number().int().min(1),
  delayMs: z.number().int().min(0).optional(),
});

const baseFields = {
  id: NodeIdSchema,
  input: z.json(),
  dependsOn: z.array(NodeIdSchema).default([]),
  allowFailure: z.boolean().default(false),
};

const guardedFields = { ...baseFields, when: ExpressionSchema.optional() };

const leafFields = {
  ...guardedFields,
  cwd: NonEmptyStringSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  retry: RetrySchema.optional(),
};

// Json is the built-in schema for any JSON value; every other schema is an export of `module`.
const OutputSchemaRefSchema = z
  .strictObject({ module: NonEmptyStringSchema.optional(), zodSchema: NonEmptyStringSchema })
  .refine((ref) => ref.module !== undefined || ref.zodSchema === "Json", {
    path: ["module"],
    message: "output.module is required unless zodSchema is Json",
  });

export const ExecNodeSchema = z
  .strictObject({
    ...leafFields,
    type: NodeTypeSchema.extract(["exec"]),
    mode: z.enum(["inline", "background"]).default("inline"),
    runtime: z.enum(["sh", "bun"]).optional(),
    script: NonEmptyStringSchema.optional(),
    module: NonEmptyStringSchema.optional(),
    functionName: NonEmptyStringSchema.optional(),
    output: OutputSchemaRefSchema.optional(),
  })
  .superRefine((node, ctx) => {
    const scriptKeys = [node.runtime, node.script].filter((v) => v !== undefined).length;
    const moduleKeys = [node.module, node.functionName].filter((v) => v !== undefined).length;
    const isScript = scriptKeys === 2 && moduleKeys === 0;
    const isModule = moduleKeys === 2 && scriptKeys === 0;
    if (!isScript && !isModule) {
      ctx.addIssue({
        code: "custom",
        message: "exec needs runtime + script, or module + functionName",
      });
    }
  });

export const WaitNodeSchema = z.strictObject({
  ...guardedFields,
  type: NodeTypeSchema.extract(["wait"]),
  durationMs: z.number().int().positive(),
});

// A step that gives the agent a fresh context: `new` replaces its session with a new one in the
// same pane, `compact` compacts the session it has, steered by `prompt` when given. It takes no
// input.
export const ContextNodeSchema = z
  .strictObject({
    ...guardedFields,
    input: z.json().default(null),
    type: NodeTypeSchema.extract(["context"]),
    action: z.enum(["new", "compact"]),
    prompt: NonEmptyStringSchema.optional(),
  })
  .superRefine((node, ctx) => {
    if (node.action === "new" && node.prompt !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "prompt steers a compact; a new session takes none",
      });
    }
  });

const SwitchCaseFieldsSchema = z.strictObject({ id: NodeIdSchema, value: ScalarSchema });

const SwitchNodeFieldsSchema = z.strictObject({
  ...baseFields,
  type: NodeTypeSchema.extract(["switch"]),
  expression: ExpressionSchema,
});

export type SwitchCase = z.infer<typeof SwitchCaseFieldsSchema> & { nodes: WorkflowNode[] };
export type SwitchNode = z.infer<typeof SwitchNodeFieldsSchema> & {
  cases: SwitchCase[];
  default?: WorkflowNode[] | undefined;
};

export const IncludeNodeSchema = z.strictObject({
  ...guardedFields,
  type: NodeTypeSchema.extract(["include"]),
  workflow: NonEmptyStringSchema,
});

const LoopNodeFieldsSchema = z.strictObject({
  ...guardedFields,
  type: NodeTypeSchema.extract(["loop"]),
  until: ExpressionSchema,
  maxIterations: z.number().int().min(1).max(1000),
});

export type LoopNode = z.infer<typeof LoopNodeFieldsSchema> & { nodes: WorkflowNode[] };

export const AgentNodeSchema = z
  .strictObject({
    ...leafFields,
    type: NodeTypeSchema.extract(["agent"]),
    stage: NonEmptyStringSchema.optional(),
    prompt: NonEmptyStringSchema.optional(),
    output: OutputSchemaRefSchema.optional(),
    variables: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((node, ctx) => {
    if (node.stage === undefined && node.prompt === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "agent needs a prompt when it has no stage",
      });
    }
    if (node.stage === undefined && node.variables !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["variables"],
        message: "only a stage node sets variables",
      });
    }
  });

export type WorkflowNode =
  | ExecNode
  | AgentNode
  | ContextNode
  | SwitchNode
  | IncludeNode
  | LoopNode
  | WaitNode;

export const NodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    ExecNodeSchema,
    AgentNodeSchema,
    ContextNodeSchema,
    SwitchNodeSchema,
    IncludeNodeSchema,
    LoopNodeSchema,
    WaitNodeSchema,
  ]),
);

const LoopNodeSchema = LoopNodeFieldsSchema.extend({ nodes: z.array(NodeSchema).min(1) });

const SwitchCaseSchema = SwitchCaseFieldsSchema.extend({ nodes: z.array(NodeSchema).min(1) });

export const SwitchNodeSchema = SwitchNodeFieldsSchema.extend({
  cases: z.array(SwitchCaseSchema).min(1),
  default: z.array(NodeSchema).min(1).optional(),
});

const InputDeclarationSchema = z.strictObject({
  type: z.enum(["string", "number", "boolean", "object", "array"]),
  required: z.boolean().default(false),
  default: z.json().optional(),
});

// Advice for the user, never a command the doctor runs.
export const DoctorDeclarationSchema = z.strictObject({
  check: z.enum(["env", "binary", "package", "file"]),
  key: NonEmptyStringSchema,
  fix: NonEmptyStringSchema,
});

// Only the agents that have a provider; AgentTypeSchema also lists ones that do not.
export const WorkflowAgentSchema = AgentTypeSchema.extract(["claude", "codex"]);
export type WorkflowAgent = z.infer<typeof WorkflowAgentSchema>;

export const WorkflowSchema = z.strictObject({
  name: NonEmptyStringSchema,
  version: z.union([z.string(), z.number()]).optional(),
  agent: WorkflowAgentSchema.default("claude"),
  // looked up under agents.AGENT.tiers in the config to pick the model the session launches with
  tier: NameSchema.optional(),
  // set in every agent session of the run, over the config's; envFile is relative to the folder
  // the run starts in (the repo root). Only the top workflow's apply; an included one's are ignored.
  ...EnvLayerSchema.shape,
  doctor: z.array(DoctorDeclarationSchema).default([]),
  inputs: z.record(NodeIdSchema, InputDeclarationSchema).default({}),
  nodes: z.array(NodeSchema).min(1),
});

export const FailureKindSchema = z.enum([
  "exit",
  "timeout",
  "resolution",
  "validation",
  "exception",
  "exhausted",
]);

export const WorkflowErrorCodeSchema = z.enum([
  "yaml",
  "schema",
  "duplicate-id",
  "missing-dependency",
  "cycle",
  "invalid-expression",
  "invalid-reference",
  "input",
  "missing-module",
  "load-failed",
  "missing-export",
  "missing-workflow",
  "include-recursion",
  "include-limit",
  "missing-schema",
  "missing-stage",
  "missing-artifact",
]);

// How one exec, wait or agent node ended, as orchestrate exec and done record it. A script's
// process record goes to the event log only; output is the value state.json keeps.
export const WorkflowCompileErrorSchema = z.strictObject({
  kind: z.literal("compile"),
  retryable: z.literal(false),
  code: WorkflowErrorCodeSchema,
  path: z.string(),
  message: z.string(),
});

export type WorkflowCompileError = z.infer<typeof WorkflowCompileErrorSchema>;

// How one exec, wait or agent node ended, as orchestrate exec and done record it.
export const NodeRecordSchema = z.object({
  path: z.string(),
  type: NodeTypeSchema,
  status: z.enum(["completed", "failed"]),
  output: z.json().optional(),
  process: ProcessRecordSchema.optional(),
  attempts: z.number().int().min(1),
  error: z
    .object({ kind: FailureKindSchema, message: z.string(), stack: z.string().optional() })
    .optional(),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
export type DoctorDeclaration = z.infer<typeof DoctorDeclarationSchema>;
export type InputDeclarations = Workflow["inputs"];
export type ExecNode = z.infer<typeof ExecNodeSchema>;
export type WaitNode = z.infer<typeof WaitNodeSchema>;
export type IncludeNode = z.infer<typeof IncludeNodeSchema>;
export type AgentNode = z.infer<typeof AgentNodeSchema>;
export type ContextNode = z.infer<typeof ContextNodeSchema>;
export type FailureKind = z.infer<typeof FailureKindSchema>;
export type WorkflowErrorCode = z.infer<typeof WorkflowErrorCodeSchema>;
export type NodeRecord = z.infer<typeof NodeRecordSchema>;

// A verifier as compile loads it: its function already imported, or the script to run.
export type PlanVerifier = Readonly<{ id: string; args: JsonValue; timeoutMs: number }> &
  (
    | Readonly<{ kind: "function"; fn: WorkflowFunction }>
    | Readonly<{ kind: "script"; runtime: "sh" | "bun"; script: string }>
  );

// A stage as compile loads it: the text the workflow wrote, the skill's name, where its SKILL.md
// is, the artifacts it needs and writes, its verifiers, and the variables it takes.
export type PlanStage = Readonly<{
  ref: string;
  name: string;
  skill: string;
  consumes: readonly ArtifactDeclaration[];
  produces: readonly ArtifactDeclaration[];
  variables: Stage["variables"];
  // The schema the stage's SKILL.md names for its output; without one, its output is plain text.
  output?: Readonly<{ name: string; schema: z.ZodType }>;
  verifiers: readonly PlanVerifier[];
}>;

// Compiled nodes carry what they need: the ids of the containers around them (the path to their
// entry in state.json), a stage node its loaded SKILL.md, an include node the workflow it
// includes, and loops and switches their compiled children.
export type PlanExecNode = ExecNode & {
  readonly parents: readonly string[];
  outputSchema?: z.ZodType | undefined;
};
export type PlanWaitNode = WaitNode & { readonly parents: readonly string[] };
export type PlanContextNode = ContextNode & { readonly parents: readonly string[] };
export type PlanAgentNode = Omit<AgentNode, "stage"> & {
  readonly parents: readonly string[];
  stage?: PlanStage;
  outputSchema?: z.ZodType | undefined;
};
export type PlanIncludeNode = IncludeNode & {
  readonly parents: readonly string[];
  plan: WorkflowPlan;
};
export type PlanLoopNode = Omit<LoopNode, "nodes"> & {
  readonly parents: readonly string[];
  nodes: PlanNode[];
};
export type PlanSwitchCase = Omit<SwitchCase, "nodes"> & { nodes: PlanNode[] };
export type PlanSwitchNode = Omit<SwitchNode, "cases" | "default"> & {
  readonly parents: readonly string[];
  cases: PlanSwitchCase[];
  default?: PlanNode[] | undefined;
};
export type PlanNode =
  | PlanExecNode
  | PlanWaitNode
  | PlanAgentNode
  | PlanContextNode
  | PlanIncludeNode
  | PlanLoopNode
  | PlanSwitchNode;

export type WorkflowPlan = Readonly<{
  name: string;
  agent: WorkflowAgent;
  tier?: string | undefined;
  env: Readonly<Record<string, string>>;
  envFile?: string | undefined;
  inputs: InputDeclarations;
  doctor: readonly DoctorDeclaration[];
  nodes: readonly PlanNode[];
}>;

export type NodeContext = Readonly<{
  path: string;
  cwd: string;
  attempt: number;
  signal: AbortSignal;
}>;

export type WorkflowFunction = (
  input: JsonValue,
  context: NodeContext,
) => JsonValue | Promise<JsonValue>;

export class WorkflowError extends Error {
  constructor(
    readonly code: WorkflowErrorCode,
    message: string,
    readonly path = "",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkflowError";
  }
}

export class NodeFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly process?: ProcessRecord,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NodeFailure";
  }
}
