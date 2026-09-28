import { beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Event, type JsonValue, type State, StateSchema } from "./contracts.ts";
import { type IEventStore, jsonlEventStore } from "./event-store.ts";
import {
  createState,
  type EventHandlers,
  projectEvents,
  readGit,
  syncState,
  toRepoId,
} from "./state.ts";

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
    currentFile: typeof opened.payload === "string" ? opened.payload : null,
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
    expect(first).toEqual({ ...seed, currentFile: "b.ts", lastEventSeq: 2 });
  });

  test("unhandled and custom.* events advance only lastEventSeq", () => {
    const events = [event(1, "workflow.unknown"), event(2, "custom.acme.ping", { x: 1 })];
    expect(projectEvents({ state: seed, events, handlers })).toEqual({ ...seed, lastEventSeq: 2 });
  });

  test("a custom.* event is not routed to a handler registered under its type", () => {
    const customHandlers: EventHandlers = {
      "custom.acme.ping": (state) => ({ ...state, currentFile: "changed" }),
    };
    const events = [event(1, "custom.acme.ping")];
    expect(projectEvents({ state: seed, events, handlers: customHandlers })).toEqual({
      ...seed,
      lastEventSeq: 1,
    });
  });

  test("events at or below lastEventSeq are skipped", () => {
    const state = { ...seed, lastEventSeq: 1, currentFile: "kept.ts" };
    const events = [event(1, "workflow.file.opened", "old.ts")];
    expect(projectEvents({ state, events, handlers })).toEqual(state);
  });

  test("a handler that returns an invalid state throws", () => {
    const broken: EventHandlers = {
      "workflow.broken": (state) => ({ ...state, activeNodeRuns: ["ghost"] }),
    };
    expect(() =>
      projectEvents({ state: seed, events: [event(1, "workflow.broken")], handlers: broken }),
    ).toThrow(/ghost/);
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
    expect((await readdir(runDir)).sort()).toEqual(["artifacts", "event.jsonl", "state.json"]);
    expect((await readdir(join(runDir, "artifacts"))).filter((f) => f.includes("state"))).toEqual(
      [],
    );
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

const repoIn = async (name: string): Promise<string> => {
  const repo = join(await realpath(await mkdtemp(join(tmpdir(), "state-"))), name);
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  return repo;
};

describe("createState", () => {
  test("SC18: builds a valid first state from the run folder alone and writes it as state.json", async () => {
    const repo = await repoIn("Fix Login App");
    const runDir = join(repo, ".harness", "fix-login");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "workflow.yaml"), "name: demo\nnodes: []\n");

    const state = await createState(runDir, "1.0.0");

    expect(StateSchema.safeParse(state).success).toBe(true);
    expect(state).toMatchObject({
      lastEventSeq: 0,
      specName: "fix-login",
      workflow: { name: "demo", path: "workflow.yaml" },
      input: {},
    });
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
