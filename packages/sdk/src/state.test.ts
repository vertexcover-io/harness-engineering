import { beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, type JsonValue, type State, StateSchema } from "./contracts.ts";
import { type IEventStore, jsonlEventStore } from "./event-store.ts";
import { runDirOf } from "./events.ts";
import {
  appendRunEvent,
  appendRunEventIf,
  createState,
  type EventHandler,
  type EventHandlers,
  emitRunEvent,
  projectEvents,
  readGit,
  syncState,
  toRepoId,
} from "./state.ts";

test("conditional event append admits only one caller for the same state", async () => {
  const { run, runDir } = await runWithHandlers({});
  const append = (source: string) =>
    appendRunEventIf(
      run,
      { type: "custom.once.note", source, payload: null },
      (state) => state?.lastEventSeq === 0,
    );
  const results = await Promise.all([append("first"), append("second")]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)).toMatchObject({
    ok: false,
    error: "condition-failed",
  });
  expect(await jsonlEventStore(runDir).read()).toHaveLength(1);
});

test("conditional append checks the event log when state.json is behind", async () => {
  const { run, runDir, stateJson } = await runWithHandlers({});
  const store = jsonlEventStore(runDir);
  const prior = await store.append({
    id: "already-stored",
    ts: new Date().toISOString(),
    runId: run.id,
    type: "custom.once.note",
    source: "prior",
    payload: null,
  });
  expect(prior.ok).toBe(true);

  const attempted = await appendRunEventIf(
    run,
    { type: "custom.once.note", source: "late", payload: null },
    (state) => state?.lastEventSeq === 0,
  );

  expect(attempted).toMatchObject({ ok: false, error: "condition-failed" });
  expect(await store.read()).toHaveLength(1);
  expect((await stateJson()).lastEventSeq).toBe(1);
});

const seed: State = {
  schemaVersion: 1,
  lastEventSeq: 0,
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
};

const event = (seq: number, type: string, payload: JsonValue = null): Event => ({
  schemaVersion: 1,
  seq,
  id: `evt-${seq}`,
  ts: "2026-09-26T10:00:00Z",
  type,
  source: "test",
  runId: "r-test",
  payload,
});

const handlers: EventHandlers = {
  "workflow.file.opened": (state, opened) => ({
    ...state,
    input: { file: opened.payload },
  }),
};

describe("projectEvents", () => {
  test("folding the same seed, events, and handlers twice yields equal states", () => {
    const events = [
      event(1, "workflow.file.opened", "a.ts"),
      event(2, "workflow.file.opened", "b.ts"),
    ];
    const first = projectEvents({ state: seed, events, handlers });
    expect(first).toEqual(projectEvents({ state: seed, events, handlers }));
    expect(first).toEqual({ ...seed, input: { file: "b.ts" }, lastEventSeq: 2 });
  });

  test("unhandled and custom.* events advance only lastEventSeq", () => {
    const events = [event(1, "workflow.unknown"), event(2, "custom.acme.ping", { x: 1 })];
    expect(projectEvents({ state: seed, events, handlers })).toEqual({ ...seed, lastEventSeq: 2 });
  });

  test("EH5 — the built-in handler runs first, then each extension in listed order on the state the last one returned", () => {
    const seen =
      (label: string): EventHandler =>
      (state) => {
        const before = state.custom?.seen;
        const seenSoFar = Array.isArray(before) ? before : [];
        return { ...state, custom: { seen: [...seenSoFar, `${label}:${state.input.file}`] } };
      };
    const extensions = { "workflow.file.opened": [seen("first"), seen("second")] };
    const events = [event(1, "workflow.file.opened", "a.ts")];

    expect(projectEvents({ state: seed, events, handlers, extensions }).custom).toEqual({
      seen: ["first:a.ts", "second:a.ts"],
    });
  });

  test("EH6 — a custom.* event reaches the extension handlers registered for its type", () => {
    const extensions = {
      "custom.review.note": [
        (state: State, note: Event): State => ({ ...state, custom: { note: note.payload } }),
      ],
    };
    const events = [event(1, "custom.review.note", "looks good")];

    expect(projectEvents({ state: seed, events, handlers, extensions })).toEqual({
      ...seed,
      custom: { note: "looks good" },
      lastEventSeq: 1,
    });
  });

  test("events at or below lastEventSeq are skipped", () => {
    const state = { ...seed, lastEventSeq: 1, input: { file: "kept.ts" } };
    const events = [event(1, "workflow.file.opened", "old.ts")];
    expect(projectEvents({ state, events, handlers })).toEqual(state);
  });

  test("a handler that returns an invalid state throws", () => {
    const broken: EventHandlers = {
      "workflow.broken": (state) => ({ ...state, runName: "Not A Slug" }),
    };
    expect(() =>
      projectEvents({ state: seed, events: [event(1, "workflow.broken")], handlers: broken }),
    ).toThrow(/runName/);
  });
});

