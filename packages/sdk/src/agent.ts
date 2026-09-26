import type * as z from "zod";

export type Effort = "low" | "medium" | "high" | "max";

export type Session =
  | { readonly mode: "new" }
  | { readonly mode: "resume" | "fork"; readonly id: string };

export type AgentRequest<T = string> = {
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

export type AgentProvider = {
  readonly type: string;
  readonly prompt: <T = string>(request: AgentRequest<T>) => Promise<AgentResult<T>>;
};
