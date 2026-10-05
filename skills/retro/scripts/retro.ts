import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import {
  type Event,
  EventSchema,
  type Result,
  runDirOf,
  type SessionRef,
  SessionRefSchema,
  WorkflowStartedEvent,
} from "@yok/sdk";
import * as z from "zod";
import {
  type Agent,
  answers,
  blocksOf,
  type Call,
  census,
  commandOf,
  contentOf,
  countBy,
  type Data,
  failures,
  familyOf,
  formatTime,
  gaps,
  humanMessages,
  humanSpan,
  incidents,
  isRecord,
  loadRecords,
  type Message,
  maskSecrets,
  parseTime,
  type Rec,
  readAgent,
  readJsonLines,
  readsLikeError,
  span,
  stringOf,
  textOf,
  timestampOf,
  toolCalls,
} from "./transcript.ts";

export type StageRow = Readonly<{
  nodeId: string;
  status: string;
  start: string | undefined;
  end: string | undefined;
}>;

// Hook, agent and session-replaced events all carry the session they came from in their payload.
const SessionPayloadSchema = z.object({ payload: z.object(SessionRefSchema.shape) });

const sessionsOf = (event: Event): readonly SessionRef[] => {
  if (event.type === "workflow.started") {
    return WorkflowStartedEvent.safeParse(event).data?.payload.activeSessions ?? [];
  }
  const carried = SessionPayloadSchema.safeParse(event);
  return carried.success ? [carried.data.payload] : [];
};

// Every session the run used, in order of first appearance: a `context` node that replaces the
// session adds a new id, so a run can have several.
export const readRunSessions = (events: readonly Event[]): readonly SessionRef[] =>
  events
    .flatMap(sessionsOf)
    .filter((s, i, all) => all.findIndex((o) => o.sessionId === s.sessionId) === i);

const NODE_END = /^workflow\.node\.(completed|failed|skipped|cancelled)$/;

// An end event closes the latest open row of its node; a node that ended without starting
// (skipped, or failed before it ran) gets a row with no start.
const endRow = (rows: readonly StageRow[], event: Event, status: string): readonly StageRow[] => {
  const open = rows.findLastIndex((row) => row.nodeId === event.nodeId && row.end === undefined);
  if (open < 0) {
    return [...rows, { nodeId: event.nodeId ?? "?", status, start: undefined, end: event.ts }];
  }
  return rows.map((row, i) => (i === open ? { ...row, status, end: event.ts } : row));
};

// One row per node run, in start order.
export const readStages = (events: readonly Event[]): readonly StageRow[] => {
  let rows: readonly StageRow[] = [];
  for (const event of events) {
    if (event.type === "workflow.node.started") {
      const row = {
        nodeId: event.nodeId ?? "?",
        status: "running",
        start: event.ts,
        end: undefined,
      };
      rows = [...rows, row];
      continue;
    }
    const status = NODE_END.exec(event.type)?.[1];
    if (status) rows = endRow(rows, event, status);
  }
  return rows;
};

// Planning completes only after the user approved the plan, so its end is the plan gate.
export const findGateTime = (events: readonly Event[]): string | undefined =>
  events.findLast((e) => e.type === "workflow.node.completed" && e.nodeId === "planning")?.ts;

