import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { JsonObjectSchema, NonEmptyStringSchema, SlugSchema } from "@harness/core";
import { AgentTypeSchema } from "@harness/sdk";
import * as z from "zod";

export const harnessHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.HARNESS_HOME ?? join(homedir(), ".harness");

export const socketPath = (home: string = harnessHome()): string => join(home, "harness.sock");
export const registryPath = (home: string = harnessHome()): string => join(home, "registry.json");
export const pidPath = (home: string = harnessHome()): string => join(home, "server.pid");
export const logPath = (home: string = harnessHome()): string => join(home, "server.log");

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => isAbsolute(value), "must be an absolute path");

export const SessionRefSchema = z.strictObject({
  agent: AgentTypeSchema,
  // also the tmux session name
  sessionId: NonEmptyStringSchema,
});

export const WorkflowRunSchema = z.strictObject({
  id: NonEmptyStringSchema,
  workflow: SlugSchema,
  workflowPath: NonEmptyStringSchema,
  inputs: JsonObjectSchema,
  cwd: NonEmptyStringSchema,
  // agent sessions of this run, first = the one start run launched
  sessions: z.array(SessionRefSchema),
  // Set by init; the run's folder is CWD/.harness/NAME.
  name: SlugSchema.nullable(),
  createdAt: z.iso.datetime(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type SessionRef = z.infer<typeof SessionRefSchema>;

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
});
export type StartRunBody = z.infer<typeof StartRunBodySchema>;

export const InitBodySchema = z.strictObject({ name: SlugSchema });
export type InitBody = z.infer<typeof InitBodySchema>;

export type ApiError = ErrorBody["error"];
