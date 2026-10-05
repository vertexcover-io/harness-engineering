import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, type JsonValue, type State, StateSchema } from "./contracts.ts";
import { jsonlEventStore, memoryEventStore } from "./event-store.ts";
import {
  builtInHandlers,
  emitEvent,
  foldModelSwitch,
  runDirOf,
  WorkspaceCreatedEvent,
} from "./events.ts";
import { emitRunEvent, projectEvents } from "./state.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("emitEvent", () => {
  test("workflow.started without a workflow name is refused and nothing is stored", async () => {
    const store = memoryEventStore();
    const result = await emitEvent(store, "r-1", {
      type: "workflow.started",
      source: "test",
      payload: { inputs: {} },
    });
    expect(result.ok).toBe(false);
    expect(await store.read()).toEqual([]);
  });

  test("SC1: an event emitted with no id is stored as seq 1 with a UUID, the current time and the given runId", async () => {
    const store = memoryEventStore();
    const before = Date.now();
    const result = await emitEvent(store, "r-1", {
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
    const note = { id: "e1", type: "custom.skill.note", source: "test" };
    const first = await emitEvent(store, "r-1", { ...note, payload: 1 });
    const second = await emitEvent(store, "r-1", { ...note, payload: 2 });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ ok: true, value: { seq: 1, payload: 1 } });
    expect(await store.read()).toHaveLength(1);
  });

  test("SC3: workflow.node.failed without an error is refused, naming the type, and nothing is stored", async () => {
    const store = memoryEventStore();
    const result = await emitEvent(store, "r-1", {
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
    const result = await emitEvent(store, "r-1", {
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
    const result = await emitEvent(memoryEventStore(), "r-1", {
      type: "custom.skill.note",
      source: "test",
      payload: [1, "two", null],
    });
    expect(result).toMatchObject({ ok: true, value: { payload: [1, "two", null] } });
  });

  test.each([
    ["orchestrate.exec", "without its input", { output: { kind: "error", message: "x" } }],
    [
      "orchestrate.verifier",
      "without its verifier",
      { attempt: 1, durationMs: 3, status: "passed", findings: [] },
    ],
    [
      "orchestrate.done",
      "with a report missing its status",
      {
        input: { nodeRunId: "nr-1", output: {}, artifacts: [] },
        output: { nodeRunId: "nr-1", nodeId: "a", attempts: 1 },
      },
    ],
    [
      "orchestrate.done",
      "without a status",
      {
        input: { nodeRunId: "nr-1", output: {}, artifacts: [] },
        output: { nodeRunId: "nr-1", nodeId: "a", status: "completed", attempts: 1 },
      },
    ],
    [
      "orchestrate.done",
      "with an unknown status",
      {
        input: { nodeRunId: "nr-1", output: {}, artifacts: [] },
        output: { nodeRunId: "nr-1", nodeId: "a", status: "completed", attempts: 1 },
        status: "refused",
      },
    ],
    [
      "orchestrate.done",
      "with neither an output nor an error",
      {
        input: { nodeRunId: "nr-1", artifacts: [] },
        output: { nodeRunId: "nr-1", nodeId: "a", status: "completed", attempts: 1 },
      },
    ],
    [
      "orchestrate.done",
      "with both an output and an error",
      {
        input: { nodeRunId: "nr-1", output: {}, error: "no", artifacts: [] },
        output: { nodeRunId: "nr-1", nodeId: "a", status: "completed", attempts: 1 },
      },
    ],
  ])("%s %s is refused and nothing is stored", async (type, _case, payload) => {
    const store = memoryEventStore();
    const result = await emitEvent(store, "r-1", { type, source: "orchestrate", payload });
    expect(result.ok ? "" : result.error).toContain(type);
    expect(await store.read()).toEqual([]);
  });

  test("workflow.node.skipped without a skip reason is refused, naming skip, and nothing is stored", async () => {
    const store = memoryEventStore();
    const result = await emitEvent(store, "r-1", {
      type: "workflow.node.skipped",
      source: "test",
      nodeId: "a",
      nodeRunId: "a",
      payload: { nodeType: "exec", attempts: 0 },
    });
    expect(result.ok ? "" : result.error).toContain("skip");
    expect(await store.read()).toEqual([]);
  });

  test.each([
    ["completed", { output: "hi\n" }],
    ["failed", { error: { kind: "exit", message: "exit 1" } }],
  ])("workflow.node.%s carries a script's process record", async (outcome, fields) => {
    const result = await emitEvent(memoryEventStore(), "r-1", {
      type: `workflow.node.${outcome}`,
      source: "test",
      nodeId: "a",
      nodeRunId: "a",
      payload: {
        nodeType: "exec",
        attempts: 1,
        process: { stdout: "hi\n", stderr: "", exitCode: 0 },
        ...fields,
      },
    });
    expect(result.ok).toBe(true);
  });

  test.each([
    ["failed", { error: { kind: "exit", message: "exit 1" } }],
    ["cancelled", {}],
    [
      "skipped",
      { skip: { reason: "when-false", proof: { expression: "{{ false }}", value: false } } },
    ],
  ])("workflow.node.%s refuses an output it would never record", async (outcome, fields) => {
    const result = await emitEvent(memoryEventStore(), "r-1", {
      type: `workflow.node.${outcome}`,
      source: "test",
      nodeId: "a",
      nodeRunId: "a",
      payload: { nodeType: "exec", attempts: 1, output: "hi\n", ...fields },
    });
    expect(result.ok).toBe(false);
  });

  test.each([
    ["failed", { error: { kind: "exit", message: "exit 1" } }],
    ["cancelled", {}],
  ])("workflow.node.%s refuses a skip it would never record", async (outcome, fields) => {
    const result = await emitEvent(memoryEventStore(), "r-1", {
      type: `workflow.node.${outcome}`,
      source: "test",
      nodeId: "a",
      nodeRunId: "a",
      payload: {
        nodeType: "exec",
        attempts: 1,
        skip: { reason: "when-false", proof: { expression: "{{ false }}", value: false } },
        ...fields,
      },
    });
    expect(result.ok).toBe(false);
  });

  test.each([
    ["an error", { error: { kind: "exit", message: "exit 1" } }],
    [
      "a skip",
      { skip: { reason: "when-false", proof: { expression: "{{ false }}", value: false } } },
    ],
  ])("workflow.node.completed refuses %s beside its output", async (_, fields) => {
    const result = await emitEvent(memoryEventStore(), "r-1", {
      type: "workflow.node.completed",
      source: "test",
      nodeId: "a",
      nodeRunId: "a",
      payload: { nodeType: "exec", attempts: 1, output: "hi\n", ...fields },
    });
    expect(result.ok).toBe(false);
  });
});

describe("emitRunEvent", () => {
  test("SC31: stores the event in the run's .yok/NAME folder with the run's id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "repo-"));
    const run = { id: "r-1", cwd, name: "fix-login" };

    const result = await emitRunEvent(run, {
      type: "custom.skill.note",
      source: "test",
      payload: { a: 1 },
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({ seq: 1, runId: "r-1" });
    expect(runDirOf(cwd, "fix-login")).toBe(join(cwd, ".yok", "fix-login"));
    expect(await jsonlEventStore(runDirOf(cwd, "fix-login")).read()).toEqual([result.value]);
  });

  test("brings the run's state.json up to date, so a workspace event moves state.workspace", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "repo-"));
    const run = { id: "r-1", cwd, name: "fix-login" };
    const dir = runDirOf(cwd, "fix-login");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "state.json"), JSON.stringify(seed));

    const result = await emitRunEvent(run, {
      type: "workspace.created",
      source: "test",
      payload: createdPayload("multi", { api: repository(`${WS_DIR}/api`) }),
    });

    if (!result.ok) throw new Error(result.error);
    const state = StateSchema.parse(JSON.parse(await readFile(join(dir, "state.json"), "utf8")));
    expect(state.lastEventSeq).toBe(1);
    expect(state.workspace.type).toBe("multi");
    expect(state.workspace.path).toBe(WS_DIR);
    expect(Object.keys(state.workspace.repositories)).toEqual(["api"]);
  });

  test("leaves a run folder with no state.json yet without one", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "repo-"));
    const run = { id: "r-1", cwd, name: "fix-login" };

    const result = await emitRunEvent(run, {
      type: "custom.skill.note",
      source: "test",
      payload: {},
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(runDirOf(cwd, "fix-login"), "state.json"))).toBe(false);
  });
});

