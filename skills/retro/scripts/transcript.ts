import { existsSync, readFileSync } from "node:fs";
import { parseJson } from "@yok/sdk";

// A Claude Code transcript record: Claude writes it, so every field is read defensively.
export type Rec = Readonly<{ line: number; data: Readonly<Record<string, unknown>> }>;

export type Message = Readonly<{
  line: number;
  ts: string;
  // TYPED = the agent was idle; QUEUED = typed while the agent worked
  kind: "TYPED" | "QUEUED";
  text: string;
}>;

// Text that lands where a human message would but nobody typed: client markers, machine
// notifications and a sub-agent's hand-back. A slash command the person typed starts with
// `<command-message>` and is a real message, so that prefix is not here.
const WRAPPER_PREFIXES = [
  "[Request interrupted",
  "<task-notification",
  "<agent-message",
  "<command-name",
  "<local-command",
  "<system-reminder",
  "Caveat:",
  "Base directory for this skill",
];

export type Data = Readonly<Record<string, unknown>>;

export const isRecord = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

export type JsonLine = Readonly<{ line: number; value: unknown }>;

// Every line of a JSON-lines file that parses, with its 1-based number. The number is the citation.
export const readJsonLines = (path: string): readonly JsonLine[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .flatMap((text, i) => {
      const parsed = parseJson(text);
      return parsed.ok ? [{ line: i + 1, value: parsed.value }] : [];
    });

export const loadRecords = (path: string): readonly Rec[] =>
  readJsonLines(path).flatMap(({ line, value }) =>
    isRecord(value) ? [{ line, data: value }] : [],
  );

export const contentOf = (data: Data): unknown =>
  isRecord(data.message) ? data.message.content : undefined;

export const blocksOf = (rec: Rec, kind: string): readonly Data[] => {
  const content = contentOf(rec.data);
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Data => isRecord(b) && b.type === kind);
};

// Flattens a content value to its plain text.
export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is Data => isRecord(b) && b.type === "text")
    .map((b) => stringOf(b.text))
    .join("\n");
};

export const bodyOf = (rec: Rec): string => textOf(contentOf(rec.data));

export const timestampOf = (rec: Rec): string => stringOf(rec.data.timestamp);

// True for text that only looks like a human message. `[Request interrupted by user]` is a marker
// the client writes; interrupts are read from the incident flags instead.
export const isWrapper = (text: string): boolean =>
  WRAPPER_PREFIXES.some((prefix) => text.startsWith(prefix));

const queuedText = (rec: Rec): string | undefined => {
  const { data } = rec;
  const attachment = data.attachment;
  if (
    data.type === "attachment" &&
    isRecord(attachment) &&
    attachment.type === "queued_command" &&
    isRecord(attachment.origin) &&
    attachment.origin.kind === "human"
  ) {
    return stringOf(attachment.prompt);
  }
  const queueOp = data.operation === "enqueue" || data.operation === "remove";
  if (data.type === "queue-operation" && queueOp && typeof data.content === "string") {
    return data.content;
  }
  return undefined;
};

const typedTexts = (rec: Rec): readonly string[] => {
  const { data } = rec;
  if (data.type !== "user" || data.isMeta || blocksOf(rec, "tool_result").length > 0) return [];
  const content = contentOf(data);
  if (typeof content === "string") return [content];
  return blocksOf(rec, "text").map((b) => stringOf(b.text));
};

type Candidate = Readonly<{ line: number; ts: string; kind: Message["kind"]; raw: string }>;

const compareMessages = (a: Message, b: Message): number =>
  a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.line - b.line;

// A message present in both places keeps the QUEUED label, since mid-action is the fact worth
// keeping: corrections live there. The first 200 characters identify a message.
const dedupe = (candidates: readonly Candidate[]): readonly Message[] => {
  const seen = new Set<string>();
  const kept: Message[] = [];
  for (const { line, ts, kind, raw } of candidates) {
    const text = raw.trim();
    if (!text || isWrapper(text) || seen.has(text.slice(0, 200))) continue;
    seen.add(text.slice(0, 200));
    kept.push({ line, ts, kind, text });
  }
  return kept;
};

