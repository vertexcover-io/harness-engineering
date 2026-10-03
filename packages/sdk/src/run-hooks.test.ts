import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, HookRef, HookRefs, JsonValue, State } from "./contracts.ts";
import { jsonlEventStore } from "./event-store.ts";
import { emitEvent, type RunRef, runDirOf } from "./events.ts";
import { runLockPath } from "./files.ts";
import { spawn } from "./process.ts";
import { callHook, runInBackground, selectHooks } from "./run-hooks.ts";
import { appendRunEvent, createState, readState } from "./state.ts";

const state: State = {
  schemaVersion: 1,
  lastEventSeq: 1,
  runId: "r-test",
  runName: "add-login",
  runDir: "/work/.harness/add-login",
  version: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/work",
    repositories: {
      app: { path: "/work", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  nodeRuns: {},
  activeSessions: [],
  eventHandlers: {},
  hooks: {},
};

const event = (type: string, payload: JsonValue = null): Event => ({
  schemaVersion: 1,
  seq: 1,
  id: "evt-1",
  ts: "2026-09-26T10:00:00Z",
  type,
  source: "test",
  runId: "r-test",
  payload,
});

const HOOK_MODULE = `
export const throws = () => { throw new Error("boom"); };
export const never = () => new Promise(() => {});
export const ticket = () => ({ id: "T-1" });
export const nothing = () => {};
export const long = () => "x".repeat(20_000);
`;

let dir = "";
beforeAll(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "run-hooks-")));
  await writeFile(join(dir, "hooks.ts"), HOOK_MODULE);
});

const moduleHook = (handler: string, timeoutSeconds = 5): HookRef => ({
  name: "m",
  blocking: true,
  timeoutSeconds,
  module: join(dir, "hooks.ts"),
  handler,
});

const commandHook = (command: string, timeoutSeconds = 5): HookRef => ({
  name: "c",
  blocking: true,
  timeoutSeconds,
  command,
  cwd: dir,
});

const input = {
  event: event("workflow.started"),
  state,
  run: { id: state.runId, cwd: "/repo", name: state.runName },
};

describe("callHook", () => {
  test.each([
    ["a module whose export throws", () => moduleHook("throws"), "boom"],
    [
      "a module path that does not exist",
      (): HookRef => ({ ...moduleHook("throws"), module: "/nowhere/hooks.ts" }),
      "module not found",
    ],
    [
      "a command exiting 3 with boom on stderr",
      () => commandHook("echo boom >&2; exit 3"),
      "exit 3: boom",
    ],
    ["a command sleeping past its timeout", () => commandHook("sleep 5", 1), "timed out after 1s"],
    ["a module export that never resolves", () => moduleHook("never", 1), "timed out after 1s"],
  ])("SC104: %s is a failed call naming the cause", async (_label, hook, cause) => {
    const call = await callHook(hook(), input);

    expect(call.status).toBe("failed");
    if (call.status !== "failed") return;
    expect(call.error.kind).not.toBe("");
    expect(call.error.message).toContain(cause);
  });

  test.each([
    ["a module returning { id: T-1 }", () => moduleHook("ticket"), { id: "T-1" }],
    ["a module returning nothing", () => moduleHook("nothing"), undefined],
    ["a command printing JSON", () => commandHook(`echo '{"ok":true}'`), { ok: true }],
    ["a command printing done", () => commandHook("echo done"), "done"],
    ["a module returning 20,000 characters", () => moduleHook("long"), "x".repeat(10_000)],
  ])("SC105: %s records that as the call's output", async (_label, hook, output) => {
    const call = await callHook(hook(), input);

    expect(call).toEqual(output === undefined ? { status: "ok" } : { status: "ok", output });
  });
});

describe("selectHooks", () => {
  const named = (name: string): HookRef => ({ ...commandHook("true"), name });
  const called = (hook: string): Event =>
    event("hooks.hook.called", {
      hook,
      eventId: "evt-0",
      eventSeq: 1,
      eventType: "workflow.started",
    });

  test.each([
    [
      "a workflow.started event with [a, b] on it",
      { "workflow.started": [named("a"), named("b")] },
      event("workflow.started"),
      ["a", "b"],
    ],
    ["a type with no hooks", { "workflow.started": [named("a")] }, event("workflow.completed"), []],
    [
      "the record of another hook's call",
      { "hooks.hook.called": [named("watch")] },
      called("asana"),
      ["watch"],
    ],
    [
      "the record of the hook's own call",
      { "hooks.hook.called": [named("watch")] },
      called("watch"),
      [],
    ],
  ])(
    "SC106: %s gives its hooks in frozen order, minus the hook's own record",
    (_label, hooks, stored, names) => {
      expect(selectHooks({ ...state, hooks }, stored).map((hook) => hook.name)).toEqual(names);
    },
  );
});

const STATE_MODULE = join(import.meta.dir, "state.ts");

