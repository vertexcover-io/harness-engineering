import type { AgentType } from "./agent.ts";
import type { Event, State } from "./contracts.ts";
import type { AnsweredQuestion, AskedQuestion, RunRef } from "./events.ts";
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
  // whether the harness can restart or compact the agent in its pane: context nodes, model switches
  contextSteps: boolean;
  stop?: (stdin: string, deps: HookDeps, handler: StopHandler) => Promise<string>;
  sessionStart?: (stdin: string, deps: HookDeps, handler: SessionStartHandler) => Promise<string>;
  preToolUse?: (stdin: string, deps: HookDeps, handler: PreToolUseHandler) => Promise<string>;
  postToolUse?: (stdin: string, deps: HookDeps, handler: PostToolUseHandler) => Promise<string>;
  stopFailure?: (stdin: string, deps: HookDeps, handler: StopFailureHandler) => Promise<string>;
}>;

export type HookReply =
  | { readonly kind: "allow" }
  | { readonly kind: "continue"; readonly message: string };
// One step of a session, in order: a message the user typed, a shell command the agent ran, or a
// background task (a command or a helper agent) starting or reporting back.
export type TranscriptEntry =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "command"; readonly command: string }
  | { readonly kind: "task-started"; readonly id: string }
  | { readonly kind: "task-ended"; readonly id: string };

export type StopInput = Readonly<{
  agent: AgentType;
  sessionId: string;
  // whether the agent can start a new session or compact in its pane for a context node
  contextSteps: boolean;
  // undefined when the transcript is missing or cannot be read
  readTranscript: () => Promise<readonly TranscriptEntry[] | undefined>;
}>;

// One rule for the end of a turn, shared by every agent: it sees only the parsed input.
export type StopHandler = Readonly<{
  name: string;
  run: (input: StopInput, deps: HookDeps) => Promise<HookReply>;
}>;

// A tool call as any agent's adapter parses it: a file it writes, a shell command, questions
// for the person, or none of these.
export type ToolCall =
  | { readonly kind: "file-write"; readonly path: string }
  | { readonly kind: "shell"; readonly command: string }
  | { readonly kind: "question"; readonly questions: readonly AskedQuestion[] }
  | { readonly kind: "other" };

export type ToolUse = Readonly<{
  agent: AgentType;
  sessionId: string;
  // the agent's own name for the tool, e.g. Bash; only logged
  toolName: string;
  // the agent's id for this call, when it gives one
  toolUseId?: string;
  cwd: string;
  call: ToolCall;
}>;

export type ToolVerdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly message: string; readonly path?: string };

// One rule for a tool call, shared by every agent: it sees only the parsed input.
export type PreToolUseHandler = Readonly<{
  name: string;
  run: (use: ToolUse, deps: HookDeps) => Promise<ToolVerdict>;
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

export type StopFailureInput = Readonly<{
  agent: AgentType;
  sessionId: string;
  error: string;
  // set by the agent's adapter, which knows its own error names
  usageLimit: boolean;
  message: string | undefined;
}>;

// The agent ignores this hook's answer, so a handler only observes.
export type StopFailureHandler = Readonly<{
  name: string;
  run: (input: StopFailureInput, deps: HookDeps) => Promise<void>;
}>;

// What a tool call returned, as any agent's adapter parses it: the person's answers, or neither.
export type ToolResult =
  | { readonly kind: "answers"; readonly answers: readonly AnsweredQuestion[] }
  | { readonly kind: "other" };

export type PostToolUseInput = Readonly<{
  agent: AgentType;
  sessionId: string;
  toolName: string;
  toolUseId?: string;
  result: ToolResult;
}>;

// The agent ignores this hook's answer, so a handler only observes.
export type PostToolUseHandler = Readonly<{
  name: string;
  run: (input: PostToolUseInput, deps: HookDeps) => Promise<void>;
}>;

// What a run hook receives: the event it listens to, the run's state once the event is applied,
// and the run itself, to store events of its own (custom.state.updated keeps values between calls).
export type HookInput = Readonly<{ event: Event; state: State; run: RunRef }>;

// A run hook module's export. What it returns, as JSON, is recorded as the call's output.
export type RunHook = (input: HookInput) => unknown;
