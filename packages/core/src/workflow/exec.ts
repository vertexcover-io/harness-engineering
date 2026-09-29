import { resolve } from "node:path";
import { type JsonValue, type ProcessRecord, stackOf } from "@harness/sdk";
import { callFunction, loadFunction, runScript } from "./executors.ts";
import {
  type NodeContext,
  NodeFailure,
  type NodeRecord,
  type PlanExecNode,
  type WaitNode,
  type WorkflowFunction,
} from "./types.ts";

type SchemaLike = {
  safeParse: (value: unknown) => { success: boolean; error?: { message: string } };
};

// A node's loaded output schema, with the name its validation failures report.
type OutputSchema = Readonly<{ name: string; schema: SchemaLike }>;

// What one exec node needs for every attempt: its function and output schema are loaded once.
type ExecRun = Readonly<{
  node: PlanExecNode;
  input: JsonValue;
  path: string;
  cwd: string;
  fn: WorkflowFunction | undefined;
  schema: OutputSchema | undefined;
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

const buildFailedRecord = (node: PlanExecNode, path: string, failure: NodeFailure): NodeRecord => ({
  path,
  type: node.type,
  status: "failed",
  attempts: 1,
  error: { kind: failure.kind, message: failure.message, stack: stackOf(failure) },
  ...(failure.process === undefined ? {} : { process: failure.process }),
});

const checkOutput = (
  output: JsonValue,
  path: string,
  schema: OutputSchema | undefined,
): JsonValue => {
  if (schema === undefined) return output;
  const result = schema.schema.safeParse(output);
  if (result.success) return output;
  throw new NodeFailure(
    "validation",
    `${path} output does not match ${schema.name}: ${result.error?.message ?? ""}`,
  );
};

const parseJson = (stdout: string, path: string): JsonValue => {
  try {
    return JSON.parse(stdout.trim()) as JsonValue;
  } catch {
    throw new NodeFailure("validation", `${path} printed stdout that is not JSON`);
  }
};

// What one attempt gave: the node's output and, for a script, the process that produced it.
type Attempted = Readonly<{ output: JsonValue; process?: ProcessRecord }>;

const scriptOutput = (run: ExecRun, result: ProcessRecord): JsonValue => {
  const { path, schema } = run;
  if (result.exitCode !== 0)
    throw new NodeFailure("exit", `${path} exited with code ${result.exitCode}`);
  if (schema === undefined) return result.stdout;
  return checkOutput(parseJson(result.stdout, path), path, schema);
};

// Any failure after the script ran keeps its process record, so the event log shows what it printed.
const runScriptNode = async (
  run: ExecRun,
  context: Omit<NodeContext, "signal">,
): Promise<Attempted> => {
  const { node } = run;
  if (node.runtime === undefined || node.script === undefined)
    throw new NodeFailure("exception", `${context.path} has no script to run`);
  const result = await runScript({
    runtime: node.runtime,
    script: node.script,
    input: run.input,
    cwd: context.cwd,
    timeoutMs: node.timeoutMs,
  });
  try {
    return { output: scriptOutput(run, result), process: result };
  } catch (error) {
    const failure = toFailure(error);
    throw new NodeFailure(failure.kind, failure.message, result, { cause: error });
  }
};

const attempt = async (run: ExecRun, number: number): Promise<Attempted> => {
  const { node, input, path } = run;
  const context = { path, cwd: resolve(run.cwd, node.cwd ?? "."), attempt: number };
  if (run.fn === undefined) return runScriptNode(run, context);
  const output = await callFunction(run.fn, input, context, node.timeoutMs);
  return { output: checkOutput(output, path, run.schema) };
};

// Output that fails its schema is not retried: running the same code again gives the same output.
const runExec = async (run: ExecRun, number = 1): Promise<NodeRecord> => {
  const { node, path } = run;
  try {
    const attempted = await attempt(run, number);
    return { path, type: node.type, status: "completed", ...attempted, attempts: number };
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
  node: PlanExecNode | WaitNode,
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
    const schema =
      node.outputSchema === undefined
        ? undefined
        : { name: node.output?.zodSchema ?? "Json", schema: node.outputSchema };
    return await runExec({ node, input, path, cwd: resolve(cwd), fn, schema });
  } catch (error) {
    return buildFailedRecord(node, path, toFailure(error));
  }
};
