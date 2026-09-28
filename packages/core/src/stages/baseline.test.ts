import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState, emitRunEvent, jsonlEventStore, type RunRef, runDirOf } from "@harness/sdk";
import { captureLogger } from "../logging.ts";
import { type Baseline, captureBaseline } from "./baseline.ts";

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "baseline-")));

const NODE = { nodeId: "baseline", nodeRunId: "baseline" };

type Setup = Readonly<{ root: string; run: RunRef; runDir: string }>;

const setup = async (config: object, { state = true } = {}): Promise<Setup> => {
  const root = tempDir();
  writeFileSync(join(root, "orchestrate.config.json"), JSON.stringify({ version: 2, ...config }));
  const run = { id: "r-1", cwd: root, name: "feat-x" };
  const runDir = runDirOf(root, run.name);
  mkdirSync(runDir, { recursive: true });
  if (!state) return { root, run, runDir };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  writeFileSync(join(runDir, "workflow.yaml"), "name: task\nnodes: []\n");
  await createState({ runDir, harnessVersion: "1.0.0", eventHandlers: {} });
  await emitRunEvent(run, {
    type: "workflow.node.started",
    source: "test",
    ...NODE,
    payload: { nodeType: "exec" },
  });
  return { root, run, runDir };
};

const capture = (
  { root, run }: Setup,
  options: { packages?: readonly string[]; dir?: string; nodeRunId?: string } = {},
  log = captureLogger().log,
) =>
  captureBaseline({
    root,
    run,
    ...NODE,
    nodeRunId: options.nodeRunId ?? NODE.nodeRunId,
    packages: options.packages ?? [],
    dir: options.dir,
    log,
  });

const baselineOf = (runDir: string): Baseline =>
  JSON.parse(readFileSync(join(runDir, "artifacts", "baseline.json"), "utf8"));

const stateOf = (runDir: string) => JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));

const artifactEvents = async (runDir: string) =>
  (await jsonlEventStore(runDir).read()).filter((event) => event.type === "artifact.created");

const pkg = (baseline: string | object | null | undefined, path = ".") => ({
  path,
  commands: baseline === undefined ? {} : { baseline },
});