const STAGE_TOOLS = ["Skill", "Agent", "Task"];
const UNREADABLE =
  /\b(explain (this|that|it)|what does (this|that|it) mean|not clear|unclear|didn'?t understand|don'?t understand|confusing|rewrite (this|that|it)|reword|makes no sense|i don'?t get (this|it))\b/i;

type Session = Readonly<{
  label: string;
  main: string;
  subagents: string;
  recs: readonly Rec[];
  zone: string | undefined;
  gate: string | undefined;
}>;

const json = (value: unknown, indent?: number): string =>
  JSON.stringify(value ?? null, null, indent);

const cite = (s: Session, line: number): string => `${s.label}.jsonl:${line}`;
const when = (s: Session, ts: string | undefined): string => formatTime(ts, s.zone);

const isPostGate = (s: Session, ts: string): boolean => {
  const gate = parseTime(s.gate);
  const at = parseTime(ts);
  return gate !== undefined && at !== undefined && at > gate;
};

const spineTag = (s: Session, m: Message): string => {
  const post = isPostGate(s, m.ts) ? `${m.kind} POST-GATE` : m.kind;
  return UNREADABLE.test(m.text) ? `${post} UNREADABLE` : post;
};

const spineEntry = (s: Session, m: Message, first: boolean, post: number): string => {
  const line = `===== THE LINE — plan gate at ${when(s, s.gate)}. ${post} message(s) follow.\n\n`;
  const head = first ? line : "";
  return `${head}===== ${spineTag(s, m)} ${cite(s, m.line)} @ ${when(s, m.ts)}\n${m.text.slice(0, 2000)}\n\n`;
};

type SpineCounts = Readonly<{ total: number; queued: number; post: number; unread: number }>;

const dumpSpine = (s: Session, out: string): SpineCounts => {
  const rows = humanMessages(s.recs);
  const post = rows.filter((m) => isPostGate(s, m.ts)).length;
  const firstPost = rows.findIndex((m) => isPostGate(s, m.ts));
  const header =
    `# Human messages: ${rows.length} total, ${rows.filter((m) => m.kind === "QUEUED").length} typed mid-action, ${post} after the plan gate\n` +
    "# QUEUED   = typed while the agent was working. Corrections live here.\n" +
    "# POST-GATE = after the plan gate. The pipeline promised not to stop here.\n" +
    "#             Every one of these is an issue until you write down why not.\n" +
    "# UNREADABLE = the human asked what a document meant. The document failed.\n" +
    "#             File it against the stage that wrote the document (D2b).\n\n";
  const body = rows.map((m, i) => spineEntry(s, m, i === firstPost, post)).join("");
  writeOut(out, "01-spine.txt", header + body);
  return {
    total: rows.length,
    queued: rows.filter((m) => m.kind === "QUEUED").length,
    post,
    unread: rows.filter((m) => UNREADABLE.test(m.text)).length,
  };
};

const dumpAssistant = (s: Session, out: string): void => {
  const text = s.recs
    .filter((rec) => rec.data.type === "assistant")
    .flatMap((rec) =>
      blocksOf(rec, "text")
        .map((b) => stringOf(b.text))
        .filter((t) => t.trim())
        .map((t) => `===== ${cite(s, rec.line)} @ ${when(s, timestampOf(rec))}\n${t}\n\n`),
    )
    .join("");
  writeOut(out, "02-assistant.txt", text);
};

type Counts = Readonly<Record<string, number>>;

const mostCommon = (counts: Counts, n: number): readonly (readonly [string, number])[] =>
  Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);

const dumpCalls = (s: Session, out: string): Counts => {
  const calls = toolCalls(s.recs);
  const text = calls
    .map(
      (c) => `${cite(s, c.line)} | ${when(s, c.ts)} | ${c.name} | ${json(c.input).slice(0, 600)}\n`,
    )
    .join("");
  writeOut(out, "03-tool-calls.txt", text);
  return countBy(calls.map((c) => c.name));
};

const origin = (s: Session, call: Call | undefined): string =>
  call ? `${call.name} (called ${cite(s, call.line)})` : "?";

const dumpFailures = (s: Session, out: string): Readonly<{ count: number; families: Counts }> => {
  const rows = failures(s.recs, readsLikeError);
  const text = rows
    .map(
      (r) =>
        `===== ${cite(s, r.line)} @ ${when(s, r.ts)} | ${origin(s, r.call)}\n` +
        `INPUT: ${r.call ? json(r.call.input).slice(0, 500) : ""}\nERROR: ${r.text.slice(0, 1200)}\n\n`,
    )
    .join("");
  writeOut(out, "04-tool-errors.txt", text);
  return {
    count: rows.length,
    families: countBy(rows.map((r) => (r.call ? familyOf(r.call) : "?"))),
  };
};

