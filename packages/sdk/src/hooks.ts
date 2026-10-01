import type { AgentType } from "./agent.ts";
import type { ILogger } from "./logger.ts";
import type { RegistryReader } from "./registry.ts";

export type HookDeps = Readonly<{
  registry: RegistryReader;
  env: Readonly<Record<string, string | undefined>>;
  log: ILogger;
}>;

// What one agent answers: each takes the agent's raw hook input and the handler it was registered
// with, and returns the text to print. A hook the agent lacks prints nothing.
export type AgentAdapter = Readonly<{
  stop?: (stdin: string, deps: HookDeps, handler: StopHandler) => Promise<string>;
  sessionStart?: (stdin: string, deps: HookDeps, handler: SessionStartHandler) => Promise<string>;
  preToolUse?: (stdin: string, deps: HookDeps, handler: PreToolUseHandler) => Promise<string>;
}>;

export type HookReply =
  | { readonly kind: "allow" }
  | { readonly kind: "continue"; readonly message: string };
// One step of a session, in order: a message the user typed, or a shell command the agent ran.
export type TranscriptEntry =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "command"; readonly command: string };

export type StopInput = Readonly<{
  agent: AgentType;
  sessionId: string;
  // undefined when the transcript is missing or cannot be read
  readTranscript: () => Promise<readonly TranscriptEntry[] | undefined>;
}>;

// One rule for the end of a turn, shared by every agent: it sees only the parsed input.
export type StopHandler = Readonly<{
  name: string;
  run: (input: StopInput, deps: HookDeps) => Promise<HookReply>;
}>;

// A tool call as any agent's adapter parses it: a file it writes, a shell command, or neither.
export type ToolCall =
  | { readonly kind: "file-write"; readonly path: string }
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "other" };

export type ToolUse = Readonly<{
  agent: AgentType;
  sessionId: string;
  // the agent's own name for the tool, e.g. Bash; only logged
  toolName: string;
  cwd: string;
  call: ToolCall;
}>;

export type ToolVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly message: string; readonly path?: string };

export type PreToolUseContext = Readonly<{ cwd: string; env: HookDeps["env"]; log: ILogger }>;

// One rule for a tool call, shared by every agent: it sees only the parsed call.
export type PreToolUseHandler = Readonly<{
  name: string;
  run: (call: ToolCall, context: PreToolUseContext) => Promise<ToolVerdict>;
}>;

export type SessionStartInput = Readonly<{
  agent: AgentType;
  sessionId: string;
  // why the session started: startup, clear, compact or resume
  source: string;
}>;

// One rule for a session starting, shared by every agent: it sees only the parsed input.
export type SessionStartHandler = Readonly<{
  name: string;
  run: (input: SessionStartInput, deps: HookDeps) => Promise<void>;
}>;
