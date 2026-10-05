import { readFile } from "node:fs/promises";
import {
  type AgentAdapter,
  type HookDeps,
  NonEmptyStringSchema,
  type PreToolUseHandler,
  parseJson,
  type Result,
  type SessionStartHandler,
  type StopHandler,
  type ToolCall,
  type ToolUse,
  type ToolVerdict,
  type TranscriptEntry,
} from "@yok/sdk";
import * as z from "zod";
import { parseStdin, preToolUseReply, runNoReplyHook, stopReply } from "../hooks/common.ts";
import { recordGuard, runPreToolUse } from "../hooks/pre-tool-use.ts";
import { sessionStartHandlers } from "../hooks/session-start.ts";
import { continueWorkflow, runStop } from "../hooks/stop.ts";
import { shellQuote } from "./common.ts";

const HOOK_TIMEOUT_S = 30;
const SHELL_TOOLS = ["Bash", "shell", "exec_command", "local_shell"] as const;
const PATCH_TOOL = "apply_patch";

const CodexStopInputSchema = z.looseObject({
  session_id: NonEmptyStringSchema,
  transcript_path: z.string().nullish(),
});

const CodexSessionStartInputSchema = z.looseObject({
  session_id: NonEmptyStringSchema,
  source: NonEmptyStringSchema,
});

const CodexPreToolUseInputSchema = z.looseObject({
  session_id: NonEmptyStringSchema,
  tool_name: NonEmptyStringSchema,
  tool_input: z.looseObject({}).default({}),
  cwd: z.string().optional(),
});

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

const patchPaths = (patch: string): string[] =>
  [...patch.matchAll(PATCH_PATH)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1].trim()],
  );

// Codex's shell tools name the command `command` or `cmd`, as a string or an argv array.
const ToolCommandSchema = z.union([
  z.looseObject({ command: z.string() }).transform((input) => input.command),
  z.looseObject({ cmd: z.string() }).transform((input) => input.cmd),
  z.looseObject({ command: z.array(z.string()) }).transform((input) => shellCommand(input.command)),
]);

const toToolCalls = (
  toolName: string,
  toolInput: Readonly<Record<string, unknown>>,
): readonly ToolCall[] => {
  const parsed = ToolCommandSchema.safeParse(toolInput);
  if (!parsed.success) return [];
  const command = parsed.data;
  if (toolName === PATCH_TOOL)
    return patchPaths(command).map((path) => ({ kind: "file-write", path }));
  return SHELL_TOOLS.some((name) => name === toolName) ? [{ kind: "shell", command }] : [];
};

const codexStop = async (stdin: string, deps: HookDeps, handler: StopHandler): Promise<string> => {
  const parsed = parseStdin(stdin, CodexStopInputSchema);
  if (!parsed.ok) {
    deps.log.warn({ error: parsed.error }, "stop allowed: hook input not understood");
    return "";
  }
  const { session_id: sessionId, transcript_path: transcriptPath } = parsed.value;
  const reply = await runStop(
    {
      agent: "codex",
      sessionId,
      contextSteps: codexAdapter.contextSteps,
      readTranscript: () => readCodexTranscript(transcriptPath ?? undefined),
    },
    handler,
    deps,
  );
  return stopReply(reply);
};

const codexSessionStart = (
  stdin: string,
  deps: HookDeps,
  handler: SessionStartHandler,
): Promise<string> =>
  runNoReplyHook({
    stdin,
    deps,
    handler,
    event: "session-start",
    schema: CodexSessionStartInputSchema,
    toHandlerInput: ({ session_id: sessionId, source }) => ({
      agent: "codex" as const,
      sessionId,
      source,
    }),
  });

const parsePreToolUseInput = (stdin: string): Result<readonly ToolUse[]> => {
  const parsed = parseStdin(stdin, CodexPreToolUseInputSchema);
  if (!parsed.ok) return parsed;
  const { session_id: sessionId, tool_name: toolName, tool_input: toolInput, cwd } = parsed.value;
  const uses = toToolCalls(toolName, toolInput).map((call) => ({
    agent: "codex" as const,
    sessionId,
    toolName,
    cwd: cwd ?? process.cwd(),
    call,
  }));
  return { ok: true, value: uses };
};

const firstDeny = async (
  uses: readonly ToolUse[],
  handler: PreToolUseHandler,
  deps: HookDeps,
): Promise<ToolVerdict> => {
  for (const use of uses) {
    const verdict = await runPreToolUse(use, handler, deps);
    if (verdict.kind === "deny") return verdict;
  }
  return { kind: "allow" };
};

const codexPreToolUse = async (
  stdin: string,
  deps: HookDeps,
  handler: PreToolUseHandler,
): Promise<string> => {
  const uses = parsePreToolUseInput(stdin);
  if (!uses.ok) {
    deps.log.warn({ error: uses.error }, "pre-tool-use allowed: hook input not understood");
    return "";
  }
  return preToolUseReply(await firstDeny(uses.value, handler, deps));
};

const RolloutLineSchema = z.looseObject({
  type: z.string(),
  payload: z.looseObject({ type: z.string().optional() }).optional(),
});