const INTEGRATION_MODULE = `
import { emitRunEvent } from "${STATE_MODULE}";
export const seen = ({ event }) => ({ seen: event.type });
export const throws = () => { throw new Error("bad hook"); };
export const fine = () => "fine";
export const thread = async ({ event, state, run }) => {
  await Bun.sleep(300);
  if (state.custom?.thread !== undefined) return { threadId: state.custom.thread };
  const threadId = "t-" + event.seq;
  await emitRunEvent(run, { type: "custom.state.updated", source: "test", payload: { thread: threadId } });
  return { threadId };
};
export const ticking = () => {
  setInterval(() => {}, 1000);
  return new Promise(() => {});
};
export const pong = async ({ run }) => {
  await emitRunEvent(run, { type: "custom.demo.pong", source: "test", payload: null });
};
`;

// Prints a field of the hook input it reads on stdin, as JSON.
const printInput = (field: string): string =>
  `${process.execPath} -e 'console.log(JSON.stringify((await Bun.stdin.json()).event.${field}))'`;

type Spec = Readonly<
  { name: string; blocking?: boolean; timeoutSeconds?: number } & (
    | { handler: string }
    | { command: string }
  )
>;

const runWithHooks = async (specs: Readonly<Record<string, readonly Spec[]>>) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "run-hooks-run-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const module = join(cwd, "hooks.ts");
  await writeFile(module, INTEGRATION_MODULE);
  const hooks: HookRefs = Object.fromEntries(
    Object.entries(specs).map(([type, list]) => [
      type,
      list.map(({ blocking, timeoutSeconds, ...spec }) => {
        const fields = {
          name: spec.name,
          blocking: blocking ?? true,
          timeoutSeconds: timeoutSeconds ?? 10,
        };
        return "handler" in spec
          ? { ...fields, module, handler: spec.handler }
          : { ...fields, command: spec.command, cwd };
      }),
    ]),
  );
  const run: RunRef = { id: "r-hooks", cwd, name: "demo" };
  const runDir = runDirOf(cwd, run.name);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "workflow.yaml"), "name: demo\nnodes: []\n");
  await createState({ runId: run.id, runDir, version: "2.0.0", eventHandlers: {}, hooks });
  const calls = async () =>
    (await jsonlEventStore(runDir).read()).filter((stored) => stored.type === "hooks.hook.called");
  return { run, runDir, cwd, calls };
};

const ping = (id?: string) => ({
  type: "custom.demo.ping",
  source: "test",
  payload: null,
  ...(id === undefined ? {} : { id }),
});

const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
  const deadline = Date.now() + 5000;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await Bun.sleep(50);
  }
};

