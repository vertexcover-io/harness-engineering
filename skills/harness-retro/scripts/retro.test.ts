import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, EventSchema, runDirOf } from "@harness/sdk";
import {
  citeLines,
  extractMain,
  extractRun,
  findGateTime,
  readRunSessions,
  readStages,
} from "./retro.ts";

const at = (minute: number): string => `2026-10-03T10:${String(minute).padStart(2, "0")}:00Z`;

type Row = Readonly<Record<string, unknown>>;

const event = (type: string, ts: string, payload: Row, nodeId?: string): Event =>
  EventSchema.parse({
    schemaVersion: 1,
    seq: 1,
    id: `${type}@${ts}`,
    ts,
    type,
    source: "test",
    runId: "r-1",
    ...(nodeId ? { nodeId, nodeRunId: `nr-${nodeId}` } : {}),
    payload,
  });

const started = (sessions: readonly Row[]): Event =>
  event("workflow.started", at(0), { workflow: "task", inputs: {}, activeSessions: sessions });

const stop = (ts: string, agent: string, sessionId: string): Event =>
  event("hooks.stop.called", ts, { agent, sessionId, decision: "allow" });

const user = (ts: string, content: unknown): Row => ({
  type: "user",
  timestamp: ts,
  message: { role: "user", content },
});

const jsonl = (rows: readonly Row[]): string => rows.map((row) => JSON.stringify(row)).join("\n");

// A run folder holding event.jsonl beside a fake ~/.claude/projects with one transcript per id.
const fixture = (
  events: readonly Event[],
  transcripts: Readonly<Record<string, readonly Row[]>>,
): Readonly<{ runDir: string; out: string; projectsDir: string }> => {
  const base = mkdtempSync(join(tmpdir(), "retro-"));
  const runDir = runDirOf(base, "run-x");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "event.jsonl"), jsonl(events));
  const projectsDir = join(base, "projects");
  const slug = join(projectsDir, "-Users-x-repo");
  mkdirSync(slug, { recursive: true });
  for (const [id, rows] of Object.entries(transcripts)) {
    writeFileSync(join(slug, `${id}.jsonl`), jsonl(rows));
  }
  return { runDir, out: join(base, "out"), projectsDir };
};

const read = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");

describe("a run's sessions", () => {
  test("SC13: sessions come from workflow.started and later events in first-seen order, once each; Claude sessions get main-K folders and the Codex one is marked skipped", async () => {
    const events = [
      started([{ agent: "claude", sessionId: "A" }]),
      stop(at(1), "claude", "A"),
      stop(at(2), "claude", "A"),
      stop(at(3), "claude", "B"),
      stop(at(4), "codex", "C"),
    ];
    expect(readRunSessions(events)).toEqual([
      { agent: "claude", sessionId: "A" },
      { agent: "claude", sessionId: "B" },
      { agent: "codex", sessionId: "C" },
    ]);

    const { runDir, out, projectsDir } = fixture(events, {
      A: [user(at(1), "hello")],
      B: [user(at(3), "again")],
    });
    const result = await extractRun({ runDir, out, projectsDir, zone: "UTC" });

    expect(result.ok).toBe(true);
    expect(existsSync(join(out, "main-1", "01-spine.txt"))).toBe(true);
    expect(existsSync(join(out, "main-2", "01-spine.txt"))).toBe(true);
    expect(existsSync(join(out, "main-3"))).toBe(false);
    const run = read(out, "00-run.txt");
    expect(run).toMatch(/main-1\s+claude\s+A\s+\S+A\.jsonl/);
    expect(run).toMatch(/main-3\s+codex\s+C\s+.*codex transcripts are not read/);
  });

  test("SC14: a session whose transcript is missing is listed as skipped while the rest extract; with no transcript at all extraction fails naming the projects folder", async () => {
    const events = [started([{ agent: "claude", sessionId: "A" }]), stop(at(1), "claude", "B")];
    const some = fixture(events, { A: [user(at(1), "hello")] });
    const result = await extractRun({ ...some, zone: "UTC" });

    expect(result.ok).toBe(true);
    expect(existsSync(join(some.out, "main-1", "00-summary.txt"))).toBe(true);
    expect(existsSync(join(some.out, "main-2"))).toBe(false);
    expect(read(some.out, "00-run.txt")).toMatch(
      /main-2\s+claude\s+B\s+skipped: transcript not found/,
    );

    const none = fixture(events, {});
    const failed = await extractRun({ ...none, zone: "UTC" });
    expect(failed).toEqual({ ok: false, error: expect.stringContaining(none.projectsDir) });
  });
});

