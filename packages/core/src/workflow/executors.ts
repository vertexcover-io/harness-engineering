import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type JsonValue, type ProcessRecord, spawn } from "@yok/sdk";
import {
  loadFunction as loadSdkFunction,
  importModule as sdkImportModule,
  selfArgv,
} from "@yok/sdk/internal";
import { z } from "zod";
import { type NodeContext, NodeFailure, WorkflowError, type WorkflowFunction } from "./types.ts";

export type ScriptRequest = Readonly<{
  runtime: "sh" | "bun";
  script: string;
  input: JsonValue;
  cwd: string;
  // Where a bun script is written before `yok orchestrate script` runs it: the run's scripts/ folder.
  scriptDir: string;
  timeoutMs: number | undefined;
}>;

export const MAX_OUTPUT_BYTES = 1_048_576;

// Named by its text, so two scripts never share a file. Another exec may be loading the same
// file right now, so it is replaced whole by a rename and never seen half-written.
const writeScript = async (dir: string, script: string): Promise<string> => {
  const name = createHash("sha256").update(script).digest("hex").slice(0, 16);
  const file = join(dir, `${name}.ts`);
  const temp = join(dir, `${name}.${randomUUID()}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(temp, script);
  await rename(temp, file);
  return file;
};

export const runScript = async (request: ScriptRequest): Promise<ProcessRecord> => {
  const argv: readonly [string, ...string[]] =
    request.runtime === "sh"
      ? ["sh", "-c", request.script]
      : [
          ...selfArgv(),
          "orchestrate",
          "script",
          await writeScript(request.scriptDir, request.script),
        ];
  const result = await spawn(argv[0], argv.slice(1), {
    cwd: request.cwd,
    input: JSON.stringify(request.input),
    maxOutputBytes: MAX_OUTPUT_BYTES,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
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

// Runs `work` with a signal that aborts once `timeoutMs` passes, and fails it with a timeout then.
export const withTimeout = <T>(
  work: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> =>
  new Promise((resolveWork, reject) => {
    const attempt = new AbortController();
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            attempt.abort();
            reject(new NodeFailure("timeout", `timed out after ${timeoutMs}ms`));
          }, timeoutMs);
    Promise.resolve(attempt.signal)
      .then(work)
      .then(resolveWork, reject)
      .finally(() => clearTimeout(timer));
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
  context: Omit<NodeContext, "signal">,
  timeoutMs: number | undefined,
): Promise<JsonValue> =>
  asJson(await withTimeout((signal) => fn(input, { ...context, signal }), timeoutMs), context.path);
