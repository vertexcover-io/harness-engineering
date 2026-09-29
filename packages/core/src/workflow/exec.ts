import { resolve } from "node:path";
import { type JsonValue, stackOf } from "@harness/sdk";
import { own } from "../stage.ts";
import { asJson, callFunction, importModule, loadFunction, runScript } from "./executors.ts";
import {
  type ExecNode,
  type NodeContext,
  NodeFailure,
  type NodeRecord,
  type PlanAgentNode,
  type WaitNode,
  WorkflowError,
  type WorkflowFunction,
} from "./types.ts";

type SchemaLike = {
  safeParse: (value: unknown) => { success: boolean; error?: { message: string } };
};

// What one exec node needs for every attempt: its function and output schema are loaded once.
type ExecRun = Readonly<{
  node: ExecNode;
  input: JsonValue;
  path: string;
  cwd: string;
  fn: WorkflowFunction | undefined;
  schema: SchemaLike | undefined;
}>;

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

const buildFailedRecord = (
  node: ExecNode | PlanAgentNode,
  path: string,
  failure: NodeFailure,
): NodeRecord => ({
  path,
  type: node.type,
  status: "failed",
  attempts: 1,
  error: { kind: failure.kind, message: failure.message, stack: stackOf(failure) },
  ...(failure.output === undefined ? {} : { output: failure.output }),
});

const isSchema = (value: unknown): value is SchemaLike =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { safeParse?: unknown }).safeParse === "function";

// The zod schema a node's output must match, from the `schemas` export of its module.
const loadSchema = async (
  node: ExecNode | PlanAgentNode,
  cwd: string,
): Promise<SchemaLike | undefined> => {
  const ref = node.output;
  if (ref?.module === undefined || ref.zodSchema === undefined) return undefined;
  const registry = (await importModule(ref.module, cwd)).schemas;
  const schema =
    typeof registry === "object" && registry !== null
      ? own(registry as Record<string, unknown>, ref.zodSchema)
      : undefined;
  if (!isSchema(schema)) {
    const message = `${ref.module} has no schemas.${ref.zodSchema}`;
    throw new WorkflowError("missing-schema", message, ref.zodSchema);
  }
  return schema;
};

const checkSchema = (
  node: ExecNode | PlanAgentNode,
  output: JsonValue,
  path: string,
  schema: SchemaLike | undefined,
): JsonValue => {
  if (schema === undefined) return output;
  const result = schema.safeParse(output);
  if (result.success) return output;
  const where = `${node.output?.module} schemas.${node.output?.zodSchema}`;
  throw new NodeFailure(
    "validation",
    `${path} output does not match ${where}: ${result.error?.message ?? ""}`,
  );
};

const parseJson = (stdout: string, path: string): JsonValue => {
  try {
    return JSON.parse(stdout.trim()) as JsonValue;
  } catch {
    throw new NodeFailure("validation", `${path} printed stdout that is not JSON`);
  }
};

const runScriptNode = async (
  node: ExecNode,
  input: JsonValue,
  context: Omit<NodeContext, "signal">,
): Promise<JsonValue> => {
  if (node.runtime === undefined || node.script === undefined)
    throw new NodeFailure("exception", `${context.path} has no script to run`);
  const result = await runScript({
    runtime: node.runtime,
    script: node.script,
    input,
    cwd: context.cwd,
    timeoutMs: node.timeoutMs,
  });
  if (result.exitCode !== 0)
    throw new NodeFailure("exit", `${context.path} exited with code ${result.exitCode}`, result);
  return node.output?.format === "json"
    ? { ...result, value: parseJson(result.stdout, context.path) }
    : result;
};

const attempt = async (run: ExecRun, number: number): Promise<JsonValue> => {
  const { node, input, path } = run;
  const context = { path, cwd: resolve(run.cwd, node.cwd ?? "."), attempt: number };
  const output =
    run.fn === undefined
      ? await runScriptNode(node, input, context)
      : await callFunction(run.fn, input, context, node.timeoutMs);
  return checkSchema(node, output, path, run.schema);
};

// Output that fails its schema is not retried: running the same code again gives the same output.
const runExec = async (run: ExecRun, number = 1): Promise<NodeRecord> => {
  const { node, path } = run;
  try {
    const output = await attempt(run, number);
    return { path, type: node.type, status: "completed", output, attempts: number };
  } catch (error) {
    const failure = toFailure(error);
    if (number >= (node.retry?.maxAttempts ?? 1) || failure.kind === "validation") {
      return { ...buildFailedRecord(node, path, failure), attempts: number };
    }
    await Bun.sleep(node.retry?.delayMs ?? 0);
    return runExec(run, number + 1);
  }
};

// Runs one exec or wait node that next already started; the caller records how it ended.
export const runStepLeaf = async (
  node: ExecNode | WaitNode,
  input: JsonValue,
  options: Readonly<{ cwd: string; path: string }>,
): Promise<NodeRecord> => {
  const { cwd, path } = options;
  if (node.type === "wait") {
    await Bun.sleep(node.durationMs);
    return { path, type: node.type, status: "completed", output: input, attempts: 1 };
  }
  try {
    const fn =
      node.module === undefined || node.functionName === undefined
        ? undefined
        : await loadFunction(node.module, node.functionName, cwd);
    const schema = await loadSchema(node, cwd);
    return await runExec({ node, input, path, cwd: resolve(cwd), fn, schema });
  } catch (error) {
    return buildFailedRecord(node, path, toFailure(error));
  }
};

// Checks an agent node's reported output against its declared schema, for orchestrate done.
export const checkAgentOutput = async (
  node: PlanAgentNode,
  output: JsonValue,
  options: Readonly<{ cwd: string; path: string }>,
): Promise<NodeRecord> => {
  const { cwd, path } = options;
  try {
    const checked = checkSchema(node, asJson(output, path), path, await loadSchema(node, cwd));
    return { path, type: node.type, status: "completed", output: checked, attempts: 1 };
  } catch (error) {
    return buildFailedRecord(node, path, toFailure(error));
  }
};
