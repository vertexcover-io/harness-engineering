import { NonEmptyStringSchema } from "@harness/sdk";
import * as z from "zod";

export const QaOutputSchema = z
  .strictObject({
    status: z.enum(["PASS", "PARTIAL", "FAIL", "BLOCKED"]),
    reason: NonEmptyStringSchema.optional(),
    report: NonEmptyStringSchema.nullable(),
    gaps: z.array(
      z.strictObject({
        scenario: NonEmptyStringSchema,
        req: NonEmptyStringSchema,
        mechanism: NonEmptyStringSchema,
      }),
    ),
    bugs: z.array(
      z.strictObject({
        scenario: NonEmptyStringSchema,
        cause: NonEmptyStringSchema,
        fix: NonEmptyStringSchema,
        needsDecision: z.boolean(),
      }),
    ),
  })
  .refine((output) => output.status === "PASS" || output.reason !== undefined, {
    path: ["reason"],
    message: "reason is required unless status is PASS",
  })
  // A FAIL may defer its report to a later round and a BLOCKED pass drove nothing; any other
  // verdict without the report it rests on is unproven.
  .refine((output) => ["FAIL", "BLOCKED"].includes(output.status) || output.report !== null, {
    path: ["report"],
    message: "report is required when status is PASS or PARTIAL",
  })
  .refine((output) => output.status !== "FAIL" || output.bugs.length > 0, {
    path: ["bugs"],
    message: "a FAIL names at least one bug for the fix round",
  });

export const schemas = { "qa.output.v1": QaOutputSchema };
