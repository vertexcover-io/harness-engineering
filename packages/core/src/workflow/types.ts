import { z } from "zod";
import { type JsonValue, NonEmptyStringSchema } from "../contracts.ts";

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
};

const guardedFields = { ...baseFields, when: ExpressionSchema.optional() };

const leafFields = {
  ...guardedFields,
  cwd: NonEmptyStringSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
  retry: RetrySchema.optional(),
};

export const ExecNodeSchema = z
  .strictObject({
    ...leafFields,
    type: z.literal("exec"),
    runtime: z.enum(["sh", "bun"]).optional(),
    script: NonEmptyStringSchema.optional(),
    module: NonEmptyStringSchema.optional(),
    functionName: NonEmptyStringSchema.optional(),
    output: z
      .strictObject({
        format: z.enum(["text", "json"]).optional(),
        module: NonEmptyStringSchema.optional(),
        zodSchema: NonEmptyStringSchema.optional(),
      })
      .optional(),
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
    if (isModule && node.output?.format !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["output", "format"],
        message: "output.format applies to scripts only",
      });
    }
    if ((node.output?.module === undefined) !== (node.output?.zodSchema === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["output"],
        message: "output.module and output.zodSchema go together",
      });
    }
  });

export const WaitNodeSchema = z.strictObject({
  ...guardedFields,
  type: z.literal("wait"),
  durationMs: z.number().int().positive(),
});

const SwitchCaseFieldsSchema = z.strictObject({ id: NodeIdSchema, value: ScalarSchema });

const SwitchNodeFieldsSchema = z.strictObject({
  ...baseFields,
  type: z.literal("switch"),
  expression: ExpressionSchema,
});

export type SwitchCase = z.infer<typeof SwitchCaseFieldsSchema> & { nodes: WorkflowNode[] };
export type SwitchNode = z.infer<typeof SwitchNodeFieldsSchema> & {
  cases: SwitchCase[];
  default?: WorkflowNode[] | undefined;
};

export const IncludeNodeSchema = z.strictObject({
  ...guardedFields,
  type: z.literal("include"),
  workflow: NonEmptyStringSchema,
});

const LoopNodeFieldsSchema = z.strictObject({
  ...guardedFields,
  type: z.literal("loop"),
  until: ExpressionSchema,
  maxIterations: z.number().int().min(1).max(1000),
});

export type LoopNode = z.infer<typeof LoopNodeFieldsSchema> & { nodes: WorkflowNode[] };

export const AgentNodeSchema = z
  .strictObject({
    ...leafFields,
    type: z.literal("agent"),
    adapter: NonEmptyStringSchema,
    stage: NonEmptyStringSchema.optional(),
    prompt: NonEmptyStringSchema.optional(),
    output: z
      .strictObject({ module: NonEmptyStringSchema, zodSchema: NonEmptyStringSchema })
      .optional(),
  })
  .superRefine((node, ctx) => {
    if (node.stage === undefined && node.prompt === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "agent needs a prompt when it has no stage",
      });
    }
  });

export type WorkflowNode = ExecNode | AgentNode | SwitchNode | IncludeNode | LoopNode | WaitNode;

export const NodeSchema: z.ZodType<WorkflowNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    ExecNodeSchema,
    AgentNodeSchema,
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

export const WorkflowSchema = z.strictObject({
  name: NonEmptyStringSchema,
  version: z.union([z.string(), z.number()]).optional(),
  inputs: z.record(NodeIdSchema, InputDeclarationSchema).default({}),
  maxConcurrency: z.number().int().positive().default(4),
  nodes: z.array(NodeSchema).min(1),
});

export const NodeStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

export const FailureKindSchema = z.enum([
  "exit",
  "timeout",
  "resolution",
  "validation",
  "exception",
  "aborted",
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
  "missing-export",
  "missing-workflow",
  "include-recursion",
  "include-limit",
  "missing-adapter",
  "missing-schema",
  "event-lost",
]);

export const NodeRecordSchema = z.object({
  path: z.string(),
  type: z.string(),
  status: NodeStatusSchema,
  input: z.json().optional(),
  output: z.json().optional(),
  attempts: z.number().int().min(0),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  error: z
    .object({ kind: FailureKindSchema, message: z.string(), stack: z.string().optional() })
    .optional(),
});

export const RunResultSchema = z.object({
  status: z.enum(["completed", "failed"]),
  nodes: z.record(z.string(), NodeRecordSchema),
});

export type Workflow = z.infer<typeof WorkflowSchema>;
export type InputDeclarations = Workflow["inputs"];
export type ExecNode = z.infer<typeof ExecNodeSchema>;
export type WaitNode = z.infer<typeof WaitNodeSchema>;
export type IncludeNode = z.infer<typeof IncludeNodeSchema>;
export type AgentNode = z.infer<typeof AgentNodeSchema>;
export type NodeStatus = z.infer<typeof NodeStatusSchema>;
export type FailureKind = z.infer<typeof FailureKindSchema>;
export type WorkflowErrorCode = z.infer<typeof WorkflowErrorCodeSchema>;
export type NodeRecord = z.infer<typeof NodeRecordSchema>;
export type RunResult = z.infer<typeof RunResultSchema>;

export type WorkflowPlan = Readonly<{
  name: string;
  inputs: InputDeclarations;
  maxConcurrency: number;
  nodes: readonly WorkflowNode[];
  includes: ReadonlyMap<string, WorkflowPlan>;
  size: number;
  hash: string;
}>;

export type AgentRequest = Readonly<{
  input: JsonValue;
  stage?: string;
  prompt?: string;
  context: NodeContext;
}>;

export type AgentAdapter = Readonly<{
  run: (request: AgentRequest) => Promise<JsonValue>;
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
    readonly output?: JsonValue,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NodeFailure";
  }
}