describe("captureBaseline", () => {
  test("BL1: the workspace and package scripts combine into one file, recorded on the node run", async () => {
    const run = await setup({
      baseline: `echo '{"a":1}'`,
      packages: { core: pkg(`echo '{"b":2}'`) },
    });

    const result = await capture(run);

    const expected = {
      workspace: { command: `echo '{"a":1}'`, exitCode: 0, output: { a: 1 } },
      packages: { core: { command: `echo '{"b":2}'`, exitCode: 0, output: { b: 2 } } },
    };
    expect(result).toEqual({
      ok: true,
      value: { path: join(run.runDir, "artifacts", "baseline.json"), baseline: expected },
    });
    expect(baselineOf(run.runDir)).toEqual(expected);
    expect(stateOf(run.runDir).nodeRuns.baseline.artifacts).toEqual([
      { name: "baseline", path: "artifacts/baseline.json" },
    ]);
  });

  test("BL2: text output is stored trimmed", async () => {
    const run = await setup({ baseline: "echo '3 failing'; echo oops >&2" });

    const result = await capture(run);

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.workspace?.output).toBe("3 failing");
  });

  test("CMD3: a baseline object runs in its cwd, relative to the workspace folder", async () => {
    const run = await setup({
      baseline: { command: "pwd", cwd: "tools" },
      packages: { core: pkg({ command: "pwd", cwd: "packages/core" }) },
    });
    mkdirSync(join(run.root, "tools"));
    mkdirSync(join(run.root, "packages", "core"), { recursive: true });

    const result = await capture(run);

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.workspace?.output).toBe(join(run.root, "tools"));
    expect(result.value.baseline.packages.core?.output).toBe(join(run.root, "packages", "core"));
  });

  test("CMD4: a baseline object's timeoutSeconds replaces the default timeout", async () => {
    const run = await setup({ baseline: { command: "echo partial; sleep 5", timeoutSeconds: 1 } });

    const result = await capture(run);

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.workspace).toMatchObject({ exitCode: 124, output: "partial" });
  });

  test("CMD5: a baseline cwd that is not a folder stops with CONFIG_STALE and writes nothing", async () => {
    const run = await setup({ packages: { core: pkg({ command: "pwd", cwd: "nope" }) } });

    const result = await capture(run);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_STALE");
    expect(result.error.message).toContain(join(run.root, "nope"));
    expect(existsSync(join(run.runDir, "artifacts", "baseline.json"))).toBe(false);
  });

  test("BL3: packages with no baseline key or a null one are not run and not listed", async () => {
    const run = await setup({
      packages: {
        core: pkg("echo core"),
        missing: pkg(undefined),
        off: { path: ".", commands: { baseline: null, test: "touch marker" } },
      },
    });

    const result = await capture(run);

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(Object.keys(result.value.baseline.packages)).toEqual(["core"]);
    expect(result.value.baseline.workspace).toBeNull();
    expect(existsSync(join(run.root, "marker"))).toBe(false);
  });

  test("BL4: a script that exits 1 is recorded as a result", async () => {
    const run = await setup({ baseline: "echo '{}'; exit 1" });

    const result = await capture(run);

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.workspace).toEqual({
      command: "echo '{}'; exit 1",
      exitCode: 1,
      output: {},
    });
  });

  test("BL5: a command that cannot start stops with CONFIG_STALE and writes and records nothing", async () => {
    const run = await setup({ packages: { core: pkg("definitely-not-a-command") } });

    const result = await capture(run);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_STALE");
    expect(result.error.message).toContain("definitely-not-a-command");
    expect(result.error.message).toContain("core");
    expect(existsSync(join(run.runDir, "artifacts", "baseline.json"))).toBe(false);
    expect(await artifactEvents(run.runDir)).toEqual([]);
  });

  test.each([
    ["bun's missing script", `echo 'error: Script not found "baseline"' >&2; exit 1`],
    ["bun's empty filter", `echo "error: No packages matched the filter" >&2; exit 1`],
    ["npm's missing script", `echo "error: Missing script: baseline" >&2; exit 1`],
    ["an unknown command", "definitely-not-a-command"],
  ])("BL5: %s stops with CONFIG_STALE and writes nothing", async (_, command) => {
    const run = await setup({ packages: { core: pkg(command) } });

    const result = await capture(run);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_STALE");
    expect(existsSync(join(run.runDir, "artifacts", "baseline.json"))).toBe(false);
  });

  test("BL5: a red suite whose stderr mentions a missing command is recorded as a result", async () => {
    const command = `echo "1 failing"; echo "sh: foo: command not found" >&2; exit 1`;
    const run = await setup({ packages: { core: pkg(command) } });

    const result = await capture(run);

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.packages.core).toEqual({
      command,
      exitCode: 1,
      output: "1 failing",
    });
  });

  test("BL6: a package script past its timeout is killed and recorded as 124 with its output so far", async () => {
    const run = await setup({
      packages: { core: { ...pkg("echo partial; sleep 5"), timeoutSeconds: 1 } },
    });
    const started = Date.now();

    const result = await capture(run);

    expect(Date.now() - started).toBeLessThan(5000);
    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.packages.core).toMatchObject({ exitCode: 124, output: "partial" });
  });

  test("BL7: named packages run with the workspace script; an unknown name stops with PACKAGE_UNKNOWN", async () => {
    const run = await setup({
      baseline: "echo ws",
      packages: { core: pkg("echo core"), cli: pkg("touch cli-ran") },
    });

    const result = await capture(run, { packages: ["core"] });

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(result.value.baseline.workspace?.output).toBe("ws");
    expect(Object.keys(result.value.baseline.packages)).toEqual(["core"]);
    expect(existsSync(join(run.root, "cli-ran"))).toBe(false);

    const unknown = await capture(run, { packages: ["nope"] });
    if (unknown.ok) throw new Error("expected a failure");
    expect(unknown.error.code).toBe("PACKAGE_UNKNOWN");
    expect(unknown.error.message).toContain("nope");
  });

  test("BL8: with no baseline script anywhere, nothing runs, is written or recorded", async () => {
    const run = await setup({ packages: { core: pkg(undefined) } });

    const result = await capture(run);

    expect(result).toEqual({ ok: true, value: null });
    expect(existsSync(join(run.runDir, "artifacts", "baseline.json"))).toBe(false);
    expect(await artifactEvents(run.runDir)).toEqual([]);
  });

  test("BL9: --dir wins over state.json's workspace.path", async () => {
    const run = await setup({
      baseline: "pwd > where",
      packages: { core: pkg("pwd > where-core") },
    });
    const dir = tempDir();

    const result = await capture(run, { dir });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(dir, "where"), "utf8").trim()).toBe(dir);
    expect(readFileSync(join(dir, "where-core"), "utf8").trim()).toBe(dir);
    expect(existsSync(join(run.root, "where"))).toBe(false);
  });

  test("BL9: with no --dir, scripts run in state.json's workspace.path", async () => {
    const run = await setup({ baseline: "pwd > where" });

    await capture(run);

    expect(readFileSync(join(run.root, "where"), "utf8").trim()).toBe(run.root);
  });

  test("BL9: with no --dir and no state.json, it stops with STATE_MISSING", async () => {
    const run = await setup({ baseline: "echo hi" }, { state: false });

    const result = await capture(run);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("STATE_MISSING");
    expect(result.error.message).toContain("--dir");
  });

  test("BL9: a --dir that does not exist stops with WORKTREE_MISSING naming it", async () => {
    const run = await setup({ baseline: "echo hi" });
    const dir = join(tempDir(), "gone");

    const result = await capture(run, { dir });

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKTREE_MISSING", message: `no run folder at ${dir}` },
    });
  });

  test("BL9: a --dir that is a file, not a folder, stops with WORKTREE_MISSING naming it", async () => {
    const run = await setup({ baseline: "echo hi" });
    const dir = join(tempDir(), "a-file");
    writeFileSync(dir, "");

    const result = await capture(run, { dir });

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKTREE_MISSING", message: `no run folder at ${dir}` },
    });
  });

  test("BL9: a state.json workspace.path that no longer exists stops with WORKTREE_MISSING naming it", async () => {
    const run = await setup({ packages: { core: pkg("echo core") } });
    const gone = join(tempDir(), "removed-worktree");
    const state = stateOf(run.runDir);
    writeFileSync(
      join(run.runDir, "state.json"),
      JSON.stringify({ ...state, workspace: { ...state.workspace, path: gone } }),
    );

    const result = await capture(run);

    expect(result).toEqual({
      ok: false,
      error: { code: "WORKTREE_MISSING", message: `no run folder at ${gone}` },
    });
    expect(existsSync(join(run.runDir, "artifacts", "baseline.json"))).toBe(false);
  });

  test("BL14: a node run not in state.json stops with NODE_RUN_UNKNOWN before anything runs", async () => {
    const run = await setup({ baseline: "touch ran" });

    const result = await capture(run, { nodeRunId: "nope" });

    expect(result).toEqual({
      ok: false,
      error: { code: "NODE_RUN_UNKNOWN", message: "no node run nope in run feat-x" },
    });
    expect(existsSync(join(run.root, "ran"))).toBe(false);
  });

  test("BL16: when the event cannot be recorded, it stops with EVENT_FAILED and keeps baseline.json", async () => {
    const run = await setup({ baseline: "echo hi" });
    chmodSync(join(run.runDir, "event.jsonl"), 0o444);

    const result = await capture(run);

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("EVENT_FAILED");
    expect(baselineOf(run.runDir).workspace?.output).toBe("hi");
  });

  test("BL14: with --dir and no state.json, the node run is not checked", async () => {
    const run = await setup({ baseline: "echo hi" }, { state: false });

    const result = await capture(run, { dir: tempDir(), nodeRunId: "nope" });

    expect(result.ok).toBe(true);
  });

  test("BL9: in multi layout a package script runs in its own folder under the workspace", async () => {
    const run = await setup({
      workspace: { layout: "multi" },
      packages: { api: pkg("pwd > where", "api") },
    });
    const dir = tempDir();
    mkdirSync(join(dir, "api"));

    await capture(run, { dir });

    expect(readFileSync(join(dir, "api", "where"), "utf8").trim()).toBe(join(dir, "api"));
  });

  const multiWithoutWeb = async () => {
    const run = await setup({
      workspace: { layout: "multi" },
      baseline: "touch ws-ran",
      packages: { api: pkg("echo api", "api"), web: pkg("echo web", "web") },
    });
    const dir = tempDir();
    mkdirSync(join(dir, "api"));
    return { run, dir };
  };

  test("BL13: in multi layout a default run skips a package with no worktree", async () => {
    const { run, dir } = await multiWithoutWeb();

    const result = await capture(run, { dir });

    if (!result.ok || result.value === null) throw new Error("expected a baseline");
    expect(Object.keys(result.value.baseline.packages)).toEqual(["api"]);
  });

  test("BL13: in multi layout a named package with no worktree stops with WORKTREE_MISSING before anything runs", async () => {
    const { run, dir } = await multiWithoutWeb();

    const result = await capture(run, { dir, packages: ["web"] });

    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toEqual({
      code: "WORKTREE_MISSING",
      message: `web: no worktree at ${join(dir, "web")}`,
    });
    expect(existsSync(join(dir, "ws-ran"))).toBe(false);
  });
});