describe("appendRunEvent with run hooks", () => {
  test("SC110: blocking hooks run in order and are recorded before the append returns", async () => {
    const { run, calls } = await runWithHooks({
      "custom.demo.ping": [
        { name: "a", handler: "seen" },
        { name: "b", command: printInput("type") },
      ],
    });

    const appended = await appendRunEvent(run, ping());

    if (!appended.ok) throw new Error(appended.error);
    const stored = appended.value.event;
    const common = {
      eventId: stored.id,
      eventSeq: stored.seq,
      eventType: "custom.demo.ping",
      blocking: true,
      status: "ok",
    };
    expect((await calls()).map((call) => call.payload)).toEqual([
      {
        hook: "a",
        ...common,
        durationMs: expect.any(Number),
        output: { seen: "custom.demo.ping" },
      },
      { hook: "b", ...common, durationMs: expect.any(Number), output: "custom.demo.ping" },
    ]);
  });

  test("SC111: storing the same event id again runs no hook again", async () => {
    const { run, calls } = await runWithHooks({
      "custom.demo.ping": [
        { name: "a", handler: "seen" },
        { name: "b", command: printInput("type") },
      ],
    });
    const first = await appendRunEvent(run, ping("ping-1"));

    const again = await appendRunEvent(run, ping("ping-1"));

    expect(again.ok && first.ok && again.value.event).toEqual(first.ok && first.value.event);
    expect(await calls()).toHaveLength(2);
  });

  test("SC112: a blocking module hook that throws is recorded like a failed command and does not stop the next hook or the append", async () => {
    const { run, runDir, calls } = await runWithHooks({
      "custom.demo.ping": [
        { name: "bad", handler: "throws" },
        { name: "good", handler: "fine" },
      ],
    });

    const appended = await appendRunEvent(run, ping());

    expect(appended.ok).toBe(true);
    expect((await calls()).map((call) => call.payload)).toMatchObject([
      { hook: "bad", status: "failed", error: { kind: "exit", message: "exit 1: bad hook" } },
      { hook: "good", status: "ok", output: "fine" },
    ]);
    expect((await readState(runDir))?.status).toBe("running");
  });

  test("SC113: a non-blocking hook runs after the append returns and records its own call", async () => {
    const { run, calls } = await runWithHooks({
      "custom.demo.ping": [{ name: "slow", blocking: false, command: "sleep 1; echo done" }],
    });

    const started = Date.now();
    await appendRunEvent(run, ping());

    expect(Date.now() - started).toBeLessThan(500);
    expect(await calls()).toEqual([]);
    const recorded = await until(calls, (found) => found.length > 0);
    expect(recorded.map((call) => call.payload)).toMatchObject([
      { hook: "slow", blocking: false, status: "ok", output: "done" },
    ]);
  }, 10_000);

  test("SC114: one hook's non-blocking calls never overlap", async () => {
    const seq = printInput("seq");
    const { run, cwd, calls } = await runWithHooks({
      "custom.demo.ping": [
        {
          name: "order",
          blocking: false,
          command: `s=$(${seq}); echo "start $s" >> order.txt; sleep 0.3; echo "end $s" >> order.txt`,
        },
      ],
    });

    await appendRunEvent(run, ping());
    await appendRunEvent(run, ping());
    await until(calls, (found) => found.length === 2);

    const lines = (await readFile(join(cwd, "order.txt"), "utf8")).trim().split("\n");
    const [first, second] = [lines[0]?.split(" ")[1], lines[2]?.split(" ")[1]];
    expect(lines).toEqual([`start ${first}`, `end ${first}`, `start ${second}`, `end ${second}`]);
    expect(new Set([first, second])).toEqual(new Set(["1", "2"]));
  }, 10_000);

  test("a blocking module hook that holds a timer past its 1s timeout lets the appending process exit, recorded as a timeout", async () => {
    const { run, calls } = await runWithHooks({
      "custom.demo.ping": [{ name: "tick", handler: "ticking", timeoutSeconds: 1 }],
    });
    const append = `import { appendRunEvent } from "${STATE_MODULE}";
await appendRunEvent(${JSON.stringify(run)}, { type: "custom.demo.ping", source: "test", payload: null });`;

    const started = Date.now();
    const result = await spawn(process.execPath, ["-e", append], {
      cwd: run.cwd,
      timeoutMs: 10_000,
    });

    expect(result.stopped).toBeNull();
    expect(Date.now() - started).toBeLessThan(4000);
    expect((await calls()).map((call) => call.payload)).toMatchObject([
      { hook: "tick", status: "failed", error: { kind: "timeout", message: "timed out after 1s" } },
    ]);
  }, 15_000);

  test("SC115: a blocking hook may store an event of its own, which fires its own hooks", async () => {
    const { run, runDir, calls } = await runWithHooks({
      "custom.demo.ping": [{ name: "ponger", handler: "pong" }],
      "custom.demo.pong": [{ name: "listener", command: "true" }],
    });

    const appended = await appendRunEvent(run, ping());

    expect(appended.ok).toBe(true);
    const types = (await jsonlEventStore(runDir).read()).map((stored) => stored.type);
    expect(types).toContain("custom.demo.pong");
    expect((await calls()).map((call) => call.payload)).toMatchObject([
      { hook: "listener", eventType: "custom.demo.pong", status: "ok" },
      { hook: "ponger", eventType: "custom.demo.ping", status: "ok" },
    ]);
  });

  test("a runner for the second event first fires the hook's unrecorded call for the first event, in seq order", async () => {
    const { run, runDir, calls } = await runWithHooks({
      "custom.demo.ping": [{ name: "late", blocking: false, command: printInput("seq") }],
    });
    const store = jsonlEventStore(runDir);
    const first = await emitEvent(store, run.id, ping());
    const second = await emitEvent(store, run.id, ping());
    if (!first.ok || !second.ok) throw new Error("events not stored");

    await runInBackground(run, second.value.id, "late");

    expect((await calls()).map((call) => call.payload)).toMatchObject([
      { hook: "late", eventId: first.value.id, output: 1 },
      { hook: "late", eventId: second.value.id, output: 2 },
    ]);
  });

  test("a runner facing a stale lock from a dead process records a failed call of kind lock for its event", async () => {
    const { run, runDir, calls } = await runWithHooks({
      "custom.demo.ping": [{ name: "late", blocking: false, command: "true" }],
    });
    const stored = await emitEvent(jsonlEventStore(runDir), run.id, ping());
    if (!stored.ok) throw new Error(stored.error);
    const lockDir = runLockPath(runDir, "hook-late");
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, "owner"), String(Bun.spawnSync(["true"]).pid));

    await runInBackground(run, stored.value.id, "late");

    expect((await calls()).map((call) => call.payload)).toMatchObject([
      {
        hook: "late",
        eventId: stored.value.id,
        status: "failed",
        error: { kind: "lock", message: expect.stringContaining("Stale lock") },
      },
    ]);
  });

  test("a non-blocking hook's second call reads the value its first call stored with custom.state.updated", async () => {
    const { run, calls } = await runWithHooks({
      "custom.demo.ping": [{ name: "thread", blocking: false, handler: "thread" }],
    });

    await appendRunEvent(run, ping());
    await appendRunEvent(run, ping());
    const recorded = await until(calls, (found) => found.length === 2);

    expect(recorded.map((call) => call.payload)).toMatchObject([
      { hook: "thread", eventSeq: 1, status: "ok", output: { threadId: "t-1" } },
      { hook: "thread", eventSeq: 2, status: "ok", output: { threadId: "t-1" } },
    ]);
  }, 10_000);
});