const seed: State = {
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "add-login",
  runDir: "/work/.yok/add-login",
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
  tiers: null,
  nodeRuns: {},
  activeSessions: [],
  eventHandlers: {},
  hooks: {},
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
  projectEvents({ state: seed, events, handlers: builtInHandlers });

const build = { nodeId: "build", nodeRunId: "build" };
const skip = { reason: "when-false", proof: { expression: "inputs.quick", value: false } };

describe("builtInHandlers", () => {
  test("workflow.session.replaced swaps the old session for the new one in activeSessions", () => {
    const replaced = (seq: number, previousSessionId: string, sessionId: string): Event => ({
      schemaVersion: 1,
      seq,
      id: `evt-${seq}`,
      ts: "2026-09-27T09:00:00Z",
      type: "workflow.session.replaced",
      source: "orchestrate",
      runId: "r-1",
      payload: { agent: "claude", previousSessionId, sessionId },
    });
    const state = projectEvents({
      state: { ...seed, activeSessions: [{ agent: "claude", sessionId: "A" }] },
      events: [replaced(1, "A", "B"), replaced(2, "gone", "C")],
      handlers: builtInHandlers,
    });

    expect(state.activeSessions).toEqual([
      { agent: "claude", sessionId: "B" },
      { agent: "claude", sessionId: "C" },
    ]);
  });

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

  test("SC6: a started node is kept under its own id, running, with its run id and no artifacts", () => {
    const state = project([nodeEvent(1, "started", build, { nodeType: "exec" })]);
    expect(state.nodeRuns.build).toEqual({
      nodeRunId: "build",
      nodeType: "exec",
      status: "running",
      startedAt: "2026-09-26T10:00:01Z",
      completedAt: null,
      artifacts: [],
    });
  });

  test("SC7: a failed node records status, end time and its error as output, without the stack or process", () => {
    const message = "x".repeat(500);
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "exec" }),
      nodeEvent(2, "failed", build, {
        nodeType: "exec",
        attempts: 2,
        error: { kind: "exit", message, stack: "Error: exit\n    at run" },
        process: { stdout: "", stderr: "boom", exitCode: 1 },
      }),
    ]);
    expect(state.nodeRuns.build).toEqual({
      nodeRunId: "build",
      nodeType: "exec",
      status: "failed",
      startedAt: "2026-09-26T10:00:01Z",
      completedAt: "2026-09-26T10:00:02Z",
      artifacts: [],
      output: { kind: "exit", message },
    });
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("SC8: a node that is skipped without starting still appears, started and ended at the skip, with its skip as output", () => {
    const lint = { nodeId: "lint", nodeRunId: "lint" };
    const state = project([nodeEvent(1, "skipped", lint, { nodeType: "exec", attempts: 0, skip })]);
    expect(state.nodeRuns.lint).toEqual({
      nodeRunId: "lint",
      nodeType: "exec",
      status: "skipped",
      startedAt: "2026-09-26T10:00:01Z",
      completedAt: "2026-09-26T10:00:01Z",
      artifacts: [],
      output: skip,
    });
  });

  test("a completed script node keeps only its output value in state; the process record stays in the event", () => {
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "exec" }),
      nodeEvent(2, "completed", build, {
        nodeType: "exec",
        attempts: 1,
        output: { pass: true },
        process: { stdout: '{"pass":true}', stderr: "", exitCode: 0 },
      }),
    ]);
    expect(state.nodeRuns.build?.output).toEqual({ pass: true });
    expect(JSON.stringify(state)).not.toContain("stdout");
  });

  test.each([
    [
      "with an error records it as output",
      { error: { kind: "cancelled", message: "stopped" } },
      { kind: "cancelled", message: "stopped" },
    ],
    ["without an error has no output", {}, undefined],
  ])("a cancelled node %s", (_label, extra, output) => {
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "agent" }),
      nodeEvent(2, "cancelled", build, { nodeType: "agent", attempts: 1, ...extra }),
    ]);
    expect(state.nodeRuns.build?.status).toBe("cancelled");
    expect(state.nodeRuns.build?.output).toEqual(output);
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("a loop cancelled without an error drops the output its last pass left", () => {
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "loop" }),
      nodeEvent(2, "iterated", build, { nodeType: "loop", iteration: 2, output: { pass: false } }),
      nodeEvent(3, "cancelled", build, { nodeType: "loop", attempts: 1 }),
    ]);
    expect(state.nodeRuns.build?.status).toBe("cancelled");
    expect(state.nodeRuns.build?.output).toBeUndefined();
  });

  test("IW8 — a node run holds the input from its started event and the output from its completed event; a pair without them projects as before", () => {
    const fresh = { nodeId: "fresh", nodeRunId: "nr-00000001" };
    const legacy = { nodeId: "legacy", nodeRunId: "legacy" };
    const state = project([
      nodeEvent(1, "started", fresh, { nodeType: "exec", input: { n: 1 } }),
      nodeEvent(2, "completed", fresh, { nodeType: "exec", attempts: 1, output: { n: 2 } }),
      nodeEvent(3, "started", legacy, { nodeType: "exec" }),
      nodeEvent(4, "completed", legacy, { nodeType: "exec", attempts: 1 }),
    ]);
    expect(state.nodeRuns.fresh).toMatchObject({
      nodeRunId: "nr-00000001",
      input: { n: 1 },
      output: { n: 2 },
    });
    expect(state.nodeRuns.legacy).not.toHaveProperty("input");
    expect(state.nodeRuns.legacy).not.toHaveProperty("output");
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("a node inside a container lands in that container's nodes, under its own id, at any depth", () => {
    const state = project([
      nodeEvent(
        1,
        "started",
        { nodeId: "fix", nodeRunId: "nr-1" },
        { nodeType: "loop", input: {} },
      ),
      nodeEvent(
        2,
        "skipped",
        { nodeId: "lint", nodeRunId: "nr-2" },
        {
          nodeType: "exec",
          attempts: 0,
          skip,
          parents: ["fix"],
        },
      ),
      nodeEvent(
        3,
        "started",
        { nodeId: "pick", nodeRunId: "nr-3" },
        {
          nodeType: "switch",
          branch: "a",
          parents: ["fix"],
        },
      ),
      nodeEvent(
        4,
        "started",
        { nodeId: "act", nodeRunId: "nr-4" },
        {
          nodeType: "exec",
          parents: ["fix", "pick"],
        },
      ),
    ]);
    expect(state.nodeRuns.fix).toMatchObject({ status: "running", iteration: 1 });
    expect(state.nodeRuns.fix?.nodes?.lint).toMatchObject({ nodeRunId: "nr-2", status: "skipped" });
    expect(state.nodeRuns.fix?.nodes?.pick).toMatchObject({ branch: "a", status: "running" });
    expect(state.nodeRuns.fix?.nodes?.pick?.nodes?.act).toMatchObject({ status: "running" });
    expect(Object.keys(state.nodeRuns)).toEqual(["fix"]);
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test("a node whose container is not in state is refused, naming the container", () => {
    expect(() =>
      project([
        nodeEvent(
          1,
          "started",
          { nodeId: "act", nodeRunId: "nr-1" },
          {
            nodeType: "exec",
            parents: ["ghost"],
          },
        ),
      ]),
    ).toThrow(/ghost/);
  });

  test("workflow.node.iterated moves a loop to its next pass: new pass number, last pass's output, children cleared", () => {
    const fix = { nodeId: "fix", nodeRunId: "nr-1" };
    const state = project([
      nodeEvent(1, "started", fix, { nodeType: "loop", input: {} }),
      nodeEvent(
        2,
        "completed",
        { nodeId: "test", nodeRunId: "nr-2" },
        {
          nodeType: "exec",
          attempts: 1,
          output: "p1",
          parents: ["fix"],
        },
      ),
      nodeEvent(3, "iterated", fix, { nodeType: "loop", iteration: 2, output: { test: "p1" } }),
    ]);
    expect(state.nodeRuns.fix).toMatchObject({
      nodeRunId: "nr-1",
      status: "running",
      iteration: 2,
      output: { test: "p1" },
      nodes: {},
    });
  });

  test("workflow.completed and workflow.failed set the run's status and completedAt", () => {
    const ended = (type: string): Event => ({
      schemaVersion: 1,
      seq: 1,
      id: "end",
      ts: "2026-09-28T09:00:00Z",
      type,
      source: "workflow",
      runId: "r-1",
      payload: {},
    });
    expect(project([ended("workflow.completed")])).toMatchObject({
      status: "completed",
      completedAt: "2026-09-28T09:00:00Z",
    });
    expect(project([ended("workflow.failed")]).status).toBe("failed");
  });

  test("SC9: a node started again replaces its entry, so state keeps only its latest run", () => {
    const state = project([
      nodeEvent(1, "started", { nodeId: "x", nodeRunId: "nr-1" }, { nodeType: "exec" }),
      nodeEvent(
        2,
        "completed",
        { nodeId: "x", nodeRunId: "nr-1" },
        {
          nodeType: "exec",
          attempts: 1,
          output: "first",
        },
      ),
      nodeEvent(3, "started", { nodeId: "x", nodeRunId: "nr-2" }, { nodeType: "exec" }),
    ]);
    expect(state.nodeRuns.x).toEqual({
      nodeRunId: "nr-2",
      nodeType: "exec",
      status: "running",
      startedAt: "2026-09-26T10:00:03Z",
      completedAt: null,
      artifacts: [],
    });
  });
});

const SHA = "3f2c9ab41d0e8c7b6a5f4e3d2c1b0a9f8e7d6c5b";

const repository = (worktreeDir: string, overrides: Record<string, string> = {}) => ({
  name: "api",
  worktreeDir,
  checkoutDir: "/meta/api",
  baseBranch: "main",
  startSha: SHA,
  ...overrides,
});

const createdPayload = (
  layout: "mono" | "multi",
  repositories: Record<string, ReturnType<typeof repository>>,
) => ({ layout, branch: "feat-x", workspaceDir: "/meta/.workspaces/feat-x", repositories });

describe("workspace event schemas", () => {
  const issuePaths = (payload: unknown): string[] => {
    const parsed = WorkspaceCreatedEvent.safeParse({ payload });
    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
  };

  test("WS40 — a mono workspace.created with two repositories fails", () => {
    const dir = "/meta/.workspaces/feat-x";
    const payload = createdPayload("mono", { api: repository(dir), web: repository(dir) });
    expect(issuePaths(payload)).toContain("payload.repositories");
  });

  test("WS40 — a short startSha fails, naming startSha", () => {
    const payload = createdPayload("multi", {
      api: repository("/meta/.workspaces/feat-x/api", { startSha: "3f2c9ab" }),
    });
    expect(issuePaths(payload)).toEqual(["payload.repositories.api.startSha"]);
  });

  test("WS24 — emitEvent refuses a bad workspace.created payload and a repository.added with no repoId, appending nothing", async () => {
    const store = memoryEventStore();
    const badCreated = await emitEvent(store, "r-1", {
      type: "workspace.created",
      source: "orchestrate",
      payload: createdPayload("multi", {
        api: repository("/meta/.workspaces/feat-x/api", { startSha: "abc" }),
      }),
    });
    const noRepoId = await emitEvent(store, "r-1", {
      type: "workspace.repository.added",
      source: "orchestrate",
      payload: {
        workspaceDir: "/meta/.workspaces/feat-x",
        branch: "feat-x",
        repository: repository("/meta/.workspaces/feat-x/api"),
      },
    });
    expect(badCreated.ok ? "" : badCreated.error).toContain("startSha");
    expect(noRepoId.ok ? "" : noRepoId.error).toContain("repoId");
    expect(await store.read()).toEqual([]);
  });

  test.each(["workspace.create-failed", "workspace.remove-failed"])(
    "%s with an error that names no repoId is refused, since only a repo's failure is recorded",
    async (type) => {
      const store = memoryEventStore();
      const result = await emitEvent(store, "r-1", {
        type,
        source: "orchestrate",
        payload: {
          workspaceDir: "/meta/.workspaces/feat-x",
          branch: "feat-x",
          errors: [{ kind: "setup", message: "broke" }],
        },
      });
      expect(result.ok ? "" : result.error).toContain("repoId");
      expect(await store.read()).toEqual([]);
    },
  );
});

const SHA_B = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d";
const WS_DIR = "/meta/.workspaces/feat-x";

const workspaceEvent = (seq: number, type: string, payload: JsonValue): Event => ({
  schemaVersion: 1,
  seq,
  id: `ws-${seq}`,
  ts: `2026-09-26T11:00:0${seq}Z`,
  type,
  source: "orchestrate",
  runId: "r-1",
  payload,
});

const workspaceHistory: readonly Event[] = [
  workspaceEvent(
    1,
    "workspace.created",
    createdPayload("multi", {
      api: repository(`${WS_DIR}/api`),
      web: repository(`${WS_DIR}/web`, { name: "web", checkoutDir: "/meta/web" }),
    }),
  ),
  workspaceEvent(2, "workspace.repository.removed", {
    workspaceDir: WS_DIR,
    branch: "feat-x",
    repoId: "web",
    name: "web",
    worktreeDir: `${WS_DIR}/web`,
  }),
  workspaceEvent(3, "workspace.repository.added", {
    workspaceDir: WS_DIR,
    branch: "feat-x",
    repoId: "docs",
    repository: repository(`${WS_DIR}/docs`, {
      name: "docs",
      checkoutDir: "/meta/docs",
      startSha: SHA_B,
    }),
  }),
];

describe("workspace reducers", () => {
  test("WS41 — created, then web removed, then docs added: the workspace points at workspaceDir and holds exactly api and docs", () => {
    const state = project(workspaceHistory);
    expect(state.workspace).toEqual({
      type: "multi",
      path: WS_DIR,
      repositories: {
        api: {
          path: `${WS_DIR}/api`,
          git: { branch: "feat-x", baseBranch: "main", startSha: SHA },
        },
        docs: {
          path: `${WS_DIR}/docs`,
          git: { branch: "feat-x", baseBranch: "main", startSha: SHA_B },
        },
      },
    });
  });

  test("WS42 — workspace.removed and workspace.create-failed leave state.workspace unchanged", () => {
    const before = project(workspaceHistory).workspace;
    const after = project([
      ...workspaceHistory,
      workspaceEvent(4, "workspace.removed", {
        workspaceDir: WS_DIR,
        branch: "feat-x",
        repositories: ["api", "docs"],
      }),
      workspaceEvent(5, "workspace.create-failed", {
        workspaceDir: WS_DIR,
        branch: "feat-x",
        errors: [{ repoId: "api", kind: "setup", message: "setup failed with exit code 1" }],
      }),
    ]);
    expect(after.workspace).toEqual(before);
    expect(after.lastEventSeq).toBe(5);
  });
});

describe("hooks.stop.called", () => {
  const called = {
    agent: "claude",
    sessionId: "s1",
    touchedRun: null,
    decision: "continue",
    reason: "node-not-done",
    blockStreak: 1,
    message: "m",
  };

  test("SC14 — a stop-called event records its block streak and seq in state", () => {
    const state = project([
      {
        schemaVersion: 1,
        seq: 7,
        id: "evt-7",
        ts: "2026-09-26T10:00:07Z",
        type: "hooks.stop.called",
        source: "hooks",
        runId: "r-1",
        payload: called,
      },
    ]);
    expect(state.stopHook).toEqual({ blockStreak: 1, seq: 7 });
  });

  test("SC14 — a stop-called event with an unknown decision is refused, naming the type", async () => {
    const store = memoryEventStore();
    const result = await emitEvent(store, "r-1", {
      type: "hooks.stop.called",
      source: "hooks",
      payload: { ...called, decision: "maybe" },
    });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("hooks.stop.called"),
    });
    expect(await store.read()).toEqual([]);
  });
});

