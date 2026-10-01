import { join } from "node:path";
import {
  FindingSchema,
  VerifierErrorReasonSchema,
  type VerifierInput,
  type VerifierResult,
  VerifierResultSchema,
  type VerifierRun,
} from "@harness/sdk";
import { z } from "zod";
import type { Verifier } from "../stage.ts";
import { callFunction, loadFunction, runScript } from "./executors.ts";
import { NodeFailure, type PlanVerifier } from "./types.ts";

export const VerifierIssueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("verifier"),
    verifier: z.string(),
    findings: z.array(FindingSchema),
  }),
  z.strictObject({
    kind: z.literal("verifier-error"),
    verifier: z.string(),
    reason: VerifierErrorReasonSchema,
    message: z.string(),
  }),
]);
export type VerifierIssue = z.infer<typeof VerifierIssueSchema>;

export const loadVerifiers = async (
  verifiers: readonly Verifier[],
  stageDir: string,
): Promise<readonly PlanVerifier[]> =>
  Promise.all(
    verifiers.map(async (verifier): Promise<PlanVerifier> => {
      const { id, args, timeoutMs } = verifier;
      if ("module" in verifier) {
        const fn = await loadFunction(verifier.module, verifier.functionName, stageDir);
        return { id, args, timeoutMs, kind: "function", fn };
      }
      const { runtime, script } = verifier;
      return { id, args, timeoutMs, kind: "script", runtime, script };
    }),
  );

const errorIssue = (
  verifier: string,
  reason: Extract<VerifierIssue, { kind: "verifier-error" }>["reason"],
  message: string,
): VerifierIssue => ({ kind: "verifier-error", verifier, reason, message });

const firstLines = (text: string): string => text.trim().split("\n").slice(0, 5).join("\n");

const parseResult = (verifier: string, value: unknown): VerifierResult | VerifierIssue => {
  const parsed = VerifierResultSchema.safeParse(value);
  return parsed.success
    ? parsed.data
    : errorIssue(verifier, "bad-output", z.prettifyError(parsed.error));
};

const parseStdout = (verifier: string, stdout: string): VerifierResult | VerifierIssue => {
  try {
    return parseResult(verifier, JSON.parse(stdout));
  } catch {
    return errorIssue(verifier, "bad-output", `stdout is not JSON: ${firstLines(stdout)}`);
  }
};

const execute = async (
  verifier: PlanVerifier,
  input: VerifierInput,
  cwd: string,
  attempt: number,
): Promise<VerifierResult | VerifierIssue> => {
  const { id, timeoutMs } = verifier;
  if (verifier.kind === "function") {
    const context = { path: input.nodeRunId, cwd, attempt };
    return parseResult(id, await callFunction(verifier.fn, input, context, timeoutMs));
  }
  const { runtime, script } = verifier;
  const record = await runScript({ runtime, script, input, cwd, timeoutMs });
  if (record.exitCode !== 0) {
    return errorIssue(id, "exit", `exit ${record.exitCode}: ${firstLines(record.stderr)}`);
  }
  return parseStdout(id, record.stdout);
};

const toRun = (
  verifier: string,
  attempt: number,
  durationMs: number,
  ended: VerifierResult | VerifierIssue,
): VerifierRun => {
  const base = { verifier, attempt, durationMs };
  if (!("kind" in ended)) {
    return { ...base, status: ended.pass ? "passed" : "failed", findings: ended.findings };
  }
  if (ended.kind === "verifier") return { ...base, status: "failed", findings: ended.findings };
  const error = { reason: ended.reason, message: ended.message };
  return { ...base, status: "error", findings: [], error };
};

const endVerifier = async (
  verifier: PlanVerifier,
  input: VerifierInput,
  cwd: string,
  attempt: number,
): Promise<VerifierResult | VerifierIssue> => {
  try {
    return await execute(verifier, input, cwd, attempt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof NodeFailure) {
      return errorIssue(
        verifier.id,
        error.kind === "validation" ? "bad-output" : "timeout",
        message,
      );
    }
    return errorIssue(verifier.id, "threw", message);
  }
};

const runOne = async (
  verifier: PlanVerifier,
  input: Omit<VerifierInput, "args">,
  cwd: string,
  attempt: number,
): Promise<VerifierRun> => {
  const started = performance.now();
  const ended = await endVerifier(verifier, { ...input, args: verifier.args }, cwd, attempt);
  return toRun(verifier.id, attempt, Math.round(performance.now() - started), ended);
};

// Runs every verifier at once; the runs come back in the order the stage lists the verifiers.
export const runVerifiers = (
  verifiers: readonly PlanVerifier[],
  input: Omit<VerifierInput, "args">,
  cwd: string,
  attempt: number,
): Promise<readonly VerifierRun[]> =>
  Promise.all(verifiers.map((verifier) => runOne(verifier, input, cwd, attempt)));

// What a done is rejected with: one issue per verifier that failed or errored.
export const issuesOf = (runs: readonly VerifierRun[]): readonly VerifierIssue[] =>
  runs.flatMap((run): VerifierIssue[] => {
    if (run.status === "passed") return [];
    if (run.error === undefined) {
      return [{ kind: "verifier", verifier: run.verifier, findings: run.findings }];
    }
    return [{ kind: "verifier-error", verifier: run.verifier, ...run.error }];
  });

export const artifactPaths = (
  runDir: string,
  refs: readonly Readonly<{ name: string; path: string }>[],
): Record<string, string> =>
  Object.fromEntries(refs.map((ref) => [ref.name, join(runDir, ref.path)]));
