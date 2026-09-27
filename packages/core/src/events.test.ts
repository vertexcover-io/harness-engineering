import { describe, expect, test } from "bun:test";
import { type Event, type JsonValue, type State, StateSchema } from "./contracts.ts";
import { memoryEventStore } from "./event-store.ts";
import { coreHandlers, storeEmitter } from "./events.ts";
import { projectEvents } from "./state.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("storeEmitter", () => {
  test("workflow.started without a workflow name is refused and nothing is stored", async () => {
    const store = memoryEventStore();
    const result = await storeEmitter(store, { runId: "r-1" }).emit({
      type: "workflow.started",
      source: "test",
      payload: { inputs: {} },
    });
    expect(result.ok).toBe(false);
    expect(await store.read()).toEqual([]);
  });

  test("SC1: an event emitted with no id is stored as seq 1 with a UUID, the current time and the emitter's runId", async () => {
    const store = memoryEventStore();
    const before = Date.now();
    const result = await storeEmitter(store, { runId: "r-1" }).emit({
      type: "custom.skill.note",
      source: "test",
      payload: { a: 1 },
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({ seq: 1, runId: "r-1", payload: { a: 1 } });
    expect(result.value.id).toMatch(UUID);
    expect(Date.parse(result.value.ts)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(result.value.ts)).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await store.read()).toEqual([result.value]);
  });

  test("SC2: a second emit with the same caller id returns the first event and stores nothing new", async () => {
    const store = memoryEventStore();
    const emitter = storeEmitter(store, { runId: "r-1" });
    const note = { id: "e1", type: "custom.skill.note", source: "test" };
    const first = await emitter.emit({ ...note, payload: 1 });
    const second = await emitter.emit({ ...note, payload: 2 });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ ok: true, value: { seq: 1, payload: 1 } });
    expect(await store.read()).toHaveLength(1);
  });

  test("SC3: workflow.node.failed without an error is refused, naming the type, and nothing is stored", async () => {
    const store = memoryEventStore();
    const result = await storeEmitter(store, { runId: "r-1" }).emit({
      type: "workflow.node.failed",
      source: "test",
      nodeId: "a",
      nodeRunId: "a",
      payload: { nodeType: "exec", attempts: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("workflow.node.failed");
    expect(await store.read()).toEqual([]);
  });

  test("SC4: workflow.node.started with a valid payload but no node ids is refused and nothing is stored", async () => {
    const store = memoryEventStore();
    const result = await storeEmitter(store, { runId: "r-1" }).emit({
      type: "workflow.node.started",
      source: "test",
      payload: { nodeType: "exec" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("workflow.node.started");
    if (!result.ok) expect(result.error).toContain("nodeId");
    expect(await store.read()).toEqual([]);
  });

  test("SC5: an event type outside the catalog is stored with any JSON payload", async () => {
    const result = await storeEmitter(memoryEventStore(), { runId: "r-1" }).emit({
      type: "custom.skill.note",
      source: "test",
      payload: [1, "two", null],
    });
    expect(result).toMatchObject({ ok: true, value: { payload: [1, "two", null] } });
  });
});

const seed: State = {
  schemaVersion: 1,
  lastEventSeq: 0,
  specName: "add-login",
  harnessVersion: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: {},
  scope: "feature",
  options: {},
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  outcome: null,
  currentFile: null,
  workspace: {
    path: "/work",
    repositories: {
      app: { path: "/work", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  activeNodeRuns: [],
  nodeRuns: {},
};

const nodeEvent = (
  seq: number,
  outcome: string,
  ids: { nodeId: string; nodeRunId: string },
  payload: JsonValue,
): Event => ({
  schemaVersion: 1,
  seq,
  id: `evt-${seq}`,
  ts: `2026-09-26T10:00:0${seq}Z`,
  type: `workflow.node.${outcome}`,
  source: "test",
  runId: "r-1",
  ...ids,
  payload,
});

const project = (events: readonly Event[]): State =>
  projectEvents({ state: seed, events, handlers: coreHandlers });

const build = { nodeId: "build", nodeRunId: "build" };

describe("coreHandlers", () => {
  test("workflow.started sets the run's startedAt to the event's time", () => {
    const state = project([
      {
        schemaVersion: 1,
        seq: 1,
        id: "workflow-started",
        ts: "2026-09-27T09:00:00Z",
        type: "workflow.started",
        source: "test",
        runId: "r-1",
        payload: { workflow: "feature", inputs: {} },
      },
    ]);
    expect(state.startedAt).toBe("2026-09-27T09:00:00Z");
  });

  test("SC6: a started node is running and active, with index 1 and no artifacts", () => {
    const state = project([nodeEvent(1, "started", build, { nodeType: "exec" })]);
    expect(state.nodeRuns.build).toEqual({
      nodeRunId: "build",
      nodeId: "build",
      index: 1,
      status: "running",
      startedAt: "2026-09-26T10:00:01Z",
      completedAt: null,
      result: null,
      artifacts: [],
    });
    expect(state.activeNodeRuns).toEqual(["build"]);
  });

  test("SC7: a failed node records status, end time and its error, and leaves the active list", () => {
    const message = "x".repeat(500);
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "exec" }),
      nodeEvent(2, "failed", build, {
        nodeType: "exec",
        attempts: 2,
        error: { kind: "exit", message },
      }),
    ]);
    expect(state.nodeRuns.build).toMatchObject({
      status: "failed",
      startedAt: "2026-09-26T10:00:01Z",
      completedAt: "2026-09-26T10:00:02Z",
      result: message,
    });
    expect(state.activeNodeRuns).toEqual([]);
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("SC8: a node that is skipped without starting still appears, with a reason and no start time", () => {
    const lint = { nodeId: "lint", nodeRunId: "lint" };
    const state = project([nodeEvent(1, "skipped", lint, { nodeType: "exec", attempts: 0 })]);
    expect(state.nodeRuns.lint).toMatchObject({
      status: "skipped",
      startedAt: null,
      result: "skipped by the workflow",
      index: 1,
    });
  });

  test("SC9: a second run of the same node gets index 2", () => {
    const state = project([
      nodeEvent(1, "started", { nodeId: "x", nodeRunId: "loop[1].x" }, { nodeType: "exec" }),
      nodeEvent(2, "started", { nodeId: "x", nodeRunId: "loop[2].x" }, { nodeType: "exec" }),
    ]);
    expect(state.nodeRuns["loop[1].x"]?.index).toBe(1);
    expect(state.nodeRuns["loop[2].x"]?.index).toBe(2);
  });
});