const dumpQuestions = (s: Session, out: string): number => {
  const asks = toolCalls(s.recs, ["AskUserQuestion"]);
  const asked = asks
    .map(
      (c) =>
        `===== ASK ${cite(s, c.line)} @ ${when(s, c.ts)}\n${json(c.input, 1).slice(0, 3000)}\n\n`,
    )
    .join("");
  const answered = answers(s.recs)
    .map((a) => {
      const from = a.call ? ` (asked ${cite(s, a.call.line)})` : "";
      return `===== ANSWER ${cite(s, a.line)}${from}\n${a.text.slice(0, 2000)}\n\n`;
    })
    .join("");
  writeOut(out, "05-ask-user.txt", asked + answered);
  return asks.length;
};

const agentsOf = (s: Session): readonly Agent[] => {
  if (!existsSync(s.subagents)) return [];
  return readdirSync(s.subagents)
    .filter((name) => /^agent-.*\.jsonl$/.test(name))
    .sort()
    .map((name) => readAgent(join(s.subagents, name)))
    .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0));
};

const agentEntry = (s: Session, a: Agent): string => {
  const flag = a.died ? "  *** DIED ON A PLATFORM LIMIT ***" : "";
  const head =
    `\n===== ${a.name}${flag}\n  ${a.description}\n` +
    `  ${when(s, a.first)} -> ${when(s, a.last)} | errors=${a.failures.length} | ${json(a.tools)}\n`;
  const errors = a.failures
    .slice(0, 12)
    .map((r) => {
      const cmd = r.call ? commandOf(r.call).slice(0, 160) : "?";
      return `   ERR ${when(s, r.ts)} | ${cmd}\n       ${r.text.slice(0, 200)}\n`;
    })
    .join("");
  return `${head}${errors}   FINAL :${a.finalLine} ${a.finalText.slice(0, 200)}\n`;
};

const dumpAgents = (
  s: Session,
  out: string,
): Readonly<{ count: number; dead: readonly string[] }> => {
  const agents = agentsOf(s);
  writeOut(out, "06-subagents.txt", agents.map((a) => agentEntry(s, a)).join(""));
  return {
    count: agents.length,
    dead: agents.filter((a) => a.died).map((a) => `${a.name}:${a.finalLine}`),
  };
};

const stageLines = (s: Session, rec: Rec): string =>
  blocksOf(rec, "tool_use")
    .filter((b) => STAGE_TOOLS.includes(stringOf(b.name)))
    .map((b) => {
      const input = isRecord(b.input) ? b.input : {};
      const label = stringOf(input.skill) || stringOf(input.description);
      return `STAGE ${cite(s, rec.line)} @ ${when(s, timestampOf(rec))} ${stringOf(b.name)} :: ${label}\n`;
    })
    .join("");

const dumpTimeline = (s: Session, out: string): number => {
  const byEnd = new Map(gaps(s.recs).map((g) => [g.afterLine, g]));
  const header =
    "# STAGE lines are stage boundaries. Classify every GAP before counting it:\n" +
    "#   blocked-on-human | subagent-running | stall.  Only a stall is a defect.\n\n";
  const body = s.recs
    .map((rec) => {
      const g = byEnd.get(rec.line);
      const gap = g
        ? `\nGAP ${g.minutes}m  ${cite(s, g.beforeLine)} -> ${cite(s, g.afterLine)}  (ends ${when(s, timestampOf(rec))})\n` +
          `  BEFORE ${g.beforeType}: ${g.beforeText.slice(0, 200)}\n` +
          `  AFTER  ${g.afterType}: ${g.afterText.slice(0, 200)}\n` +
          "  BRACKET: [ ] blocked-on-human  [ ] subagent-running  [ ] stall\n\n"
        : "";
      return gap + stageLines(s, rec);
    })
    .join("");
  writeOut(out, "07-timeline.txt", header + body);
  return byEnd.size;
};

const dumpIncidents = (s: Session, out: string): number => {
  const rows = incidents(s.recs);
  const text = rows
    .map((r) => `${cite(s, r.line)} @ ${when(s, r.ts)} | ${r.flag} = ${r.value}\n`)
    .join("");
  writeOut(out, "08-incidents.txt", text);
  return rows.length;
};