describe("syncState", () => {
  let runDir = "";
  beforeEach(async () => {
    runDir = await mkdtemp(join(tmpdir(), "run-"));
    await writeFile(join(runDir, "state.json"), JSON.stringify(seed));
  });

  const append = async (id: string, payload: string): Promise<void> => {
    const result = await jsonlEventStore(runDir).append({
      id,
      ts: "2026-09-26T10:00:00Z",
      type: "workflow.file.opened",
      source: "test",
      runId: "r-test",
      payload,
    });
    if (!result.ok) throw new Error(result.error);
  };

  const readState = async (): Promise<unknown> =>
    JSON.parse(await readFile(join(runDir, "state.json"), "utf8"));

  test("a stale state.json catches up from events appended after its cursor", async () => {
    await append("a", "a.ts");
    await syncState(runDir);
    await append("b", "b.ts");
    await append("c", "c.ts");

    const state = await syncState(runDir);

    expect(state).toEqual({ ...seed, lastEventSeq: 3 });
    expect(await readState()).toEqual(state);
  });

  test("a folder with no state.json yet is left alone and gives null", async () => {
    const bare = await mkdtemp(join(tmpdir(), "run-"));
    await jsonlEventStore(bare).append({
      id: "a",
      ts: "2026-09-26T10:00:00Z",
      type: "workflow.file.opened",
      source: "test",
      runId: "r-test",
      payload: "a.ts",
    });

    expect(await syncState(bare)).toBeNull();
    expect(await readdir(bare)).not.toContain("state.json");
  });

  test("writing state.json leaves no temp files behind and adds no run-folder entries", async () => {
    await append("a", "a.ts");
    await syncState(runDir);
    expect((await readdir(runDir)).sort()).toEqual([
      "artifacts",
      "event.jsonl",
      "locks",
      "state.json",
    ]);
    expect(await readdir(join(runDir, "artifacts"))).toEqual([]);
    expect(await readdir(join(runDir, "locks"))).toEqual([]);
  });

  test("a truncated event line is surfaced as an error, not skipped", async () => {
    await append("a", "a.ts");
    await writeFile(join(runDir, "event.jsonl"), '{"seq":', { flag: "a" });
    await expect(syncState(runDir)).rejects.toThrow(/line 2/);
  });

  test("a slow sync that finishes last cannot overwrite a newer state.json", async () => {
    const opened = (seq: number, file: string): Event => event(seq, "workflow.file.opened", file);
    const releaseSlowRead = Promise.withResolvers<void>();
    let reads = 0;
    const store: IEventStore = {
      append: () => Promise.reject(new Error("unused")),
      read: async () => {
        reads += 1;
        if (reads > 1) return [opened(1, "a.ts"), opened(2, "b.ts")];
        await releaseSlowRead.promise;
        return [opened(1, "a.ts")];
      },
    };

    const slow = syncState(runDir, store);
    await Bun.sleep(20);
    const fast = syncState(runDir, store);
    await Bun.sleep(20);
    releaseSlowRead.resolve();
    await Promise.all([slow, fast]);

    expect(await readState()).toEqual({ ...seed, lastEventSeq: 2 });
  });
});

