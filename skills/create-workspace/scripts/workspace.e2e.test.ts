import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDirOf, type WorkflowRun } from "@harness/sdk";
import { createState, jsonlEventStore } from "@harness/sdk/internal";

const SCRIPT = join(import.meta.dir, "workspace.ts");

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "workspace-")));

const makeRepo = (dir: string, ignored: string): string => {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ignored);
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const tempRepo = (): string => makeRepo(tempDir(), ".worktrees/\n.harness/\n");

const makeMulti = (): string => {
  const root = makeRepo(tempDir(), ".workspaces/\n.harness/\napi/\nweb/\n");
  makeRepo(join(root, "api"), "");
  makeRepo(join(root, "web"), "");
  writeFileSync(
    join(root, "orchestrate.config.json"),
    JSON.stringify({
      version: 2,
      workspace: { layout: "multi" },
      packages: { api: { path: "api", description: "HTTP API" }, web: { path: "web" } },
    }),
  );
  return root;
};

// An initialized run named feat-x in cwd, as `orchestrate init` leaves it.
const initializedRun = (home: string, cwd: string): void => {
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(workflowPath, "name: ok\nnodes: []\n");
  const run: WorkflowRun = {
    id: "r-1",
    workflow: "ok",
    workflowPath,
    inputs: { prompt: "hi" },
    cwd,
    sessions: [],
    name: "feat-x",
    terminal: null,
    config: null,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "registry.json"), JSON.stringify({ version: 1, runs: { "r-1": run } }));
  mkdirSync(runDirOf(cwd, "feat-x"), { recursive: true });
};

const eventsOf = (cwd: string) => jsonlEventStore(runDirOf(cwd, "feat-x")).read();