// Every message the human sent, from both places they land: a plain `user` record while the
// agent was idle, an `attachment` or `queue-operation` record while it worked.
export const humanMessages = (recs: readonly Rec[]): readonly Message[] => {
  const queued = recs.flatMap((rec): readonly Candidate[] => {
    const raw = queuedText(rec);
    return raw === undefined ? [] : [{ line: rec.line, ts: timestampOf(rec), kind: "QUEUED", raw }];
  });
  const typed = recs.flatMap((rec): readonly Candidate[] =>
    typedTexts(rec).map((raw) => ({ line: rec.line, ts: timestampOf(rec), kind: "TYPED", raw })),
  );
  return [...dedupe([...queued, ...typed])].sort(compareMessages);
};

export type Call = Readonly<{ line: number; ts: string; name: string; input: unknown }>;
export type Failure = Readonly<{ line: number; ts: string; call: Call | undefined; text: string }>;

const ERROR_TEXT =
  /command not found|ENOENT|EADDRINUSE|MODULE_NOT_FOUND|npm ERR|fatal:|No such file|Permission denied|Traceback|error TS\d+/i;

const callOf = (rec: Rec, block: Data): Call => ({
  line: rec.line,
  ts: timestampOf(rec),
  name: stringOf(block.name) || "?",
  input: block.input,
});

export const commandOf = (call: Call): string => {
  if (!isRecord(call.input)) return "";
  return stringOf(call.input.command) || stringOf(call.input.file_path);
};

// The first two tokens of the command: the unit for clustering repeated failures.
export const familyOf = (call: Call): string =>
  commandOf(call).split(/\s+/).filter(Boolean).slice(0, 2).join(" ") || call.name;

const toolUses = (recs: readonly Rec[]): readonly (readonly [Rec, Data])[] =>
  recs
    .filter((rec) => rec.data.type === "assistant")
    .flatMap((rec) => blocksOf(rec, "tool_use").map((block) => [rec, block] as const));

export const toolCalls = (recs: readonly Rec[], names?: readonly string[]): readonly Call[] =>
  toolUses(recs)
    .filter(([, block]) => !names || names.includes(stringOf(block.name)))
    .map(([rec, block]) => callOf(rec, block));

export const callIndex = (recs: readonly Rec[]): ReadonlyMap<string, Call> =>
  new Map(toolUses(recs).map(([rec, block]) => [stringOf(block.id), callOf(rec, block)]));

type IsFailure = (block: Data, text: string) => boolean;

export const isFlagged: IsFailure = (block) => Boolean(block.is_error);

export const readsLikeError: IsFailure = (block, text) =>
  isFlagged(block, text) || ERROR_TEXT.test(text.slice(0, 2000));

// The tool results `isFailure` picks, each joined to the call that caused it. The main transcript
// also counts results whose text reads like an error; a sub-agent's counts flagged ones only.
export const failures = (recs: readonly Rec[], isFailure: IsFailure): readonly Failure[] => {
  const index = callIndex(recs);
  return recs.flatMap((rec) =>
    blocksOf(rec, "tool_result")
      .map((block) => ({ block, text: textOf(block.content) }))
      .filter(({ block, text }) => isFailure(block, text))
      .map(({ block, text }) => ({
        line: rec.line,
        ts: timestampOf(rec),
        call: index.get(stringOf(block.tool_use_id)),
        text,
      })),
  );
};

export type Answer = Readonly<{ call: Call | undefined; line: number; text: string }>;

// Each AskUserQuestion paired with the answer that came back.
export const answers = (recs: readonly Rec[]): readonly Answer[] => {
  const index = callIndex(recs);
  const asked = (id: string): boolean => index.get(id)?.name === "AskUserQuestion";
  return recs.flatMap((rec) =>
    blocksOf(rec, "tool_result")
      .filter((block) => asked(stringOf(block.tool_use_id)))
      .map((block) => ({
        call: index.get(stringOf(block.tool_use_id)),
        line: rec.line,
        text: textOf(block.content),
      })),
  );
};

