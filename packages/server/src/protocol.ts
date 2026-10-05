import { isAbsolute, join } from "node:path";
import { WorkflowAgentSchema } from "@yok/core";
import { JsonObjectSchema, SlugSchema, TiersConfigSchema, yokHome } from "@yok/sdk";
import * as z from "zod";

export const socketPath = (home: string = yokHome()): string => join(home, "yok.sock");
export const pidPath = (home: string = yokHome()): string => join(home, "server.pid");
export const logPath = (home: string = yokHome()): string => join(home, "server.log");

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), "must be an absolute path");

export const ErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(["bad-request", "not-found", "conflict", "agent-failed", "internal"]),
    message: z.string(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;
export type ErrorCode = ErrorBody["error"]["code"];

export const StartRunBodySchema = z.strictObject({
  workflow: SlugSchema,
  workflowPath: AbsolutePathSchema,
  inputs: JsonObjectSchema,
  cwd: AbsolutePathSchema,
  name: SlugSchema.optional(),
  agent: WorkflowAgentSchema.default("claude"),
  // the workflow's tiers, merged over the built-in and the config's into the run's tier set
  tiers: TiersConfigSchema.default({}),
  // the env the session starts with, which yok run builds from the project's .env, the config
  // and the workflow; required, so a caller that forgets it is refused rather than run without it
  env: z.record(z.string(), z.string()),
  // the config file yok run --config named; the run reads it instead of its checkout's
  config: AbsolutePathSchema.optional(),
});
export type StartRunBody = z.infer<typeof StartRunBodySchema>;
// What a caller sends: agent may be left out
export type StartRunRequest = z.input<typeof StartRunBodySchema>;

export type ApiError = ErrorBody["error"];
