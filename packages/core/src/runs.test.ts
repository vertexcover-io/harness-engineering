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
import { createGit, noopLogger } from "@harness/sdk";
import { jsonlEventStore } from "./event-store.ts";
import { createRegistry, type WorkflowRun } from "./registry.ts";
import { initializeRun, linkRunSession, resolveRun } from "./runs.ts";
import { findRoot } from "./workspace.ts";

const makeRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "r-1",
  workflow: "demo",
  workflowPath: "/abs/workflow.yaml",
  inputs: {},
  cwd: "/repos/demo",
  sessions: [],
  name: null,
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
  const init = (name: string, runId = run.id) =>
    initializeRun({ registry, runId, name, git: createGit(), log: noopLogger });
  return { cwd, workflowPath, registry, run, init };
};

describe("initializeRun", () => {
  test("SC19: writes workflow.yaml, one workflow.started event, a state.json with lastEventSeq 1, and names the run in the registry", async () => {
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
      specName: "fix-login",
      input: run.inputs,
      startedAt: events[0]?.ts,
    });
    expect((await registry.findRun(run.id))?.name).toBe("fix-login");
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