export type Incident = Readonly<{ line: number; ts: string; flag: string; value: string }>;

const INCIDENT_FLAGS = [
  "error",
  "isApiErrorMessage",
  "apiErrorStatus",
  "interruptedMessageId",
  "isAbortedMidStream",
  "toolDenialKind",
  "preventedContinuation",
  "hookErrors",
];

const flagValue = (value: unknown): string =>
  (typeof value === "object" ? JSON.stringify(value) : String(value)).slice(0, 200);

export const incidents = (recs: readonly Rec[]): readonly Incident[] =>
  recs.flatMap((rec) => {
    const { line, data } = rec;
    const ts = timestampOf(rec);
    const flagged = INCIDENT_FLAGS.filter((flag) => Boolean(data[flag])).map((flag) => ({
      line,
      ts,
      flag,
      value: flagValue(data[flag]),
    }));
    if (data.type !== "pr-link") return flagged;
    const value = `#${String(data.prNumber)} ${String(data.prUrl)}`;
    return [...flagged, { line, ts, flag: "pr-link", value }];
  });

export const census = (recs: readonly Rec[]): Readonly<Record<string, number>> =>
  countBy(recs.map((rec) => String(rec.data.type)));

export const span = (recs: readonly Rec[]): Readonly<{ first: Date; last: Date }> | undefined => {
  const dates = recs.map((rec) => parseTime(timestampOf(rec))).filter((d) => d !== undefined);
  const [first] = dates;
  const last = dates.at(-1);
  return first && last && dates.length > 1 ? { first, last } : undefined;
};

export type Gap = Readonly<{
  beforeLine: number;
  afterLine: number;
  minutes: number;
  beforeType: string;
  beforeText: string;
  afterType: string;
  afterText: string;
}>;

