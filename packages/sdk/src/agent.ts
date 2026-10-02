import * as z from "zod";
import type { Check } from "./check.ts";
import type { Result } from "./contracts.ts";

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

// One pane of a terminal: what an agent's screen is read from and typed into.
export interface ITerminal {
  // typed literally, so words like "Enter" stay text
  sendText(text: string): Promise<Result<void>>;
  // key names such as "Enter", "Escape"
  sendKeys(keys: readonly string[]): Promise<Result<void>>;
  capture(lines?: number): Promise<Result<string>>;
  isAlive(): Promise<boolean>;
  kill(): Promise<Result<void>>;
  // renames the session the pane belongs to
  rename(name: string): Promise<Result<void>>;
  // stops the program in the pane and starts another in the same pane
  respawn(spec: Omit<TerminalSpec, "name">): Promise<Result<void>>;
  attachCommand(): readonly string[];
}

// Where panes come from: it opens new ones and finds running ones by name.
export interface ITerminalHost {
  readonly checks: readonly Check[];
  create(spec: TerminalSpec): Promise<Result<ITerminal>>;
  // the active pane of the session named exactly `name`, whether or not it is running yet
  find(name: string): ITerminal;
  list(): Promise<readonly string[]>;
}

export type ResetWait = Readonly<{ ms: number; from: "message" | "screen" }>;

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
  // argv that runs the orchestrate script; the provider registers the agent's hooks and status
  // line as its subcommands
  orchestrateArgv?: readonly string[];
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
  // the new session and the pane it runs in
  launch(options: LaunchOptions): Promise<Result<{ sessionId: string; terminal: ITerminal }>>;
  // replaces the agent running in `terminal` with a new session on `sessionId`, in the same pane
  relaunch(terminal: ITerminal, sessionId: string, options: LaunchOptions): Promise<Result<void>>;
  prompt(terminal: ITerminal, text: string): Promise<Result<void>>;
  // how long until the usage limit that stopped the agent in `terminal` resets, read from its
  // error message or else its screen; null when neither names a time
  limitResetWait(terminal: ITerminal, message: string, now: Date): Promise<ResetWait | null>;
  // types `text` and submits it only at an empty input: a usage-limit menu is answered with
  // "wait" first, and Enter is never pressed into any other menu or dialog
  promptWhenReady(terminal: ITerminal, text: string): Promise<Result<"sent" | "not-ready">>;
  stop(terminal: ITerminal): Promise<Result<void>>;
  // headless: waits for the answer
  run<T = string>(request: RunRequest<T>): Promise<AgentResult<T>>;
}
