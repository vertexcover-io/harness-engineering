import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, type JsonValue, type State, StateSchema } from "./contracts.ts";
import { jsonlEventStore, memoryEventStore } from "./event-store.ts";
import { builtInHandlers, emitEvent, runDirOf, WorkspaceCreatedEvent } from "./events.ts";
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
});

describe("emitRunEvent", () => {
  test("SC31: stores the event in the run's .harness/NAME folder with the run's id", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "repo-"));
    const run = { id: "r-1", cwd, name: "fix-login" };

    const result = await emitRunEvent(run, {
      type: "custom.skill.note",
      source: "test",
      payload: { a: 1 },
    });

    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({ seq: 1, runId: "r-1" });
    expect(runDirOf(cwd, "fix-login")).toBe(join(cwd, ".harness", "fix-login"));
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
  custom: {},
  eventHandlers: {},
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

describe("builtInHandlers", () => {
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

  test("BL11: artifact.created adds the ref to its node run, and a second with the same name replaces it", () => {
    const created = (seq: number, path: string): Event => ({
      ...nodeEvent(seq, "started", build, {}),
      type: "artifact.created",
      payload: { artifact: { name: "baseline", path } },
    });
    const report = { name: "report", path: "artifacts/report.md" };
    const state = project([
      nodeEvent(1, "started", build, { nodeType: "exec" }),
      { ...created(2, "artifacts/report.md"), payload: { artifact: report } },
      created(3, "artifacts/baseline.json"),
      created(4, "artifacts/baseline-2.json"),
    ]);
    expect(state.nodeRuns.build?.artifacts).toEqual([
      report,
      { name: "baseline", path: "artifacts/baseline-2.json" },
    ]);
  });

  test("BL11: artifact.created for a node run not in state leaves the state unchanged", () => {
    const state = project([
      {
        ...nodeEvent(1, "started", build, {}),
        type: "artifact.created",
        payload: { artifact: { name: "baseline", path: "artifacts/baseline.json" } },
      },
    ]);
    expect(state).toEqual({ ...seed, lastEventSeq: 1 });
  });

  test("BL11: emitEvent refuses an artifact.created whose path is outside artifacts/", async () => {
    const store = memoryEventStore();
    const result = await emitEvent(store, "r-1", {
      type: "artifact.created",
      source: "test",
      ...build,
      payload: { artifact: { name: "baseline", path: "baseline.json" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("artifact.created");
    expect(await store.read()).toEqual([]);
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
