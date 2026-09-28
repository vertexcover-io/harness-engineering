import { resolve } from "node:path";
import {
  type JsonValue,
  loadFunction as loadSdkFunction,
  importModule as sdkImportModule,
  spawn,
} from "@harness/sdk";
import { z } from "zod";
import {
  type AgentAdapter,
  type AgentNode,
  type NodeContext,
  NodeFailure,
  WorkflowError,
  type WorkflowFunction,
} from "./types.ts";

export type ScriptResult = { stdout: string; stderr: string; exitCode: number };

export type ScriptRequest = Readonly<{
  runtime: "sh" | "bun";
  script: string;
  input: JsonValue;
  cwd: string;
  timeoutMs: number | undefined;
  signal: AbortSignal;
}>;

export const MAX_OUTPUT_BYTES = 1_048_576;

const aborted = (): NodeFailure => new NodeFailure("aborted", "run aborted");

export const runScript = async (request: ScriptRequest): Promise<ScriptResult> => {
  const [command, args] =
    request.runtime === "sh" ? ["sh", ["-c", request.script]] : ["bun", ["-e", request.script]];
  const result = await spawn(command, args, {
    cwd: request.cwd,
    input: JSON.stringify(request.input),
    signal: request.signal,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
  if (result.stopped === "aborted") throw aborted();
  if (result.stopped === "timeout") {
    throw new NodeFailure("timeout", `timed out after ${request.timeoutMs}ms`);
  }
  return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code };
};

export const importModule = async (
  modulePath: string,
  cwd: string,
): Promise<Record<string, unknown>> => {
  const loaded = await sdkImportModule(resolve(cwd, modulePath));
  if (!loaded.ok) {
    const { kind, message, cause } = loaded.error;
    throw new WorkflowError(kind, message, modulePath, { cause });
  }
  return loaded.value;
};

export const loadFunction = async (
  modulePath: string,
  functionName: string,
  cwd: string,
): Promise<WorkflowFunction> => {
  const loaded = await loadSdkFunction<WorkflowFunction>(resolve(cwd, modulePath), functionName);
  if (!loaded.ok) {
    const { kind, message, cause } = loaded.error;
    throw new WorkflowError(kind, message, modulePath, { cause });
  }
  return loaded.value;
};

export const withTimeout = <T>(
  work: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal,
): Promise<T> =>
  new Promise((resolveWork, reject) => {
    if (signal.aborted) return reject(aborted());
    const attempt = new AbortController();
    const stop = (reason: NodeFailure): void => {
      attempt.abort();
      reject(reason);
    };
    const onAbort = (): void => stop(aborted());
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => stop(new NodeFailure("timeout", `timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(attempt.signal)
      .then(work)
      .then(resolveWork, (error: unknown) =>
        reject(
          error instanceof NodeFailure
            ? error
            : new NodeFailure(
                "exception",
                error instanceof Error ? error.message : String(error),
                undefined,
                { cause: error },
              ),
        ),
      )
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      });
  });

export const asJson = (value: unknown, path: string): JsonValue => {
  const parsed = z.json().safeParse(value);
  if (!parsed.success)
    throw new NodeFailure("validation", `${path} returned a value that is not JSON`);
  return parsed.data;
};

export const callFunction = async (
  fn: WorkflowFunction,
  input: JsonValue,
  context: NodeContext,
  timeoutMs: number | undefined,
): Promise<JsonValue> =>
  asJson(
    await withTimeout((signal) => fn(input, { ...context, signal }), timeoutMs, context.signal),
    context.path,
  );

export const runAgent = async (
  adapter: AgentAdapter,
  node: AgentNode,
  input: JsonValue,
  context: NodeContext,
): Promise<JsonValue> => {
  const request = (signal: AbortSignal) => ({
    input,
    context: { ...context, signal },
    ...(node.stage === undefined ? {} : { stage: node.stage }),
    ...(node.prompt === undefined ? {} : { prompt: node.prompt }),
  });
  return asJson(
    await withTimeout((signal) => adapter.run(request(signal)), node.timeoutMs, context.signal),
    context.path,
  );
};