const nodeEvent = (kind: string, ts: string, nodeId: string, payload: Row = {}): Event =>
  event(`workflow.node.${kind}`, ts, { nodeType: "agent", ...payload }, nodeId);

describe("the plan gate", () => {
  test("SC15: a message after the planning node completed is POST-GATE in the spine, the summary counts it and prints the gate; with no planning node the gate is NOT FOUND until --gate-time sets it", async () => {
    const planned = [
      started([{ agent: "claude", sessionId: "A" }]),
      nodeEvent("started", at(0), "planning"),
      nodeEvent("completed", "2026-10-03T12:00:00Z", "planning"),
    ];
    const transcript = [
      user("2026-10-03T11:50:00Z", "approve the plan"),
      user("2026-10-03T12:10:00Z", "wait, the header is wrong"),
    ];
    expect(findGateTime(planned)).toBe("2026-10-03T12:00:00Z");

    const gated = fixture(planned, { A: transcript });
    const result = await extractRun({ ...gated, zone: "UTC" });
    expect(result.ok).toBe(true);
    const spine = read(join(gated.out, "main-1"), "01-spine.txt");
    expect(spine).toContain("===== TYPED main-1.jsonl:1 @ 10-03 11:50:00");
    expect(spine).toContain("===== TYPED POST-GATE main-1.jsonl:2 @ 10-03 12:10:00");
    expect(spine).toContain("THE LINE — plan gate at 10-03 12:00:00. 1 message(s) follow.");
    const summary = read(join(gated.out, "main-1"), "00-summary.txt");
    expect(summary).toMatch(/plan gate\s+10-03 12:00:00/);
    expect(summary).toMatch(/post-gate msgs\s+1\b/);

    const unplanned = fixture([started([{ agent: "claude", sessionId: "A" }])], { A: transcript });
    await extractRun({ ...unplanned, zone: "UTC" });
    expect(read(join(unplanned.out, "main-1"), "00-summary.txt")).toMatch(/plan gate\s+NOT FOUND/);

    const forced = fixture([started([{ agent: "claude", sessionId: "A" }])], { A: transcript });
    await extractRun({ ...forced, zone: "UTC", gateTime: "2026-10-03T12:00:00Z" });
    expect(read(join(forced.out, "main-1"), "00-summary.txt")).toMatch(/post-gate msgs\s+1\b/);
  });
});

describe("the stage table", () => {
  test("SC16: every node run gets a row with its status; completed and failed rows carry start, end and duration, and a skipped node has no start", async () => {
    const events = [
      started([{ agent: "claude", sessionId: "A" }]),
      nodeEvent("started", at(0), "design"),
      nodeEvent("completed", at(5), "design"),
      nodeEvent("started", at(5), "implement"),
      nodeEvent("failed", at(7), "implement", { error: { kind: "agent", message: "boom" } }),
      nodeEvent("skipped", at(7), "commit", { skip: { reason: "when" } }),
    ];
    expect(readStages(events)).toEqual([
      { nodeId: "design", status: "completed", start: at(0), end: at(5) },
      { nodeId: "implement", status: "failed", start: at(5), end: at(7) },
      { nodeId: "commit", status: "skipped", start: undefined, end: at(7) },
    ]);

    const run = fixture(events, { A: [user(at(1), "hi")] });
    await extractRun({ ...run, zone: "UTC" });
    const rows = read(run.out, "09-stages.txt").trim().split("\n").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^design\s+completed\s+10-03 10:00:00\s+10-03 10:05:00\s+5m$/);
    expect(rows[1]).toMatch(/^implement\s+failed\s+10-03 10:05:00\s+10-03 10:07:00\s+2m$/);
    expect(rows[2]).toMatch(/^commit\s+skipped\s+\?\s+10-03 10:07:00\s*$/);
  });
});

