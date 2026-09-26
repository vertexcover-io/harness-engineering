import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventDraft, type EventLog, jsonlEventLog } from "./event-log.ts";

const draft = (id: string, extra: Partial<EventDraft> = {}): EventDraft => ({
  id,
  ts: "2026-09-26T10:00:00Z",
  type: "workflow.node.started",
  source: "test",
  payload: { id },
  ...extra,
});

const logLines = async (taskDir: string): Promise<string[]> =>
  (await readFile(join(taskDir, "event.jsonl"), "utf8")).trim().split("\n");

let taskDir = "";
let log: EventLog;
beforeEach(async () => {
  taskDir = await mkdtemp(join(tmpdir(), "task-"));
  log = jsonlEventLog(taskDir);
});

describe("jsonlEventLog", () => {
  test("the first event gets seq 1 and only event.jsonl and artifacts/ appear in the task root", async () => {
    const result = await log.append(draft("a"));
    expect(result).toEqual({ ok: true, value: { schemaVersion: 1, seq: 1, ...draft("a") } });
    expect((await readdir(taskDir)).sort()).toEqual(["artifacts", "event.jsonl"]);
    expect(await log.read()).toEqual([{ schemaVersion: 1, seq: 1, ...draft("a") }]);
  });

  test("25 appends from 5 competing processes get seqs 1..25 with no duplicates", async () => {
    const script = join(taskDir, "..", `appender-${crypto.randomUUID()}.ts`);
    await writeFile(
      script,
      `import { jsonlEventLog } from ${JSON.stringify(join(import.meta.dir, "event-log.ts"))};
const [dir, worker] = process.argv.slice(2);
const log = jsonlEventLog(dir);
for (let i = 0; i < 5; i++) {
  const result = await log.append({
    id: worker + "-" + i, ts: "2026-09-26T10:00:00Z", type: "workflow.tick", source: "w", payload: null,
  });
  if (!result.ok) throw new Error(result.error);
}`,
    );
    const workers = ["w0", "w1", "w2", "w3", "w4"].map(
      (worker) => Bun.spawn(["bun", script, taskDir, worker], { stderr: "inherit" }).exited,
    );
    expect(await Promise.all(workers)).toEqual([0, 0, 0, 0, 0]);
    const events = await log.read();
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(events.map((event) => event.id)).size).toBe(25);
    expect(await readdir(join(taskDir, "artifacts"))).toEqual([]);
  }, 20_000);

  test("re-submitting an existing id returns the stored event and appends nothing", async () => {
    await log.append(draft("a"));
    await log.append(draft("b"));
    const repeat = await log.append(draft("a", { payload: "changed" }));
    expect(repeat).toEqual({ ok: true, value: { schemaVersion: 1, seq: 1, ...draft("a") } });
    expect(await logLines(taskDir)).toHaveLength(2);
  });

  test.each([
    ["a NaN payload", draft("a", { payload: { n: Number.NaN } }), /payload/],
    ["an unknown namespace", draft("a", { type: "billing.charged" }), /type/],
  ])("rejects %s without writing to the log", async (_label, invalid, message) => {
    const result = await log.append(invalid);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(message) });
    expect(await log.read()).toEqual([]);
  });

  test.each([
    ["a malformed line", "not json\n", /line 1/],
    [
      "a truncated final line",
      `${JSON.stringify({ schemaVersion: 1, seq: 1, ...draft("a") })}\n{"seq":`,
      /line 2/,
    ],
    ["a sequence gap", `${JSON.stringify({ schemaVersion: 1, seq: 2, ...draft("a") })}\n`, /seq/],
  ])("throws on %s instead of repairing it", async (_label, content, message) => {
    await writeFile(join(taskDir, "event.jsonl"), content);
    await expect(log.append(draft("b"))).rejects.toThrow(message);
    expect(await readFile(join(taskDir, "event.jsonl"), "utf8")).toBe(content);
  });

  test("a lock left by a dead process fails with the lock path instead of being broken", async () => {
    const lock = join(taskDir, "artifacts", ".event-log.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner"), "999999999");
    await expect(log.append(draft("a"))).rejects.toThrow(lock);
  });

  test("a lock with no owner file fails with the lock path instead of waiting forever", async () => {
    const lock = join(taskDir, "artifacts", ".event-log.lock");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "stray"), "");
    await expect(log.append(draft("a"))).rejects.toThrow(lock);
  }, 2_000);
});