const HANDLER_MODULE = `export const onReviewNote = (state, event) => ({ ...state, custom: { ...state.custom, note: event.payload } });
export const onStarted = (state) => ({ ...state, custom: { ...state.custom, input: state.input } });
export const notAFunction = 1;
export const onRisky = (state, event) => {
  if (event.payload === "bad") throw new Error("cannot apply a bad note");
  return { ...state, custom: { ...state.custom, note: event.payload } };
};
export const onBadShape = (state) => ({ ...state, runName: "Not A Slug" });
`;

// A run folder whose state.json lists the given handlers from a module written beside it.
const runWithHandlers = async (
  refs: Readonly<Record<string, readonly { module?: string; handler: string }[]>>,
) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "handlers-")));
  const module = join(cwd, "review-state.ts");
  await writeFile(module, HANDLER_MODULE);
  const eventHandlers = Object.fromEntries(
    Object.entries(refs).map(([type, list]) => [
      type,
      list.map((ref) => ({ module: ref.module ?? module, handler: ref.handler })),
    ]),
  );
  const run = { id: "r-test", cwd, name: "fix-login" };
  const runDir = runDirOf(cwd, run.name);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "state.json"), JSON.stringify({ ...seed, eventHandlers }));
  const stateJson = async (): Promise<State> =>
    StateSchema.parse(JSON.parse(await readFile(join(runDir, "state.json"), "utf8")));
  return { run, runDir, stateJson };
};

describe("emitRunEvent", () => {
  test.each(["workflow.node.completed", "orchestrate.done", "hooks.session-start.called"])(
    "SC8: refuses the engine-owned %s and leaves the log untouched",
    async (type) => {
      const { run, runDir } = await runWithHandlers({});

      const result = await emitRunEvent(run, { type, source: "ext", payload: {} });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.error).toStartWith(type);
      expect(await jsonlEventStore(runDir).read()).toHaveLength(0);
    },
  );

  test("SC9: a custom event lands in the log and state.json in the same call", async () => {
    const { run, stateJson } = await runWithHandlers({});

    const result = await emitRunEvent(run, { type: "custom.ext.note", source: "ext", payload: {} });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await stateJson()).lastEventSeq).toBe(result.value.seq);
  });
});

describe("emitRunEvent with extension handlers", () => {
  test("EH7 — a custom.* event's extension handler writes state.custom into state.json", async () => {
    const { run, stateJson } = await runWithHandlers({
      "custom.review.note": [{ handler: "onReviewNote" }],
    });

    const result = await emitRunEvent(run, {
      type: "custom.review.note",
      source: "test",
      payload: "looks good",
    });

    expect(result.ok).toBe(true);
    expect((await stateJson()).custom).toEqual({ note: "looks good" });
  });

  test("EH8 — an extension on a built-in type sees the state the built-in handler wrote", async () => {
    const { run, stateJson } = await runWithHandlers({
      "workflow.started": [{ handler: "onStarted" }],
    });

    await appendRunEvent(run, {
      type: "workflow.started",
      source: "test",
      payload: { workflow: "feature", inputs: { ticket: "T-1" } },
    });

    expect((await stateJson()).custom).toEqual({ input: { ticket: "T-1" } });
  });

  test.each([
    [
      "a module that does not exist",
      { module: "/nowhere/review-state.ts", handler: "onReviewNote" },
      "/nowhere/review-state.ts",
    ],
    ["an export that is missing", { handler: "onMissing" }, "onMissing"],
    ["an export that is not a function", { handler: "notAFunction" }, "notAFunction"],
  ])("EH9 — %s fails the emit, naming it, and stores nothing", async (_label, ref, named) => {
    const { run, runDir, stateJson } = await runWithHandlers({ "custom.review.note": [ref] });

    const result = await emitRunEvent(run, {
      type: "custom.review.note",
      source: "test",
      payload: "looks good",
    });

    expect(result.ok ? "" : result.error).toContain(named);
    expect(result.ok ? "" : result.error).toContain(ref.handler);
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
    expect((await stateJson()).lastEventSeq).toBe(0);
  });

  test.each([
    ["throws", "onRisky"],
    ["returns a state that fails the schema", "onBadShape"],
  ])(
    "EH13 — a handler that %s fails the emit and stores nothing, so later events still apply",
    async (_label, handler) => {
      const { run, runDir, stateJson } = await runWithHandlers({
        "custom.review.note": [{ handler }],
        "custom.review.other": [{ handler: "onReviewNote" }],
      });

      const bad = await emitRunEvent(run, {
        type: "custom.review.note",
        source: "test",
        payload: "bad",
      });
      const good = await emitRunEvent(run, {
        type: "custom.review.other",
        source: "test",
        payload: "fine",
      });

      expect(bad.ok ? "" : bad.error).toContain("event not stored");
      expect(good.ok).toBe(true);
      expect((await jsonlEventStore(runDir).read()).map((event) => event.type)).toEqual([
        "custom.review.other",
      ]);
      expect(await stateJson()).toMatchObject({ lastEventSeq: 1, custom: { note: "fine" } });
    },
  );

  test("EH14 — a handler module that throws while loading fails the emit and stores nothing", async () => {
    const { run, runDir } = await runWithHandlers({
      "custom.review.note": [{ handler: "onReviewNote" }],
    });
    const broken = join(run.cwd, "broken.ts");
    await writeFile(
      broken,
      'throw new Error("module is broken");\nexport const onReviewNote = () => {};\n',
    );
    const state = StateSchema.parse(JSON.parse(await readFile(join(runDir, "state.json"), "utf8")));
    await writeFile(
      join(runDir, "state.json"),
      JSON.stringify({
        ...state,
        eventHandlers: { "custom.review.note": [{ module: broken, handler: "onReviewNote" }] },
      }),
    );

    const result = await emitRunEvent(run, {
      type: "custom.review.note",
      source: "test",
      payload: "looks good",
    });

    expect(result.ok ? "" : result.error).toContain("module is broken");
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
  });
});