const spanLine = (s: Session): readonly string[] => {
  const range = span(s.recs);
  if (!range) return [];
  const zone = s.zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const length = humanSpan(range.last.getTime() - range.first.getTime());
  return [
    `span             ${when(s, range.first.toISOString())} -> ${when(s, range.last.toISOString())}  (${length}, ${zone})`,
  ];
};

const gateLine = (s: Session): string =>
  s.gate
    ? `plan gate        ${when(s, s.gate)} (${s.gate})`
    : "plan gate        NOT FOUND — pass --gate-time ISO";

const extractSession = (s: Session, out: string): string => {
  mkdirSync(out, { recursive: true });
  dumpAssistant(s, out);
  const spine = dumpSpine(s, out);
  const calls = dumpCalls(s, out);
  const errors = dumpFailures(s, out);
  const asks = dumpQuestions(s, out);
  const agents = dumpAgents(s, out);
  const gapCount = dumpTimeline(s, out);
  const incidentCount = dumpIncidents(s, out);
  const counts = census(s.recs);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const lines = [
    `session          ${s.label}`,
    `main             ${s.main}`,
    `subagents        ${existsSync(s.subagents) ? s.subagents : "none found"}`,
    `records          ${total}  ${json(counts)}`,
    ...spanLine(s),
    `human messages   ${spine.total}  (${spine.queued} typed mid-action -> 01-spine.txt)`,
    gateLine(s),
    `post-gate msgs   ${spine.post}${spine.post ? "  <- every one is an issue" : "  (contract held)"}`,
    `unreadable docs  ${spine.unread}${spine.unread ? "  <- the human asked what a document meant (D2b)" : ""}`,
    `AskUserQuestion  ${asks}`,
    `sub-agents       ${agents.count}`,
    `tool errors      ${errors.count}`,
    `incident flags   ${incidentCount}`,
    `gaps > 5 min     ${gapCount}  (classify each before counting a stall)`,
    `agent deaths     ${agents.dead.length}${agents.dead.length ? `  ${agents.dead.join(", ")}` : ""}`,
    "",
    "top error families:",
    ...mostCommon(errors.families, 8).map(
      ([fam, n]) => `  ${String(n).padStart(4)}  ${fam.slice(0, 90)}`,
    ),
    "",
    "top tool calls:",
    ...mostCommon(calls, 8).map(([name, n]) => `  ${String(n).padStart(4)}  ${name}`),
  ];
  const text = lines.join("\n");
  writeOut(out, "00-summary.txt", `${text}\n`);
  return text;
};

const openSession = (
  main: string,
  label: string,
  zone: string | undefined,
  gate: string | undefined,
): Session => ({
  label,
  main,
  subagents: join(main.replace(/\.jsonl$/, ""), "subagents"),
  recs: loadRecords(main),
  zone,
  gate,
});

// The slug depends on the folder the session started in, so every project folder is searched.
const findTranscript = (projectsDir: string, sessionId: string): string | undefined => {
  if (!existsSync(projectsDir)) return undefined;
  return readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(projectsDir, entry.name, `${sessionId}.jsonl`))
    .find((path) => existsSync(path));
};

type Located = Readonly<{ label: string; session: SessionRef }> &
  (Readonly<{ main: string }> | Readonly<{ skipped: string }>);

const locate = (session: SessionRef, index: number, projectsDir: string): Located => {
  const label = `main-${index + 1}`;
  if (session.agent !== "claude") {
    return { label, session, skipped: `${session.agent} transcripts are not read` };
  }
  const main = findTranscript(projectsDir, session.sessionId);
  return main
    ? { label, session, main }
    : { label, session, skipped: `transcript not found under ${projectsDir}` };
};

const runText = (name: string, gate: string | undefined, located: readonly Located[]): string => {
  const rows = located.map(
    (l) =>
      `${l.label.padEnd(8)} ${l.session.agent.padEnd(7)} ${l.session.sessionId}  ${"main" in l ? l.main : `skipped: ${l.skipped}`}`,
  );
  return [`run        ${name}`, `plan gate  ${gate ?? "NOT FOUND"}`, "", ...rows].join("\n");
};

