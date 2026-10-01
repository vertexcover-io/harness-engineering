import * as z from "zod";
import { type JsonValue, NonEmptyStringSchema } from "./contracts.ts";

// What a stage's verifier receives and returns, and how the engine records each run of one.
export const FindingSchema = z.strictObject({
  message: z.string().min(1),
  path: z.string().optional(),
  line: z.number().int().optional(),
  hint: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const VerifierErrorReasonSchema = z.enum(["threw", "timeout", "exit", "bad-output"]);

// One verifier's run inside a done call: how it ended, what it found, and how long it took.
export const VerifierRunSchema = z.strictObject({
  verifier: NonEmptyStringSchema,
  attempt: z.int().positive(),
  durationMs: z.number().nonnegative(),
  status: z.enum(["passed", "failed", "error"]),
  findings: z.array(FindingSchema),
  error: z.strictObject({ reason: VerifierErrorReasonSchema, message: z.string() }).optional(),
});
export type VerifierRun = z.infer<typeof VerifierRunSchema>;

export const VerifierResultSchema = z
  .strictObject({ pass: z.boolean(), findings: z.array(FindingSchema).default([]) })
  .refine((result) => result.pass || result.findings.length > 0, {
    path: ["findings"],
    message: "a failing result needs at least one finding",
  });
export type VerifierResult = z.infer<typeof VerifierResultSchema>;

export type VerifierInput = Readonly<{
  run: string;
  nodeRunId: string;
  output: JsonValue;
  artifacts: Readonly<Record<string, string>>;
  args: JsonValue;
}>;