const repoIn = async (name: string): Promise<string> => {
  const repo = join(await realpath(await mkdtemp(join(tmpdir(), "state-"))), name);
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
};

describe("createState", () => {
  test("SC18: builds a valid first state from the run folder and the frozen handler list, and writes it as state.json", async () => {
    const repo = await repoIn("Fix Login App");
    const runDir = join(repo, ".harness", "fix-login");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "workflow.yaml"), "name: demo\nnodes: []\n");

    const eventHandlers = { "custom.review.note": [{ module: "/abs/review.ts", handler: "f" }] };

    const state = await createState({
      runId: "r-42",
      runDir,
      version: "1.0.0",
      eventHandlers,
    });

    expect(StateSchema.safeParse(state).success).toBe(true);
    expect(state).toMatchObject({
      lastEventSeq: 0,
      runId: "r-42",
      runName: "fix-login",
      runDir,
      version: "1.0.0",
      workflow: { name: "demo", path: "workflow.yaml" },
      input: {},
      scope: null,
      completedAt: null,
      status: "running",
      eventHandlers,
    });
    expect(state).not.toHaveProperty("custom");
    expect(state).not.toHaveProperty("options");
    expect(state).not.toHaveProperty("currentFile");
    expect(state.workspace.type).toBe("mono");
    expect(state.workspace.path).toBe(repo);
    expect(Object.keys(state.workspace.repositories)).toEqual(["fix-login-app"]);
    expect(JSON.parse(await readFile(join(runDir, "state.json"), "utf8"))).toEqual(state);
  });
});

describe("readGit", () => {
  test("SC21: baseBranch equals branch when the repo has no origin", async () => {
    const git = await readGit(await repoIn("repo"));

    expect(git.branch).toBe("main");
    expect(git.baseBranch).toBe(git.branch);
  });
});

test.each([
  ["apiServer", "api-server"],
  ["api", "api"],
  ["My_Repo.v2", "my-repo-v2"],
  ["harness-engineering", "harness-engineering"],
  ["___", "repo"],
])("WS16 — toRepoId(%s) is %s", (name, id) => {
  expect(toRepoId(name)).toBe(id);
});

describe("state files written before activeSessions", () => {
  test("SC9: a state without activeSessions loads with it empty and every other field unchanged", () => {
    const { activeSessions: _omitted, ...legacy } = seed;

    const parsed = StateSchema.parse(legacy);

    expect(parsed).toEqual(seed);
  });
});
