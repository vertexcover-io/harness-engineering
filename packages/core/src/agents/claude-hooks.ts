import { readFile } from "node:fs/promises";
import {
  type AgentAdapter,
  type HookDeps,
  NonEmptyStringSchema,
  type PreToolUseHandler,
  parseJson,
  type Result,
  type SessionStartHandler,
  type StopFailureHandler,
  type StopHandler,
  type ToolCall,
  type ToolUse,
  type TranscriptEntry,
} from "@harness/sdk";
import * as z from "zod";
import { parseStdin, preToolUseReply, runNoReplyHook, stopReply } from "../hooks/common.ts";
import { bashAntipatterns, recordGuard, runPreToolUse } from "../hooks/pre-tool-use.ts";
import { sessionStartHandlers } from "../hooks/session-start.ts";
import { continueWorkflow, runStop } from "../hooks/stop.ts";
import { resumeAfterLimit } from "../hooks/stop-failure.ts";
import { shellQuote } from "./common.ts";

const HOOK_TIMEOUT_S = 30;
// Claude's tools that write a file, and the input field that names it; Bash is parsed separately.
const PATH_FIELDS: ReadonlyMap<string, string> = new Map([
  ["Write", "file_path"],
  ["Edit", "file_path"],
  ["MultiEdit", "file_path"],
  ["NotebookEdit", "notebook_path"],
]);
// Claude Code saves a Stop hook's block reason back into the transcript as a user line.
const HOOK_FEEDBACK = "Stop hook feedback:";

const ClaudeStopInputSchema = z.looseObject({
  session_id: NonEmptyStringSchema,
  transcript_path: z.string().optional(),
});

const ClaudeSessionStartInputSchema = z.looseObject({
  session_id: NonEmptyStringSchema,
  source: NonEmptyStringSchema,
});

const ClaudeLineSchema = z.looseObject({
  type: z.string(),
  isMeta: z.boolean().optional(),
  origin: z.looseObject({ kind: z.string() }).optional(),
  message: z.looseObject({ content: z.unknown() }).optional(),
});
type ClaudeLine = z.infer<typeof ClaudeLineSchema>;

const BlockSchema = z.looseObject({ type: z.string() });
const TextBlockSchema = z.looseObject({ type: z.literal("text"), text: z.string() });
const BashCallSchema = z.looseObject({
  type: z.literal("tool_use"),
  name: z.literal("Bash"),
  input: z.looseObject({ command: z.string() }),
});

const blocksOf = (content: unknown): readonly z.infer<typeof BlockSchema>[] => {
  const parsed = z.array(BlockSchema).safeParse(content);
  return parsed.success ? parsed.data : [];
};

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : blocksOf(content)
        .flatMap((block) => {
          const text = TextBlockSchema.safeParse(block);
          return text.success ? [text.data.text] : [];
        })
        .join("\n");

const userEntries = (line: ClaudeLine): TranscriptEntry[] => {
  const content = line.message?.content;
  if (line.isMeta === true) return [];
  // A finished background task is written as a user line, but nobody typed it.
  if (line.origin?.kind === "task-notification") return [];
  if (blocksOf(content).some((block) => block.type === "tool_result")) return [];
  const text = textOf(content).trim();
  if (text === "" || text.startsWith(HOOK_FEEDBACK)) return [];
  return [{ kind: "prompt", text }];
};

const commandEntries = (line: ClaudeLine): TranscriptEntry[] =>
  blocksOf(line.message?.content).flatMap((block) => {
    const call = BashCallSchema.safeParse(block);
    return call.success ? [{ kind: "command" as const, command: call.data.input.command }] : [];
  });

const toEntries = (line: ClaudeLine): TranscriptEntry[] => {
  if (line.type === "user") return userEntries(line);
  if (line.type === "assistant") return commandEntries(line);
  return [];
};

const parseLine = (text: string): ClaudeLine[] => {
  const json = parseJson(text);
  const parsed = ClaudeLineSchema.safeParse(json.ok ? json.value : undefined);
  return parsed.success ? [parsed.data] : [];
};

// Claude keeps a session as JSONL; a line still being written or of another shape is skipped.
export const readClaudeTranscript = async (
  path: string | undefined,
): Promise<TranscriptEntry[] | undefined> => {
  if (path === undefined) return undefined;
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  return text
    .split("\n")
    .filter((raw) => raw.trim() !== "")
    .flatMap(parseLine)
    .flatMap(toEntries);
};

const claudeStop = async (stdin: string, deps: HookDeps, handler: StopHandler): Promise<string> => {
  const parsed = parseStdin(stdin, ClaudeStopInputSchema);
  if (!parsed.ok) {
    deps.log.warn({ error: parsed.error }, "stop allowed: hook input not understood");
    return "";
  }
  const { session_id: sessionId, transcript_path: transcriptPath } = parsed.value;
  const reply = await runStop(
    {
      agent: "claude",
      sessionId,
      contextSteps: true,
      readTranscript: () => readClaudeTranscript(transcriptPath),
    },
    handler,
    deps,
  );
  return stopReply(reply);
};

const claudeSessionStart = (
  stdin: string,
  deps: HookDeps,
  handler: SessionStartHandler,
): Promise<string> =>
  runNoReplyHook({
    stdin,
    deps,
    handler,
    event: "session-start",
    schema: ClaudeSessionStartInputSchema,
    toHandlerInput: ({ session_id: sessionId, source }) => ({
      agent: "claude" as const,
      sessionId,
      source,
    }),
  });