const UserMessageSchema = z.looseObject({ type: z.literal("user_message"), message: z.string() });
const FunctionCallSchema = z.looseObject({
  type: z.literal("function_call"),
  name: z.string(),
  arguments: z.string(),
});
const CustomToolCallSchema = z.looseObject({
  type: z.literal("custom_tool_call"),
  name: z.literal("exec"),
  input: z.string(),
});
const ExecArgsSchema = z.looseObject({ cmd: z.string() });
const ShellArgsSchema = z.looseObject({ command: z.array(z.string()) });

const command = (text: string): TranscriptEntry[] =>
  text === "" ? [] : [{ kind: "command", command: text }];

// `bash -lc X` is the shell tool's own wrapper; the command the agent wrote is X.
const shellCommand = (argv: readonly string[]): string => {
  const [shell, flag] = argv;
  const wrapped = argv.length === 3 && flag === "-lc" && shell?.endsWith("sh") === true;
  return wrapped ? (argv[2] ?? "") : argv.join(" ");
};

const functionCallEntries = (call: z.infer<typeof FunctionCallSchema>): TranscriptEntry[] => {
  const args = parseJson(call.arguments);
  if (!args.ok) return [];
  if (call.name === "exec_command") {
    const parsed = ExecArgsSchema.safeParse(args.value);
    return parsed.success ? command(parsed.data.cmd) : [];
  }
  if (call.name !== "shell") return [];
  const parsed = ShellArgsSchema.safeParse(args.value);
  return parsed.success ? command(shellCommand(parsed.data.command)) : [];
};

// Code mode runs shell commands from a script: `tools.exec_command({cmd: "..."})`.
const EXEC_COMMAND_CALL = /exec_command\(\s*\{[^}]*?\bcmd\s*:\s*("(?:[^"\\]|\\.)*")/g;

const codeModeEntries = (input: string): TranscriptEntry[] =>
  [...input.matchAll(EXEC_COMMAND_CALL)].flatMap((match) => {
    const literal = parseJson(match[1] ?? "");
    return literal.ok && typeof literal.value === "string" ? command(literal.value) : [];
  });

const toEntries = (line: z.infer<typeof RolloutLineSchema>): TranscriptEntry[] => {
  if (line.type === "event_msg") {
    const message = UserMessageSchema.safeParse(line.payload);
    const text = message.success ? message.data.message.trim() : "";
    return text === "" ? [] : [{ kind: "prompt", text }];
  }
  if (line.type !== "response_item") return [];
  const call = FunctionCallSchema.safeParse(line.payload);
  if (call.success) return functionCallEntries(call.data);
  const custom = CustomToolCallSchema.safeParse(line.payload);
  return custom.success ? codeModeEntries(custom.data.input) : [];
};

const parseLine = (text: string): z.infer<typeof RolloutLineSchema>[] => {
  const json = parseJson(text);
  const parsed = RolloutLineSchema.safeParse(json.ok ? json.value : undefined);
  return parsed.success ? [parsed.data] : [];
};

// A rollout line still being written, or of another shape, is skipped.
export const readCodexTranscript = async (
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

// What Codex answers; it has no StopFailure hook.
export const codexAdapter: AgentAdapter = {
  // Codex's pane is not driven for /compact or a restart yet.
  contextSteps: false,
  stop: codexStop,
  preToolUse: codexPreToolUse,
  sessionStart: codexSessionStart,
};

// Built on call, not at load: see claudeHooks in claude-hooks.ts.
const codexHooks = () =>
  ({
    SessionStart: [{ handlers: Object.values(sessionStartHandlers) }],
    Stop: [{ handlers: [continueWorkflow] }],
    PreToolUse: [{ matcher: [...SHELL_TOOLS, PATCH_TOOL].join("|"), handlers: [recordGuard] }],
  }) as const;

// A JSON string is a valid TOML basic string.
const toml = (value: string | number): string => JSON.stringify(value);

const hookToml = (orchestrateArgv: readonly string[], event: string, handler: string): string => {
  const cmd = [...orchestrateArgv, "hook", event, "--agent", "codex", "--handler", handler]
    .map(shellQuote)
    .join(" ");
  return `{type = "command", command = ${toml(cmd)}, timeout = ${HOOK_TIMEOUT_S}}`;
};

type HookGroup = Readonly<{ matcher?: string; handlers: readonly Readonly<{ name: string }>[] }>;

const groupToml = (orchestrateArgv: readonly string[], event: string, group: HookGroup): string => {
  const hooks = group.handlers.map((h) => hookToml(orchestrateArgv, event, h.name)).join(", ");
  const matcher = group.matcher === undefined ? "" : `matcher = ${toml(group.matcher)}, `;
  return `{${matcher}hooks = [${hooks}]}`;
};

const HOOK_COMMANDS = {
  SessionStart: "session-start",
  Stop: "stop",
  PreToolUse: "pre-tool-use",
} as const;

export const codexHookOverrides = (orchestrateArgv: readonly string[]): string[] => {
  const registered = codexHooks();
  return (["SessionStart", "Stop", "PreToolUse"] as const).map((event) => {
    const groups: readonly HookGroup[] = registered[event];
    const tomlGroups = groups.map((group) =>
      groupToml(orchestrateArgv, HOOK_COMMANDS[event], group),
    );
    return `hooks.${event}=[${tomlGroups.join(", ")}]`;
  });
};
