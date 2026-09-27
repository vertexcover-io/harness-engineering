import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type JsonValue, JsonValueSchema } from "../contracts.ts";
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

const MAX_OUTPUT_BYTES = 1_048_576;

const aborted = (): NodeFailure => new NodeFailure("aborted", "run aborted");

const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // the group already exited
  }
};

export const runScript = (request: ScriptRequest): Promise<ScriptResult> =>
  new Promise((resolveResult, reject) => {
    const [command, args] =
      request.runtime === "sh" ? ["sh", ["-c", request.script]] : ["bun", ["-e", request.script]];
    const child = spawn(command, args, {
      cwd: request.cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: NodeFailure | undefined;
    const stop = (reason: NodeFailure): void => {
      if (failure !== undefined) return;
      failure = reason;
      killGroup(child.pid);
    };
    const collect = (sink: Buffer[]) => {
      let kept = 0;
      return (chunk: Buffer) => {
        const part = chunk.subarray(0, Math.max(0, MAX_OUTPUT_BYTES - kept));
        if (part.length === 0) return;
        sink.push(part);
        kept += part.length;
      };
    };
    const onAbort = (): void => stop(aborted());
    const timer =
      request.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () => stop(new NodeFailure("timeout", `timed out after ${request.timeoutMs}ms`)),
            request.timeoutMs,
          );
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", (error) => stop(new NodeFailure("exception", error.message)));
    child.on("close", (code) => {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", onAbort);
      if (failure !== undefined) return reject(failure);
      resolveResult({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 128,
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(request.input));
  });

export const importModule = async (
  modulePath: string,
  cwd: string,
): Promise<Record<string, unknown>> => {
  const file = isAbsolute(modulePath) ? modulePath : resolve(cwd, modulePath);
  if (!existsSync(file))
    throw new WorkflowError("missing-module", `module not found: ${file}`, modulePath);
  return import(pathToFileURL(file).href);
};

export const loadFunction = async (
  modulePath: string,
  functionName: string,
  cwd: string,
): Promise<WorkflowFunction> => {
  const exported = (await importModule(modulePath, cwd))[functionName];
  if (typeof exported !== "function") {
    throw new WorkflowError(
      "missing-export",
      `${modulePath} has no callable export "${functionName}"`,
      modulePath,
    );
  }
  return exported as WorkflowFunction;
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
            : new NodeFailure("exception", error instanceof Error ? error.message : String(error)),
        ),
      )
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      });
  });

export const asJson = (value: unknown, path: string): JsonValue => {
  const parsed = JsonValueSchema.safeParse(value);
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