describe("cite", () => {
  test("SC17: line 3 with context 1 prints lines 2 to 4, each headed with the transcript name, line and time; a tool call shows its name and input and a flagged result shows RESULT ERROR", () => {
    const dir = mkdtempSync(join(tmpdir(), "retro-cite-"));
    const transcript = join(dir, "main-1.jsonl");
    writeFileSync(
      transcript,
      jsonl([
        user(at(0), "start"),
        {
          type: "assistant",
          timestamp: at(1),
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "bun test" } }],
          },
        },
        user(at(2), [
          { type: "tool_result", tool_use_id: "t1", content: "1 fail", is_error: true },
        ]),
        { type: "assistant", timestamp: at(3), message: { role: "assistant", content: "fixing" } },
        user(at(4), "thanks"),
      ]),
    );

    const out = citeLines({ transcript, lines: [3], context: 1, zone: "UTC", full: false });

    expect(out).toContain("--- main-1.jsonl:2 @ 10-03 10:01:00 [assistant]");
    expect(out).toContain("--- main-1.jsonl:3 @ 10-03 10:02:00 [user]");
    expect(out).toContain("--- main-1.jsonl:4 @ 10-03 10:03:00 [assistant]");
    expect(out).not.toContain("main-1.jsonl:1 ");
    expect(out).not.toContain("main-1.jsonl:5 ");
    expect(out).toContain('[TOOL Bash]\n{\n "command": "bun test"\n}');
    expect(out).toContain("[RESULT ERROR]\n1 fail");
  });
});

const call = (ts: string, id: string, name: string, input: Row): Row => ({
  type: "assistant",
  timestamp: ts,
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});

const toolResult = (ts: string, id: string, content: string): Row =>
  user(ts, [{ type: "tool_result", tool_use_id: id, content }]);

describe("the detector files", () => {
  test("a question and its answer, an interrupt, and a human asking what a document meant each reach the summary and their file", async () => {
    const run = fixture([started([{ agent: "claude", sessionId: "A" }])], {
      A: [
        call(at(0), "q1", "AskUserQuestion", { questions: [{ question: "Approve?" }] }),
        toolResult(at(1), "q1", "Approve the design"),
        { type: "user", timestamp: at(2), interruptedMessageId: "m-9", message: { content: "" } },
        user(at(3), "what does this mean? the plan is not clear"),
      ],
    });
    await extractRun({ ...run, zone: "UTC" });
    const dir = join(run.out, "main-1");

    const summary = read(dir, "00-summary.txt");
    expect(summary).toMatch(/AskUserQuestion\s+1\b/);
    expect(summary).toMatch(/incident flags\s+1\b/);
    expect(summary).toMatch(/unreadable docs\s+1\b/);
    expect(read(dir, "05-ask-user.txt")).toContain(
      "===== ANSWER main-1.jsonl:2 (asked main-1.jsonl:1)\nApprove the design",
    );
    expect(read(dir, "08-incidents.txt")).toContain(
      "main-1.jsonl:3 @ 10-03 10:02:00 | interruptedMessageId = m-9",
    );
    expect(read(dir, "01-spine.txt")).toContain("===== TYPED UNREADABLE main-1.jsonl:4");
  });

  test("a key printed by an earlier stage is masked in every file the extractor writes", async () => {
    const run = fixture([started([{ agent: "claude", sessionId: "A" }])], {
      A: [
        call(at(0), "t1", "Bash", {
          command: "curl -H 'Authorization: Bearer abcdef0123456789abcdef'",
        }),
        toolResult(at(1), "t1", "LINEAR_API_KEY=lin_api_0123456789abcdefghijABCD"),
      ],
    });
    await extractRun({ ...run, zone: "UTC" });
    const calls = read(join(run.out, "main-1"), "03-tool-calls.txt");

    expect(calls).toContain("Bearer REDACTED");
    expect(calls).not.toContain("abcdef0123456789abcdef");
  });
});

describe("extract --main", () => {
  test("one transcript with no run is extracted as main-1, with no stage table and the gate only from --gate-time", () => {
    const dir = mkdtempSync(join(tmpdir(), "retro-main-"));
    const main = join(dir, "session.jsonl");
    writeFileSync(main, jsonl([user(at(0), "start"), user(at(20), "later")]));
    const out = join(dir, "out");

    const result = extractMain({ main, out, zone: "UTC", gateTime: at(10) });

    expect(result.ok).toBe(true);
    expect(read(join(out, "main-1"), "00-summary.txt")).toMatch(/post-gate msgs\s+1\b/);
    expect(existsSync(join(out, "09-stages.txt"))).toBe(false);
    expect(extractMain({ main: join(dir, "nope.jsonl"), out, zone: "UTC" }).ok).toBe(false);
  });
});
