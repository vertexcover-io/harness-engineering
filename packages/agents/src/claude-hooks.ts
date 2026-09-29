import { readFile } from "node:fs/promises";
import {
  type HookReply,
  NonEmptyStringSchema,
  parseJson,
  type Result,
  runStopHook,
  type StopHook,
  type StopHookDeps,
  type TranscriptEntry,
} from "@harness/sdk";
import * as z from "zod";

const STOP_HOOK_TIMEOUT_S = 30;
// Claude Code saves a Stop hook's block reason back into the transcript as a user line.
const HOOK_FEEDBACK = "Stop hook feedback:";

const ClaudeStopInputSchema = z.looseObject({
  session_id: NonEmptyStringSchema,
  transcript_path: z.string().optional(),
});
type ClaudeStopInput = z.infer<typeof ClaudeStopInputSchema>;

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

const parseStopInput = (stdin: string): Result<ClaudeStopInput> => {
  const json = parseJson(stdin);
  if (!json.ok) return { ok: false, error: `stop input: ${json.error}` };
  const parsed = ClaudeStopInputSchema.safeParse(json.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
};

// Claude ends the turn on empty output, and keeps going with `reason` on a block.
const claudeStopReply = (reply: HookReply): string =>
  reply.kind === "allow" ? "" : `${JSON.stringify({ decision: "block", reason: reply.message })}\n`;

export const claudeStopHook: StopHook = async (stdin: string, deps: StopHookDeps) => {
  const parsed = parseStopInput(stdin);
  if (!parsed.ok) {
    deps.log.warn({ error: parsed.error }, "stop allowed: hook input not understood");
    return "";
  }
  const { session_id: sessionId, transcript_path: transcriptPath } = parsed.value;
  const reply = await runStopHook(
    { agent: "claude", sessionId, readTranscript: () => readClaudeTranscript(transcriptPath) },
    deps,
  );
  return claudeStopReply(reply);
};

const shellQuote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`;

// Settings for `claude --settings`: a Stop hook that runs `orchestrate hook stop` for this session.
export const claudeHookSettings = (hookCommand: readonly string[]) => ({
  hooks: {
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: [...hookCommand, "stop", "--agent", "claude"].map(shellQuote).join(" "),
            timeout: STOP_HOOK_TIMEOUT_S,
          },
        ],
      },
    ],
  },
});