const durationOf = (row: StageRow): string => {
  const start = parseTime(row.start);
  const end = parseTime(row.end);
  if (!start || !end) return "";
  const ms = end.getTime() - start.getTime();
  return ms < 60_000 ? `${Math.floor(ms / 1000)}s` : humanSpan(ms);
};

const stagesText = (rows: readonly StageRow[], zone: string | undefined): string => {
  const lines = rows.map(
    (row) =>
      `${row.nodeId.padEnd(18)} ${row.status.padEnd(10)} ${formatTime(row.start, zone).padEnd(15)} ${formatTime(row.end, zone).padEnd(15)} ${durationOf(row)}`,
  );
  return [
    "# node               status     start           end             duration",
    ...lines,
  ].join("\n");
};

// An event this yok version does not know is left out; the retro reads only the ones it needs.
const readEvents = (path: string): readonly Event[] =>
  readJsonLines(path).flatMap(({ value }) => {
    const parsed = EventSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });

const writeOut = (dir: string, name: string, text: string): void =>
  writeFileSync(join(dir, name), maskSecrets(text));

export type ExtractRunOptions = Readonly<{
  runDir: string;
  out: string;
  projectsDir: string;
  zone: string | undefined;
  gateTime?: string | undefined;
}>;

// Extracts every Claude session of a run into `out`, and returns the printed summary.
export const extractRun = async (options: ExtractRunOptions): Promise<Result<string>> => {
  const { runDir, out, projectsDir, zone } = options;
  const eventsPath = join(runDir, "event.jsonl");
  if (!existsSync(eventsPath)) return { ok: false, error: `no event.jsonl in ${runDir}` };
  const events = readEvents(eventsPath);
  const gate = options.gateTime ?? findGateTime(events);
  const located = readRunSessions(events).map((s, i) => locate(s, i, projectsDir));
  mkdirSync(out, { recursive: true });
  const run = runText(basename(runDir), gate, located);
  writeOut(out, "00-run.txt", `${run}\n`);
  writeOut(out, "09-stages.txt", `${stagesText(readStages(events), zone)}\n`);
  const found = located.flatMap((l) => ("main" in l ? [{ label: l.label, main: l.main }] : []));
  if (found.length === 0) {
    return { ok: false, error: `no Claude transcript of this run found under ${projectsDir}` };
  }
  const summaries = found.map((l) =>
    extractSession(openSession(l.main, l.label, zone, gate), join(out, l.label)),
  );
  return { ok: true, value: [run, ...summaries].join("\n\n") };
};

export type ExtractMainOptions = Readonly<{
  main: string;
  out: string;
  zone: string | undefined;
  gateTime?: string | undefined;
}>;

// The by-hand path: one transcript with no run around it.
export const extractMain = (options: ExtractMainOptions): Result<string> => {
  if (!existsSync(options.main)) return { ok: false, error: `no transcript at ${options.main}` };
  const session = openSession(options.main, "main-1", options.zone, options.gateTime);
  return { ok: true, value: extractSession(session, join(options.out, "main-1")) };
};

const renderBlock = (block: Data, cap: number): string | undefined => {
  if (block.type === "text") return stringOf(block.text).slice(0, cap);
  if (block.type === "tool_use") {
    return `[TOOL ${stringOf(block.name)}]\n${json(block.input, 1).slice(0, cap)}`;
  }
  if (block.type !== "tool_result") return undefined;
  const text = textOf(block.content);
  return `[RESULT${block.is_error ? " ERROR" : ""}]\n${text.slice(0, cap)}`;
};

const renderBody = (rec: Rec, cap: number): readonly string[] => {
  const content = contentOf(rec.data);
  if (typeof content === "string") return [content.slice(0, cap)];
  if (!Array.isArray(content)) return [];
  return content
    .filter(isRecord)
    .map((b) => renderBlock(b, cap))
    .filter((t) => t !== undefined);
};

