import * as z from "zod";
import type { Check } from "./check.ts";
import type { Result } from "./result.ts";

export const EffortSchema = z.enum(["low", "medium", "high", "max"]);
export type Effort = z.infer<typeof EffortSchema>;

export type Session =
  | { readonly mode: "new" }
  | { readonly mode: "resume" | "fork"; readonly id: string };

export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export type TerminalSpec = Readonly<{
  name: string;
  cwd: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
}>;

export interface ITerminal {
  readonly checks: readonly Check[];
  create(spec: TerminalSpec): Promise<Result<void>>;
  // typed literally, so words like "Enter" stay text
  sendText(name: string, text: string): Promise<Result<void>>;
  // key names such as "Enter", "Escape"
  sendKeys(name: string, keys: readonly string[]): Promise<Result<void>>;
  capture(name: string, lines?: number): Promise<Result<string>>;
  isAlive(name: string): Promise<boolean>;
  kill(name: string): Promise<Result<void>>;
  list(): Promise<readonly string[]>;
  attachCommand(name: string): readonly string[];
}

export const AgentTypeSchema = z.enum(["claude", "codex", "pi", "opencode"]);
export type AgentType = z.infer<typeof AgentTypeSchema>;

export type LaunchOptions = Readonly<{
  cwd: string;
  // first message, passed as the agent's positional argument
  prompt?: string;
  env?: Readonly<Record<string, string>>;
  // becomes --append-system-prompt
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  model?: string;
  effort?: Effort;
}>;

export type RunRequest<T = string> = {
  readonly prompt: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: Effort;
  readonly systemPrompt?: string;
  readonly outputFormat?: z.ZodType<T>;
  readonly session?: Session;
  readonly env?: Readonly<Record<string, string>>;
  readonly abortSignal?: AbortSignal;
};

// A failure can happen before the agent opens a session, so its sessionId is optional.
export type AgentResult<T = string> =
  | { readonly ok: true; readonly output: T; readonly sessionId: string }
  | { readonly ok: false; readonly error: Error; readonly sessionId?: string };

export interface IAgentProvider {
  readonly type: AgentType;
  readonly checks: readonly Check[];
  // interactive sessions never return a result
  launch(options: LaunchOptions): Promise<Result<{ sessionId: string }>>;
  prompt(sessionId: string, text: string): Promise<Result<void>>;
  stop(sessionId: string): Promise<Result<void>>;
  // headless: waits for the answer
  run<T = string>(request: RunRequest<T>): Promise<AgentResult<T>>;
}