// last_assistant_message holds the error's text, e.g. "You've hit your limit · resets 3pm (UTC)".
const ClaudeStopFailureInputSchema = z.looseObject({
  session_id: NonEmptyStringSchema,
  error: NonEmptyStringSchema.default("unknown"),
  last_assistant_message: z.string().optional(),
});

const claudeStopFailure = (
  stdin: string,
  deps: HookDeps,
  handler: StopFailureHandler,
): Promise<string> =>
  runNoReplyHook({
    stdin,
    deps,
    handler,
    event: "stop-failure",
    schema: ClaudeStopFailureInputSchema,
    toHandlerInput: ({ session_id: sessionId, error, last_assistant_message: message }) => ({
      agent: "claude" as const,
      sessionId,
      error,
      // Claude reports a plan's session or weekly limit as rate_limit.
      usageLimit: error === "rate_limit",
      message,
    }),
  });

const ClaudePreToolUseInputSchema = z.looseObject({
  session_id: NonEmptyStringSchema,
  tool_name: NonEmptyStringSchema,
  tool_input: z.looseObject({}).default({}),
  cwd: z.string().optional(),
});

const OTHER_TOOL: ToolCall = { kind: "other" };

const toToolCall = (toolName: string, toolInput: Readonly<Record<string, unknown>>): ToolCall => {
  const { command } = toolInput;
  if (toolName === "Bash")
    return typeof command === "string" ? { kind: "shell", command } : OTHER_TOOL;
  const field = PATH_FIELDS.get(toolName);
  const path = field === undefined ? undefined : toolInput[field];
  return typeof path === "string" ? { kind: "file-write", path } : OTHER_TOOL;
};

const parsePreToolUseInput = (stdin: string): Result<ToolUse> => {
  const parsed = parseStdin(stdin, ClaudePreToolUseInputSchema);
  if (!parsed.ok) return parsed;
  const { session_id: sessionId, tool_name: toolName, tool_input: toolInput, cwd } = parsed.value;
  const call = toToolCall(toolName, toolInput);
  return {
    ok: true,
    value: { agent: "claude", sessionId, toolName, cwd: cwd ?? process.cwd(), call },
  };
};

const claudePreToolUse = async (
  stdin: string,
  deps: HookDeps,
  handler: PreToolUseHandler,
): Promise<string> => {
  const use = parsePreToolUseInput(stdin);
  if (!use.ok) {
    deps.log.warn({ error: use.error }, "pre-tool-use allowed: hook input not understood");
    return "";
  }
  return preToolUseReply(await runPreToolUse(use.value, handler, deps));
};

// What Claude answers; every event is supported.
export const claudeAdapter: AgentAdapter = {
  stop: claudeStop,
  preToolUse: claudePreToolUse,
  sessionStart: claudeSessionStart,
  stopFailure: claudeStopFailure,
};

// The handlers Claude registers. Each handler gets its own command in its entry, and Claude runs
// every matching command in parallel: a deny from any one refuses the call. Built on call, not at
// load: the stop hook imports context-step, which imports claude.ts and so this file, so whichever
// of them loads first, the handlers are not defined yet while this module evaluates.
const claudeHooks = () =>
  ({
    SessionStart: [{ handlers: Object.values(sessionStartHandlers) }],
    Stop: [{ handlers: [continueWorkflow] }],
    // Claude ends a turn with rate_limit when the plan's usage limit is hit.
    StopFailure: [{ matcher: "rate_limit", handlers: [resumeAfterLimit] }],
    PreToolUse: [
      { matcher: [...PATH_FIELDS.keys(), "Bash"].join("|"), handlers: [recordGuard] },
      { matcher: "Bash", handlers: [bashAntipatterns] },
    ],
  }) as const;

const hookEntry = (orchestrateArgv: readonly string[], event: string, handler: string) => ({
  type: "command",
  command: [...orchestrateArgv, "hook", event, "--agent", "claude", "--handler", handler]
    .map(shellQuote)
    .join(" "),
  timeout: HOOK_TIMEOUT_S,
});

const STATUSLINE_REFRESH_S = 5;

const statusLineEntry = (orchestrateArgv: readonly string[]) => ({
  type: "command",
  command: [...orchestrateArgv, "statusline"].map(shellQuote).join(" "),
  refreshInterval: STATUSLINE_REFRESH_S,
});

// Settings for `claude --settings`: the status line, and one hook command per registered handler,
// grouped by matcher.
export const claudeSettings = (orchestrateArgv: readonly string[]) => {
  const registered = claudeHooks();
  return {
    statusLine: statusLineEntry(orchestrateArgv),
    hooks: {
      SessionStart: registered.SessionStart.map(({ handlers }) => ({
        hooks: handlers.map((handler) => hookEntry(orchestrateArgv, "session-start", handler.name)),
      })),
      Stop: registered.Stop.map(({ handlers }) => ({
        hooks: handlers.map((handler) => hookEntry(orchestrateArgv, "stop", handler.name)),
      })),
      StopFailure: registered.StopFailure.map(({ matcher, handlers }) => ({
        matcher,
        hooks: handlers.map((handler) => hookEntry(orchestrateArgv, "stop-failure", handler.name)),
      })),
      PreToolUse: registered.PreToolUse.map(({ matcher, handlers }) => ({
        matcher,
        hooks: handlers.map((handler) => hookEntry(orchestrateArgv, "pre-tool-use", handler.name)),
      })),
    },
  };
};