// One citation, opened: the record at a line number in readable form.
export const renderCitation = (
  rec: Rec,
  label: string,
  zone: string | undefined,
  cap: number,
): string => {
  const head = `--- ${label}:${rec.line} @ ${formatTime(timestampOf(rec), zone)} [${String(rec.data.type)}]`;
  const body = renderBody(rec, cap);
  if (body.length > 0) return `${head}\n${body.join("\n")}\n`;
  const { message: _m, type: _t, timestamp: _ts, ...rest } = rec.data;
  return `${head}\n${json(rest).slice(0, cap)}\n`;
};

export type CiteOptions = Readonly<{
  transcript: string;
  lines: readonly number[];
  context: number;
  zone: string | undefined;
  full: boolean;
}>;

export const citeLines = (options: CiteOptions): string => {
  const { transcript, lines, context, zone, full } = options;
  const cap = full ? 1_000_000 : 3000;
  const label = basename(transcript).slice(0, 25);
  const wanted = new Set(
    lines.flatMap((n) => Array.from({ length: 2 * context + 1 }, (_, i) => n - context + i)),
  );
  const recs = new Map(loadRecords(transcript).map((rec) => [rec.line, rec]));
  const last = Math.max(0, ...recs.keys());
  const text = [...wanted]
    .filter((n) => n >= 1 && n <= last)
    .sort((a, b) => a - b)
    .map((n) => {
      const rec = recs.get(n);
      return rec ? renderCitation(rec, label, zone, cap) : `--- ${n}: unparseable line`;
    })
    .join("\n");
  return maskSecrets(text);
};

const USAGE = `usage:
  retro.ts extract (--run NAME | --main PATH) --out DIR [--tz ZONE] [--projects DIR] [--gate-time ISO]
  retro.ts cite TRANSCRIPT LINE [LINE ...] [--context N] [--tz ZONE] [--full]`;

const validZone = (zone: string | undefined): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", zone ? { timeZone: zone } : {});
    return true;
  } catch {
    return false;
  }
};

export const main = async (argv: readonly string[]): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      run: { type: "string" },
      main: { type: "string" },
      out: { type: "string" },
      tz: { type: "string" },
      projects: { type: "string" },
      "gate-time": { type: "string" },
      context: { type: "string" },
      full: { type: "boolean" },
    },
  });
  const [command, ...rest] = positionals;
  const result = await dispatch(command, values, rest);
  if (!result.ok) {
    console.error(result.error);
    process.exitCode = 1;
    return;
  }
  console.log(result.value);
};

const dispatch = async (
  command: string | undefined,
  values: Values,
  rest: readonly string[],
): Promise<Result<string>> => {
  if (!validZone(values.tz)) return { ok: false, error: `unknown timezone: ${values.tz}` };
  if (command === "extract") return runExtract(values, rest);
  if (command === "cite") return runCite(values, rest);
  return { ok: false, error: USAGE };
};

type Values = Readonly<{
  run?: string;
  main?: string;
  out?: string;
  tz?: string;
  projects?: string;
  "gate-time"?: string;
  context?: string;
  full?: boolean;
}>;

const runExtract = async (values: Values, rest: readonly string[]): Promise<Result<string>> => {
  if (!values.out || rest.length > 0 || (!values.run && !values.main)) {
    return { ok: false, error: USAGE };
  }
  const shared = { out: values.out, zone: values.tz, gateTime: values["gate-time"] };
  if (values.run) {
    return extractRun({
      ...shared,
      runDir: runDirOf(process.cwd(), values.run),
      projectsDir: values.projects ?? join(homedir(), ".claude", "projects"),
    });
  }
  return extractMain({ ...shared, main: values.main ?? "" });
};

const runCite = (values: Values, rest: readonly string[]): Result<string> => {
  const [transcript, ...lineArgs] = rest;
  const lines = lineArgs.map(Number);
  const context = Number(values.context ?? 0);
  if (!transcript || lines.length === 0 || lines.some(Number.isNaN) || Number.isNaN(context)) {
    return { ok: false, error: USAGE };
  }
  if (!existsSync(transcript)) return { ok: false, error: `no transcript at ${transcript}` };
  const text = citeLines({
    transcript,
    lines,
    context,
    zone: values.tz,
    full: values.full ?? false,
  });
  return { ok: true, value: text };
};

if (import.meta.main) {
  await main(process.argv.slice(2));
}