describe("hooks.pre-tool-use.called", () => {
  const event = (seq: number, type: string, payload: JsonValue) => ({
    schemaVersion: 1 as const,
    seq,
    id: `evt-${seq}`,
    ts: "2026-09-26T10:00:07Z",
    type,
    source: "hooks",
    runId: "r-1",
    payload,
  });
  const stop = event(5, "hooks.stop.called", {
    agent: "claude",
    sessionId: "s1",
    touchedRun: null,
    decision: "continue",
    reason: "node-not-done",
    blockStreak: 1,
  });
  const tool = (seq: number) =>
    event(seq, "hooks.pre-tool-use.called", {
      agent: "claude",
      sessionId: "s1",
      tool: "Bash",
      decision: "allow",
    });

  test("SC13 — a tool-call event leaves the Stop hook's last check as it was", () => {
    expect(project([stop, tool(6)]).stopHook).toEqual({ blockStreak: 1, seq: 5 });
  });
});

describe("usage-limit events", () => {
  test.each([
    ["agent.limit.reached", { agent: "claude", sessionId: "s1" }],
    ["agent.limit.waiting", { sessionId: "s1", limitEventId: "e-1", resumeAt: "soon" }],
    ["agent.limit.resumed", { sessionId: "s1" }],
  ])(
    "%s with a bad payload is refused, naming the type, and nothing is stored",
    async (type, payload) => {
      const store = memoryEventStore();
      const result = await emitEvent(store, "r-1", { type, source: "hooks", payload });
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(type) });
      expect(await store.read()).toEqual([]);
    },
  );
});