export const parseTime = (ts: string | undefined): Date | undefined => {
  if (!ts) return undefined;
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

type Stamped = Readonly<{ rec: Rec; at: number }>;

const stamped = (recs: readonly Rec[]): readonly Stamped[] =>
  recs.flatMap((rec) => {
    const date = parseTime(timestampOf(rec));
    return date ? [{ rec, at: date.getTime() }] : [];
  });

const gapBetween = (before: Stamped, after: Stamped): Gap => ({
  beforeLine: before.rec.line,
  afterLine: after.rec.line,
  minutes: Math.floor((after.at - before.at) / 60_000),
  beforeType: String(before.rec.data.type),
  beforeText: bodyOf(before.rec),
  afterType: String(after.rec.data.type),
  afterText: bodyOf(after.rec),
});

export type Agent = Readonly<{
  path: string;
  name: string;
  description: string;
  first: string;
  last: string;
  tools: Readonly<Record<string, number>>;
  failures: readonly Failure[];
  died: boolean;
  finalLine: number;
  finalText: string;
}>;

const LIMIT_BANNER = /session limit|rate.?limit|usage limit/i;

// A Claude Code sub-agent returns its report as a `SubagentHandback` call; the text blocks before
// it are narration.
const handbackText = (rec: Rec): string =>
  blocksOf(rec, "tool_use")
    .filter((block) => block.name === "SubagentHandback")
    .map((block) => (isRecord(block.input) ? stringOf(block.input.message) : ""))
    .at(-1) ?? "";

export const finalMessage = (recs: readonly Rec[]): Readonly<{ line: number; text: string }> => {
  const assistant = recs.filter((rec) => rec.data.type === "assistant");
  const report = assistant.findLast((rec) => handbackText(rec) !== "");
  if (report) return { line: report.line, text: handbackText(report).trim() };
  const last = assistant.findLast((rec) => blocksOf(rec, "text").length);
  if (!last) return { line: 0, text: "" };
  return { line: last.line, text: stringOf(blocksOf(last, "text").at(-1)?.text).trim() };
};

// A platform banner leads a short message. Matching anywhere gives false positives: a long
// closing report that mentions a rate limit is not a death.
export const diedOnLimit = (text: string): boolean =>
  LIMIT_BANNER.test(text.slice(0, 200)) && text.length < 500;

const readMeta = (path: string): Data => {
  const parsed = existsSync(path) ? parseJson(readFileSync(path, "utf8")) : undefined;
  return parsed?.ok && isRecord(parsed.value) ? parsed.value : {};
};

export const countBy = (names: readonly string[]): Readonly<Record<string, number>> => {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return Object.fromEntries(counts);
};

export const readAgent = (path: string): Agent => {
  const recs = loadRecords(path);
  const stamps = recs.map(timestampOf).filter(Boolean);
  const final = finalMessage(recs);
  return {
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    description: stringOf(readMeta(path.replace(/\.jsonl$/, ".meta.json")).description) || "?",
    first: stamps[0] ?? "",
    last: stamps.at(-1) ?? "",
    tools: countBy(toolUses(recs).map(([, block]) => stringOf(block.name) || "?")),
    failures: failures(recs, isFlagged),
    died: diedOnLimit(final.text),
    finalLine: final.line,
    finalText: final.text,
  };
};

const two = (n: number): string => String(n).padStart(2, "0");

// `MM-DD HH:MM:SS` in the IANA `zone`, or the machine's zone; `?` for a missing or bad timestamp.
export const formatTime = (ts: string | undefined, zone: string | undefined): string => {
  const date = parseTime(ts);
  if (!date) return "?";
  const parts = new Intl.DateTimeFormat("en-US", {
    ...(zone ? { timeZone: zone } : {}),
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "??";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
};

export const humanSpan = (ms: number): string => {
  const mins = Math.floor(ms / 60_000);
  return mins >= 60 ? `${Math.floor(mins / 60)}h ${two(mins % 60)}m` : `${mins}m`;
};

// Every pause longer than `seconds`, with both sides. A gap is not a stall: the caller decides
// which of blocked-on-human, sub-agent-running, or stall applies from what sat on each side.
export const gaps = (recs: readonly Rec[], seconds = 300): readonly Gap[] => {
  const timed = stamped(recs);
  return timed.flatMap((after, i) => {
    const before = timed[i - 1];
    if (!before || after.at - before.at <= seconds * 1000) return [];
    return [gapBetween(before, after)];
  });
};

// A name that says its value is a secret: `token`, `secret` or `password`, alone or qualified
// (`access_token`, `clientSecret`), and `key` only when qualified (`api_key`, `apiKey`), since a
// bare `key` names any map entry. A word that merely ends in one (`monkey`) is not such a name.
const SECRET_NAME =
  "(?:[a-z0-9]+[_-])*(?:[a-z0-9]+[_-]key|(?:api|access|auth|client|private|signing)key|(?:api|access|auth|client|refresh|id|bearer)?(?:token|secret|password|passwd))";

const SECRET_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [
    /\b(?:sk-ant-[\w-]{16,}|sk-[\w-]{16,}|gh[pousr]_\w{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|lin_api_\w{20,}|AKIA[0-9A-Z]{16})/g,
    "REDACTED",
  ],
  [/\b(Bearer\s+)[\w.~+/-]{16,}=*/gi, "$1REDACTED"],
  [/\b((?:[A-Z0-9]+_)*(?:KEY|TOKEN|SECRET|PASSWORD))=("[^"]*"|'[^']*'|\S+)/g, "$1=REDACTED"],
  // The name, then `:` or `=`, then a value of 8 or more characters with no space in it. A quoted
  // value is masked as it is; a bare one only when it holds a digit, so code such as
  // `password: undefined` stays readable.
  [
    new RegExp(
      `(\\b${SECRET_NAME}(?:\\\\?["'])?\\s*[:=]\\s*)(?:(\\\\?["'])[^"'\\\\\\s]{8,}\\2|(?=[^\\s"'\\\\,;&}]*\\d)[^\\s"'\\\\,;&}]{8,})`,
      "gi",
    ),
    "$1$2REDACTED$2",
  ],
];

// Transcripts hold whatever a stage printed, keys included, and the report built from these files
// is posted where others read it. Common key shapes are masked before anything is written.
export const maskSecrets = (text: string): string =>
  SECRET_PATTERNS.reduce((masked, [pattern, mask]) => masked.replace(pattern, mask), text);
