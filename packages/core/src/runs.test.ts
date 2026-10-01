import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGit,
  createRegistry,
  emitRunEvent,
  findRoot,
  type ITerminal,
  jsonlEventStore,
  noopLogger,
  resolveRun,
  StateSchema,
  type WorkflowRun,
} from "@harness/sdk";
import corePackage from "../package.json";
import { type InitOptions, initializeRun, linkRunSession, terminalName } from "./runs.ts";
import { currentPane } from "./tmux.ts";

const makeRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "r-1",
  workflow: "demo",
  workflowPath: "/abs/workflow.yaml",
  inputs: {},
  cwd: "/repos/demo",
  sessions: [],
  name: null,
  terminal: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "harness-run-")));
const gitCmd = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeRepo = (): string => {
  const dir = tempDir();
  gitCmd(dir, "init", "-q", "-b", "main");
  gitCmd(
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  return dir;
};

// A run `harness run` saved in a fresh git repo, not yet initialized.
const savedRun = async (overrides: Partial<WorkflowRun> = {}) => {
  const cwd = overrides.cwd ?? makeRepo();
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(workflowPath, "name: ok\nnodes: []\n");
  const registry = createRegistry(join(tempDir(), "registry.json"));
  const run = makeRun({ cwd, workflowPath, ...overrides });
  await registry.addRun(run);
  const init = (name: string, runId = run.id, extra: Partial<InitOptions> = {}) =>
    initializeRun({ registry, runId, name, git: createGit(), log: noopLogger, ...extra });
  return { cwd, workflowPath, registry, run, init };
};

describe("initializeRun", () => {
  test("SC19: writes workflow.yaml, one workflow.started event, a state.json with lastEventSeq 1 and the run's id, folder and running status, and names the run in the registry", async () => {
    const { cwd, workflowPath, registry, run, init } = await savedRun();

    const result = await init("fix-login");

    if (!result.ok) throw new Error(result.error);
    const dir = join(cwd, ".harness", "fix-login");
    expect(result.value.dir).toBe(dir);
    expect(readFileSync(join(dir, "workflow.yaml"), "utf8")).toBe(
      readFileSync(workflowPath, "utf8"),
    );
    const events = await jsonlEventStore(dir).read();
    expect(events).toMatchObject([
      { id: "workflow-started", type: "workflow.started", source: "orchestrate", seq: 1 },
    ]);
    expect(events[0]?.runId).toBe(run.id);
    expect(Math.abs(Date.now() - Date.parse(String(events[0]?.ts)))).toBeLessThan(1000);
    expect(result.value.state).toMatchObject({
      lastEventSeq: 1,
      runId: run.id,
      runName: "fix-login",
      runDir: dir,
      version: String(corePackage.version),
      status: "running",
      input: run.inputs,
      startedAt: events[0]?.ts,
    });
    expect((await registry.findRun(run.id))?.name).toBe("fix-login");
  });

  test("SC8: seeds activeSessions with the session harness run launched", async () => {
    const session = { agent: "claude", sessionId: "s1" } as const;
    const { init } = await savedRun({ sessions: [session] });

    const result = await init("fix-login");

    if (!result.ok) throw new Error(result.error);
    expect(result.value.state.activeSessions).toEqual([session]);
    const stored = JSON.parse(readFileSync(join(result.value.dir, "state.json"), "utf8"));
    expect(stored.activeSessions).toEqual([session]);
  });

  test("SC20: a second init, a run folder that already exists, a bad name, and an unknown run are each refused", async () => {
    const { cwd, init, registry, workflowPath } = await savedRun();
    expect((await init("fix-login")).ok).toBe(true);

    expect(await init("fix-login-2")).toEqual({
      ok: false,
      error: "run r-1 is already initialized as fix-login",
    });

    await registry.addRun(makeRun({ id: "r-2", cwd, workflowPath }));
    mkdirSync(join(cwd, ".harness", "dupe"), { recursive: true });
    expect(await init("dupe", "r-2")).toEqual({ ok: false, error: ".harness/dupe already exists" });

    const badName = await init("Bad Name", "r-2");
    expect(badName.ok ? "" : badName.error).toContain("Bad Name");
    expect((await registry.findRun("r-2"))?.name).toBeNull();

    expect(await init("fix-login", "r-missing")).toEqual({
      ok: false,
      error: "run r-missing not found",
    });
  });

  test("SC20: a run whose repo has an invalid config is refused, leaving no run folder and no name", async () => {
    const { cwd, init, registry, run } = await savedRun();
    writeFileSync(join(cwd, "orchestrate.config.json"), JSON.stringify({ packages: {} }));

    const result = await init("fix-login");

    expect(result.ok ? "" : result.error).toContain('expected "version: 2"');
    expect(existsSync(join(cwd, ".harness", "fix-login"))).toBe(false);
    expect((await registry.findRun(run.id))?.name).toBeNull();
  });

  test("EH10 — init freezes the config's event handlers with absolute modules, so a later config edit changes nothing", async () => {
    const cwd = makeRepo();
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(
      join(cwd, "scripts", "review-state.ts"),
      [
        "export const onReviewNote = (state, event) => ({ ...state, custom: { note: event.payload } });",
        "export const onOther = (state) => ({ ...state, custom: { other: true } });",
      ].join("\n"),
    );
    const config = (handler: string) =>
      writeFileSync(
        join(cwd, "orchestrate.config.json"),
        JSON.stringify({
          version: 2,
          eventHandlers: {
            "custom.review.note": [{ module: "scripts/review-state.ts", handler }],
          },
        }),
      );
    config("onReviewNote");
    const { init, run } = await savedRun({ cwd });

    const result = await init("fix-login");
    if (!result.ok) throw new Error(result.error);
    config("onOther");
    const emitted = await emitRunEvent(
      { id: run.id, cwd, name: "fix-login" },
      { type: "custom.review.note", source: "test", payload: "looks good" },
    );

    expect(result.value.state.eventHandlers).toEqual({
      "custom.review.note": [
        { module: join(cwd, "scripts", "review-state.ts"), handler: "onReviewNote" },
      ],
    });
    expect(emitted.ok).toBe(true);
    const state = StateSchema.parse(
      JSON.parse(readFileSync(join(cwd, ".harness", "fix-login", "state.json"), "utf8")),
    );
    expect(state.custom).toEqual({ note: "looks good" });
  });

  test("a step that fails after the folder is made removes the folder, so a retry can succeed", async () => {
    const { cwd, init, registry, run } = await savedRun({ workflowPath: "/abs/missing.yaml" });

    await expect(init("fix-login")).rejects.toThrow();

    expect(existsSync(join(cwd, ".harness", "fix-login"))).toBe(false);
    expect((await registry.findRun(run.id))?.name).toBeNull();
  });
});

const initializedRun = async () => {
  const context = await savedRun();
  const result = await context.init("fix-login");
  if (!result.ok) throw new Error(result.error);
  return context;
};

describe("resolveRun", () => {
  test("finds an initialized run by its name and folder, and refuses a name no run has", async () => {
    const { cwd, registry, run } = await initializedRun();

    expect(await resolveRun({ registry, root: cwd, name: "fix-login" })).toEqual({
      ok: true,
      value: { id: run.id, cwd, name: "fix-login" },
    });
    const missing = await resolveRun({ registry, root: cwd, name: "other" });
    expect(missing.ok ? "" : missing.error).toContain('no run named "other"');
  });

  test("finds a run started inside a linked worktree when named from the main checkout", async () => {
    const main = makeRepo();
    const worktree = join(main, ".worktrees", "dev");
    gitCmd(main, "worktree", "add", "-q", "-b", "dev", worktree);
    const context = await savedRun({ cwd: realpathSync(worktree) });
    const init = await context.init("fix-login");
    if (!init.ok) throw new Error(init.error);
    const root = await findRoot(worktree);
    if (!root.ok) throw new Error(root.error);

    const result = await resolveRun({
      registry: context.registry,
      root: root.value,
      name: "fix-login",
    });

    expect(result).toEqual({
      ok: true,
      value: { id: context.run.id, cwd: realpathSync(worktree), name: "fix-login" },
    });
  });

  test("SC27: a run whose folder was deleted is refused, and nothing is recreated", async () => {
    const { cwd, registry } = await initializedRun();
    rmSync(join(cwd, ".harness"), { recursive: true });

    const result = await resolveRun({ registry, root: cwd, name: "fix-login" });

    expect(result.ok ? "" : result.error).toContain("no longer exists");
    expect(existsSync(join(cwd, ".harness"))).toBe(false);
  });
});

describe("linkRunSession", () => {
  test("SC22: links a new agent session once and refuses an unknown agent without changing the run", async () => {
    const { cwd, registry, run } = await initializedRun();
    const link = (agent: string, sessionId: string) =>
      linkRunSession({ registry, root: cwd, name: "fix-login", agent, sessionId });

    expect(await link("codex", "s2")).toEqual({
      ok: true,
      value: [{ agent: "codex", sessionId: "s2" }],
    });
    expect(await link("codex", "s2")).toEqual({
      ok: true,
      value: [{ agent: "codex", sessionId: "s2" }],
    });

    const unknown = await link("gpt", "s3");
    expect(unknown.ok ? "" : unknown.error).toContain("agent");
    expect((await registry.findRun(run.id))?.sessions).toEqual([
      { agent: "codex", sessionId: "s2" },
    ]);
  });
});

const tmux = (socket: string, ...args: string[]): string =>
  execFileSync("tmux", ["-L", socket, ...args], { encoding: "utf8" }).trim();

const privateTmux = () => {
  const socket = `harness-init-${crypto.randomUUID()}`;
  tmux(socket, "new-session", "-d", "-s", "old-name", "sleep", "60");
  const path = tmux(socket, "display-message", "-p", "#{socket_path}");
  const pane = tmux(socket, "list-panes", "-a", "-F", "#{pane_id}");
  return { socket, pane: currentPane({ TMUX: `${path},1,0`, TMUX_PANE: pane }) };
};

describe("terminal naming", () => {
  test("SC1: the name is claude-NAME- plus the last 4 characters of the run id", () => {
    expect(terminalName("fix-login", "r-1a2b3c4d")).toBe("claude-fix-login-3c4d");
  });

  test("SC3: init renames the pane's tmux session and records the name", async () => {
    const { socket, pane } = privateTmux();
    try {
      const { registry, run, init } = await savedRun({ id: "r-1a2b3c4d" });

      const result = await init("fix-login", run.id, { pane });

      expect(result.ok).toBe(true);
      expect(tmux(socket, "list-sessions", "-F", "#{session_name}")).toBe("claude-fix-login-3c4d");
      expect((await registry.findRun(run.id))?.terminal).toBe("claude-fix-login-3c4d");
    } finally {
      tmux(socket, "kill-server");
    }
  });

  test("SC4: init outside tmux leaves the terminal alone and succeeds", async () => {
    const { registry, run, init } = await savedRun({ terminal: "old" });

    const result = await init("fix-login", run.id, {});

    expect(result.ok).toBe(true);
    expect((await registry.findRun(run.id))?.terminal).toBe("old");
  });

  test("SC5: a rename that fails does not fail init", async () => {
    const failing: ITerminal = {
      ...({} as ITerminal),
      rename: () => Promise.resolve({ ok: false, error: "no such pane" }),
    };
    const { registry, run, init } = await savedRun({ terminal: "old" });

    const result = await init("fix-login", run.id, {
      pane: { terminal: failing, pane: "%99" },
    });

    expect(result.ok).toBe(true);
    expect((await registry.findRun(run.id))?.terminal).toBe("old");
  });

  test("SC5: a rename that throws does not fail init or delete the run folder", async () => {
    const throwing: ITerminal = {
      ...({} as ITerminal),
      rename: () => Promise.reject(new Error("timed out after 10s")),
    };
    const { registry, run, init } = await savedRun({ terminal: "old" });

    const result = await init("fix-login", run.id, { pane: { terminal: throwing, pane: "%99" } });

    expect(result.ok).toBe(true);
    expect(existsSync(result.ok ? result.value.dir : "")).toBe(true);
    expect((await registry.findRun(run.id))?.terminal).toBe("old");
  });
});
