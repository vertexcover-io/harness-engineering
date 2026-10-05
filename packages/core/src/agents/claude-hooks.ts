import { readFile } from "node:fs/promises";
import {
  type AgentAdapter,
  type HookDeps,
  NonEmptyStringSchema,
  type PostToolUseHandler,
  type PreToolUseHandler,
  parseJson,
  type Result,
  type SessionStartHandler,
  type StopFailureHandler,
  type StopHandler,
  type ToolCall,
  type ToolResult,
  type ToolUse,
  type TranscriptEntry,
} from "@yok/sdk";
import * as z from "zod";
import { parseStdin, preToolUseReply, runNoReplyHook, stopReply } from "../hooks/common.ts";
import { answerNotice } from "../hooks/post-tool-use.ts";
import {
  bashAntipatterns,
  questionNotice,
  recordGuard,
  runPreToolUse,
} from "../hooks/pre-tool-use.ts";
import { sessionStartHandlers } from "../hooks/session-start.ts";
import { continueWorkflow, runStop } from "../hooks/stop.ts";
import { recordAgentError, resumeAfterLimit } from "../hooks/stop-failure.ts";
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
      contextSteps: claudeAdapter.contextSteps,
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
  tool_use_id: NonEmptyStringSchema.optional(),
  cwd: z.string().optional(),
});

const OTHER_TOOL: ToolCall = { kind: "other" };

const QuestionInputSchema = z.looseObject({
  questions: z
    .array(
      z.looseObject({
        question: NonEmptyStringSchema,
        header: z.string().optional(),
        options: z.array(z.looseObject({ label: z.string() })).default([]),
      }),
    )
    .min(1),
});

const parseQuestionCall = (toolInput: Readonly<Record<string, unknown>>): ToolCall => {
  const parsed = QuestionInputSchema.safeParse(toolInput);
  if (!parsed.success) return OTHER_TOOL;
  const questions = parsed.data.questions.map(({ question, header, options }) => ({
    question,
    ...(header === undefined ? {} : { header }),
    options: options.map((option) => option.label),
  }));
  return { kind: "question", questions };
};

const toToolCall = (toolName: string, toolInput: Readonly<Record<string, unknown>>): ToolCall => {
  const { command } = toolInput;
  if (toolName === "Bash")
    return typeof command === "string" ? { kind: "shell", command } : OTHER_TOOL;
  if (toolName === "AskUserQuestion") return parseQuestionCall(toolInput);
  const field = PATH_FIELDS.get(toolName);
  const path = field === undefined ? undefined : toolInput[field];
  return typeof path === "string" ? { kind: "file-write", path } : OTHER_TOOL;
};

const parsePreToolUseInput = (stdin: string): Result<ToolUse> => {
  const parsed = parseStdin(stdin, ClaudePreToolUseInputSchema);
  if (!parsed.ok) return parsed;
  const {
    session_id: sessionId,
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseId,
    cwd,
  } = parsed.value;
  const call = toToolCall(toolName, toolInput);
  return {
    ok: true,
    value: {
      agent: "claude",
      sessionId,
      toolName,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      cwd: cwd ?? process.cwd(),
      call,
    },
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

const ClaudePostToolUseInputSchema = z.looseObject({
  session_id: NonEmptyStringSchema,
  tool_name: NonEmptyStringSchema,
  tool_input: z.looseObject({}).default({}),
  tool_response: z.unknown().optional(),
  tool_use_id: NonEmptyStringSchema.optional(),
});
type ClaudePostToolUseInput = z.infer<typeof ClaudePostToolUseInputSchema>;

// A multi-select question is answered with every picked label.
const AnswersSchema = z.looseObject({
  answers: z.record(
    z.string(),
    z.union([z.string(), z.array(z.string()).transform((picked) => picked.join(", "))]),
  ),
});
const AnnotationsSchema = z.looseObject({
  annotations: z.record(z.string(), z.looseObject({ notes: z.string().optional() })),
});

// A real transcript shows the answers in the tool result (tool_response); tool_input is read first
// in case Claude adds them there too.
const readAnswers = <T>(
  schema: z.ZodType<T>,
  { tool_input, tool_response }: ClaudePostToolUseInput,
): T | undefined => schema.safeParse(tool_input).data ?? schema.safeParse(tool_response).data;

const toToolResult = (input: ClaudePostToolUseInput): ToolResult => {
  if (input.tool_name !== "AskUserQuestion") return { kind: "other" };
  const asked = QuestionInputSchema.safeParse(input.tool_input);
  if (!asked.success) return { kind: "other" };
  const answers = new Map(Object.entries(readAnswers(AnswersSchema, input)?.answers ?? {}));
  const annotations = new Map(
    Object.entries(readAnswers(AnnotationsSchema, input)?.annotations ?? {}),
  );
  const answered = asked.data.questions.flatMap(({ question }) => {
    const answer = answers.get(question);
    if (answer === undefined) return [];
    const notes = annotations.get(question)?.notes;
    return [{ question, answer, ...(notes ? { notes } : {}) }];
  });
  return answered.length === 0 ? { kind: "other" } : { kind: "answers", answers: answered };
};

const claudePostToolUse = (
  stdin: string,
  deps: HookDeps,
  handler: PostToolUseHandler,
): Promise<string> =>
  runNoReplyHook({
    stdin,
    deps,
    handler,
    event: "post-tool-use",
    schema: ClaudePostToolUseInputSchema,
    toHandlerInput: (input) => ({
      agent: "claude" as const,
      sessionId: input.session_id,
      toolName: input.tool_name,
      ...(input.tool_use_id === undefined ? {} : { toolUseId: input.tool_use_id }),
      result: toToolResult(input),
    }),
  });

// What Claude answers; every event is supported.
export const claudeAdapter: AgentAdapter = {
  contextSteps: true,
  stop: claudeStop,
  preToolUse: claudePreToolUse,
  postToolUse: claudePostToolUse,
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
    StopFailure: [
      { matcher: "rate_limit", handlers: [resumeAfterLimit] },
      { matcher: "*", handlers: [recordAgentError] },
    ],
    PreToolUse: [
      { matcher: [...PATH_FIELDS.keys(), "Bash"].join("|"), handlers: [recordGuard] },
      { matcher: "Bash", handlers: [bashAntipatterns] },
      { matcher: "AskUserQuestion", handlers: [questionNotice] },
    ],
    PostToolUse: [{ matcher: "AskUserQuestion", handlers: [answerNotice] }],
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
      PostToolUse: registered.PostToolUse.map(({ matcher, handlers }) => ({
        matcher,
        hooks: handlers.map((handler) => hookEntry(orchestrateArgv, "post-tool-use", handler.name)),
      })),
    },
  };
};