describe("foldModelSwitch", () => {
  const LAUNCH = { model: "opus-x", effort: "high" } as const;
  const event = (seq: number, type: string, payload: JsonValue, ids = {}): Event => ({
    schemaVersion: 1,
    seq,
    id: `evt-${seq}`,
    ts: "2026-09-26T10:00:00Z",
    type,
    source: "test",
    runId: "r-1",
    ...ids,
    payload,
  });
  const requested = (seq: number, node = "loop.think") =>
    event(seq, "workflow.model.requested", { node, model: "sonnet-x" });
  const applied = (seq: number, requestSeq: number, result: object) =>
    event(seq, "workflow.model.applied", {
      requestSeq,
      node: "loop.think",
      model: "sonnet-x",
      ...result,
    });
  const thinkFailed = (seq: number, parents: readonly string[]) =>
    event(
      seq,
      "workflow.node.failed",
      {
        nodeType: "agent",
        parents: [...parents],
        attempts: 0,
        error: { kind: "exception", message: "x" },
      },
      { nodeId: "think", nodeRunId: `nr-${seq}` },
    );
  const NONE = { current: LAUNCH, pending: null, failed: null };

  test.each([
    ["no model events leave the session on the default tier's model", [], NONE],
    [
      "a request opens a pending switch with its seq",
      [requested(3)],
      { ...NONE, pending: { seq: 3, node: "loop.think", model: "sonnet-x" } },
    ],
    [
      "an applied: true answering seq 3 moves the session to sonnet-x and closes the request",
      [requested(3), applied(4, 3, { applied: true })],
      { ...NONE, current: { model: "sonnet-x" } },
    ],
    [
      "an applied: false answering seq 3 records the failure for loop.think and closes the request",
      [requested(3), applied(4, 3, { applied: false, reason: "respawn failed" })],
      { ...NONE, failed: { node: "loop.think", reason: "respawn failed" } },
    ],
    [
      "an applied answering an older request seq 2 is ignored and seq 3 stays pending",
      [requested(3), applied(4, 2, { applied: true })],
      { ...NONE, pending: { seq: 3, node: "loop.think", model: "sonnet-x" } },
    ],
    [
      "a failure of loop.think clears the failed switch",
      [
        requested(3),
        applied(4, 3, { applied: false, reason: "respawn failed" }),
        thinkFailed(5, ["loop"]),
      ],
      NONE,
    ],
    [
      "a failure of a think node at another path keeps the failed switch",
      [
        requested(3),
        applied(4, 3, { applied: false, reason: "respawn failed" }),
        thinkFailed(5, []),
      ],
      { ...NONE, failed: { node: "loop.think", reason: "respawn failed" } },
    ],
  ])("%s", (_label, events, expected) => {
    expect(foldModelSwitch(events, { default: "deep", models: { deep: LAUNCH } })).toEqual(
      expected,
    );
  });

  test("a run with no tiers starts on no model", () => {
    expect(foldModelSwitch([], null)).toEqual({ current: null, pending: null, failed: null });
  });
});