// A run id or harness home from the shell running the tests must never reach a real registry.
const workspace = (
  cwd: string,
  home: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
) => {
  const run = spawnSync("bun", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HARNESS_RUN_ID: undefined, HARNESS_HOME: home, ...env },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

describe("workspace.ts", () => {
  test("WS1 — create then remove in a mono repo both exit 0, the worktree comes and goes, and the run records both", async () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);

    const created = workspace(root, home, ["create", "feat-x", "--run", "feat-x"]);
    expect(created.code).toBe(0);
    expect(existsSync(join(root, ".worktrees/feat-x"))).toBe(true);
    const removed = workspace(root, home, ["remove", "feat-x", "--run", "feat-x"]);
    expect(removed.code).toBe(0);
    expect(existsSync(join(root, ".worktrees/feat-x"))).toBe(false);

    const events = await eventsOf(root);
    expect(events.map((event) => [event.type, event.runId, event.source])).toEqual([
      ["workspace.created", "r-1", "orchestrate"],
      ["workspace.removed", "r-1", "orchestrate"],
    ]);
  });

  test("WS15 — info prints the layout and packages, and a repo with no config counts as mono", () => {
    const multi = workspace(makeMulti(), tempDir(), ["info"]);
    expect(multi.code).toBe(0);
    expect(JSON.parse(multi.stdout)).toEqual({
      layout: "multi",
      packages: [
        { name: "api", path: "api", description: "HTTP API" },
        { name: "web", path: "web" },
      ],
    });
    const mono = workspace(tempRepo(), tempDir(), ["info"]);
    expect(mono.code).toBe(0);
    expect(JSON.parse(mono.stdout)).toEqual({ layout: "mono", packages: [] });
  });

  test("info with no run reads the config of the linked worktree it runs in, not main's", () => {
    const root = tempRepo();
    const worktree = join(root, ".worktrees/dev");
    execFileSync("git", ["worktree", "add", "-q", "-b", "dev", worktree], { cwd: root });
    writeFileSync(
      join(worktree, "orchestrate.config.json"),
      JSON.stringify({ version: 2, packages: { app: { path: ".", description: "the app" } } }),
    );

    const fromWorktree = workspace(worktree, tempDir(), ["info"]);
    const fromMain = workspace(root, tempDir(), ["info"]);

    expect(JSON.parse(fromWorktree.stdout).packages).toEqual([
      { name: "app", path: ".", description: "the app" },
    ]);
    expect(JSON.parse(fromMain.stdout).packages).toEqual([]);
  });

  test("--root is refused", () => {
    const root = tempRepo();

    const info = workspace(root, tempDir(), ["info", "--root", root]);

    expect(info.code).toBe(1);
    expect(info.stderr).toContain("--root");
  });

  test("inside a harness session, create records into the run $HARNESS_RUN_ID names", async () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);

    const created = workspace(root, home, ["create", "b"], { HARNESS_RUN_ID: "r-1" });

    expect(created.code).toBe(0);
    expect((await eventsOf(root)).map((event) => event.type)).toEqual(["workspace.created"]);
  });

  test("--run-id picks the run from outside the repo, and worktrees still go under its main checkout", async () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);

    const created = workspace(tempDir(), home, ["create", "b", "--run-id", "r-1"]);

    expect(created.code).toBe(0);
    expect(existsSync(join(root, ".worktrees/b"))).toBe(true);
    expect((await eventsOf(root)).map((event) => event.type)).toEqual(["workspace.created"]);
  });

  test("a run whose state.json records a config file runs that file's setup, not the repo's", async () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);
    writeFileSync(
      join(root, "orchestrate.config.json"),
      JSON.stringify({ version: 2, workspace: { setup: "echo from-repo-config" } }),
    );
    const elsewhere = tempDir();
    const file = join(elsewhere, "custom.json");
    writeFileSync(
      file,
      JSON.stringify({ version: 2, workspace: { setup: "echo from-run-config" } }),
    );
    const runDir = runDirOf(root, "feat-x");
    writeFileSync(join(runDir, "workflow.yaml"), "name: ok\nnodes: []\n");
    await createState({
      runId: "r-1",
      runDir,
      version: "1.0.0",
      eventHandlers: {},
      config: { path: file, root: elsewhere },
    });

    const created = workspace(root, home, ["create", "b", "--run", "feat-x"]);

    expect(created.code).toBe(0);
    expect(created.stderr).toContain("from-run-config");
    expect(created.stderr).not.toContain("from-repo-config");
  });

  test("create prints the report as JSON and sends setup output to stderr", () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);
    writeFileSync(
      join(root, "orchestrate.config.json"),
      JSON.stringify({ version: 2, workspace: { setup: "echo installing" } }),
    );

    const run = workspace(root, home, ["create", "feat/a", "--run", "feat-x"]);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      layout: "mono",
      branch: "feat/a",
      repos: [{ worktreeDir: join(root, ".worktrees/feat-a"), status: "ready" }],
    });
    expect(run.stderr).toContain("installing");
  });

  test("create in a multi repo takes a comma-separated --repos", () => {
    const root = makeMulti();
    const home = tempDir();
    initializedRun(home, root);

    const run = workspace(root, home, ["create", "b", "--repos", "api,web", "--run", "feat-x"]);

    expect(run.code).toBe(0);
    expect(existsSync(join(root, ".workspaces/b/api"))).toBe(true);
    expect(existsSync(join(root, ".workspaces/b/web"))).toBe(true);
  });

  test("a failed setup exits 1 and still prints the report", () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);
    writeFileSync(
      join(root, "orchestrate.config.json"),
      JSON.stringify({ version: 2, workspace: { setup: "exit 2" } }),
    );

    const run = workspace(root, home, ["create", "b", "--run", "feat-x"]);

    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).repos[0].status).toBe("failed");
  });

  test("a config error exits 1 with the reason and no report", () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);

    const run = workspace(root, home, ["create", "b", "--repos", "api", "--run", "feat-x"]);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("mono");
  });

  test("create with a --run no run has exits 1 before any worktree is made", () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);

    const run = workspace(root, home, ["create", "b", "--run", "ghost"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no run named "ghost"');
    expect(existsSync(join(root, ".worktrees"))).toBe(false);
  });

  test("create with no --run makes the worktree and records no event", () => {
    const root = tempRepo();

    const run = workspace(root, tempDir(), ["create", "b"]);

    expect(run.code).toBe(0);
    expect(existsSync(join(root, ".worktrees/b"))).toBe(true);
    expect(existsSync(join(root, ".harness"))).toBe(false);
  });

  test("run from inside a multi workspace repo, remove finds the meta repo and its run", async () => {
    const root = makeMulti();
    const home = tempDir();
    initializedRun(home, root);
    workspace(root, home, ["create", "b", "--repos", "api,web", "--run", "feat-x"]);

    const run = workspace(join(root, ".workspaces/b/api"), home, [
      "remove",
      "b",
      "--run",
      "feat-x",
    ]);

    expect(run.code).toBe(0);
    expect(existsSync(join(root, ".workspaces/b"))).toBe(false);
    expect((await eventsOf(root)).map((event) => event.type)).toEqual([
      "workspace.created",
      "workspace.removed",
    ]);
  });

  test("run from inside a worktree, remove still finds the main checkout", () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);
    workspace(root, home, ["create", "b", "--run", "feat-x"]);

    const run = workspace(join(root, ".worktrees/b"), home, ["remove", "b", "--run", "feat-x"]);

    expect(run.code).toBe(0);
    expect(existsSync(join(root, ".worktrees/b"))).toBe(false);
  });

  test("add puts a repo into an existing multi workspace and records it", async () => {
    const root = makeMulti();
    const home = tempDir();
    initializedRun(home, root);
    workspace(root, home, ["create", "b", "--repos", "api", "--run", "feat-x"]);

    const run = workspace(root, home, ["add", "b", "--repos", "web", "--run", "feat-x"]);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).repos).toMatchObject([{ name: "web", status: "ready" }]);
    expect(existsSync(join(root, ".workspaces/b/web"))).toBe(true);
    expect((await eventsOf(root)).at(-1)?.type).toBe("workspace.repository.added");
  });

  test("add to a workspace that does not exist exits 1", () => {
    const root = makeMulti();
    const home = tempDir();
    initializedRun(home, root);

    const run = workspace(root, home, ["add", "b", "--repos", "web", "--run", "feat-x"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("no workspace");
  });

  test.each([
    ["add with no --repos", ["add", "b"], "--repos"],
    ["a flag the subcommand does not take", ["create", "b", "--force"], "--force"],
    ["an unknown subcommand", ["make", "b"], "make"],
    ["a missing branch", ["create"], "branch"],
  ])("%s exits 1 naming it and changes nothing", (_label, args, named) => {
    const root = makeMulti();

    const run = workspace(root, tempDir(), args);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(named);
    expect(existsSync(join(root, ".workspaces"))).toBe(false);
  });
});
