import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jsonlEventStore, RegistryFileSchema, runDirOf, type WorkflowRun } from "@harness/sdk";

const SCRIPT = join(import.meta.dir, "orchestrate.ts");

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "orchestrate-")));

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

const savedRun = (cwd: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun => {
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(workflowPath, "name: ok\nnodes: []\n");
  return {
    id: "r-1",
    workflow: "ok",
    workflowPath,
    inputs: { prompt: "hi" },
    cwd,
    sessions: [],
    name: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
};

const writeRegistry = (home: string, runs: readonly WorkflowRun[]): void => {
  mkdirSync(home, { recursive: true });
  const file = { version: 1, runs: Object.fromEntries(runs.map((run) => [run.id, run])) };
  writeFileSync(join(home, "registry.json"), JSON.stringify(file));
};

const readRegistry = (home: string) =>
  RegistryFileSchema.parse(JSON.parse(readFileSync(join(home, "registry.json"), "utf8")));

// An initialized run named NAME in cwd, as `orchestrate init` leaves it.
const initializedRun = (home: string, cwd: string, name = "feat-x"): WorkflowRun => {
  const run = savedRun(cwd, { name });
  writeRegistry(home, [run]);
  mkdirSync(runDirOf(cwd, name), { recursive: true });
  return run;
};

const eventsOf = (cwd: string, name = "feat-x") => jsonlEventStore(runDirOf(cwd, name)).read();

type Env = Readonly<Record<string, string | undefined>>;

// A run id or harness home from the shell running the tests must never reach a real registry.
const orchestrate = (cwd: string, home: string, args: readonly string[], env: Env = {}) => {
  const run = spawnSync("bun", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HARNESS_RUN_ID: undefined, HARNESS_HOME: home, ...env },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

describe("orchestrate init", () => {
  test("SC23: init NAME --run-id prints { runId, dir }, writes state.json there, and names the run in the registry", () => {
    const repo = tempRepo();
    const home = tempDir();
    writeRegistry(home, [savedRun(repo)]);

    const init = orchestrate(repo, home, ["init", "fix-login", "--run-id", "r-1"]);

    expect(init.code).toBe(0);
    const dir = join(repo, ".harness", "fix-login");
    expect(JSON.parse(init.stdout)).toEqual({ runId: "r-1", dir });
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    expect(readRegistry(home).runs["r-1"]?.name).toBe("fix-login");
  });

  test("init takes the run id from HARNESS_RUN_ID", () => {
    const repo = tempRepo();
    const home = tempDir();
    writeRegistry(home, [savedRun(repo)]);

    const init = orchestrate(repo, home, ["init", "fix-login"], { HARNESS_RUN_ID: "r-1" });

    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout).runId).toBe("r-1");
  });

  test("SC24: init with no --run-id and no HARNESS_RUN_ID exits 1 with the no-run message", () => {
    const init = orchestrate(tempRepo(), tempDir(), ["init", "fix-login"]);

    expect(init.code).toBe(1);
    expect(init.stderr.trim()).not.toBe("");
  });

  test("SC20: init of a run the registry does not hold exits 1 naming it and writes nothing", () => {
    const repo = tempRepo();

    const init = orchestrate(repo, tempDir(), ["init", "fix-login", "--run-id", "r-missing"]);

    expect(init.code).toBe(1);
    expect(init.stderr).toContain("r-missing");
    expect(existsSync(join(repo, ".harness"))).toBe(false);
  });
});

describe("orchestrate link-session", () => {
  test("SC22: link-session --run NAME records the session once and prints the run's sessions", () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);
    const args = ["link-session", "--run", "feat-x", "--agent", "codex", "--session-id", "s2"];

    const first = orchestrate(repo, home, args);
    const second = orchestrate(repo, home, args);

    expect(first.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual([{ agent: "codex", sessionId: "s2" }]);
    expect(readRegistry(home).runs["r-1"]?.sessions).toEqual([{ agent: "codex", sessionId: "s2" }]);
  });
});

describe("orchestrate emit", () => {
  test("SC22: emit --run NAME stores the event under the run's id and prints it", async () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);

    const emit = orchestrate(repo, home, [
      "emit",
      "custom.review.note",
      "--run",
      "feat-x",
      "--source",
      "review-skill",
      "--payload",
      '{"files":3}',
      "--node-id",
      "review",
      "--node-run-id",
      "review",
      "--stage",
      "review",
      "--id",
      "note-1",
    ]);

    expect(emit.code).toBe(0);
    const printed = JSON.parse(emit.stdout);
    expect(printed).toMatchObject({
      type: "custom.review.note",
      source: "review-skill",
      runId: "r-1",
      payload: { files: 3 },
      nodeId: "review",
      nodeRunId: "review",
      stage: "review",
      id: "note-1",
    });
    expect((await eventsOf(repo)).at(-1)).toEqual(printed);
  });

  test("SC28: emit to a name no run has exits 1 naming it", () => {
    const repo = tempRepo();

    const emit = orchestrate(repo, tempDir(), [
      "emit",
      "custom.x.y",
      "--run",
      "ghost",
      "--source",
      "x",
    ]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain('no run named "ghost"');
  });

  test("SC20: an event the catalog refuses exits 1 naming its type and stores nothing", async () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);
    const args = ["emit", "workflow.node.failed", "--run", "feat-x", "--source", "s"];

    const emit = orchestrate(repo, home, [...args, "--node-id", "a", "--node-run-id", "a"]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain("workflow.node.failed");
    expect(await eventsOf(repo)).toEqual([]);
  });

  test.each([
    ["SC24: a payload that is not JSON", ["--source", "s", "--payload", "{oops"], "--payload"],
    ["SC30: no --source", [], "--source"],
  ])("%s exits 1 naming the flag and stores nothing", async (_label, flags, flag) => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);

    const emit = orchestrate(repo, home, ["emit", "custom.x.y", "--run", "feat-x", ...flags]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain(flag);
    expect(await eventsOf(repo)).toEqual([]);
  });
});

describe("orchestrate workspace", () => {
  test("WS1 — create then remove in a mono repo both exit 0, the worktree comes and goes, and the run records both", async () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);

    const created = orchestrate(root, home, ["workspace", "create", "feat-x", "--run", "feat-x"]);
    expect(created.code).toBe(0);
    expect(existsSync(join(root, ".worktrees/feat-x"))).toBe(true);
    const removed = orchestrate(root, home, ["workspace", "remove", "feat-x", "--run", "feat-x"]);
    expect(removed.code).toBe(0);
    expect(existsSync(join(root, ".worktrees/feat-x"))).toBe(false);

    const events = await eventsOf(root);
    expect(events.map((event) => [event.type, event.runId, event.source])).toEqual([
      ["workspace.created", "r-1", "orchestrate"],
      ["workspace.removed", "r-1", "orchestrate"],
    ]);
  });

  test("WS15 — info prints the layout and packages, and a repo with no config counts as mono", () => {
    const multi = orchestrate(makeMulti(), tempDir(), ["workspace", "info"]);
    expect(multi.code).toBe(0);
    expect(JSON.parse(multi.stdout)).toEqual({
      layout: "multi",
      packages: [
        { name: "api", path: "api", description: "HTTP API" },
        { name: "web", path: "web" },
      ],
    });
    const mono = orchestrate(tempRepo(), tempDir(), ["workspace", "info"]);
    expect(mono.code).toBe(0);
    expect(JSON.parse(mono.stdout)).toEqual({ layout: "mono", packages: [] });
  });

  test("--root points the command at a repo other than the one it runs in", () => {
    const root = makeMulti();

    const info = orchestrate(tempDir(), tempDir(), ["workspace", "info", "--root", root]);

    expect(info.code).toBe(0);
    expect(JSON.parse(info.stdout).layout).toBe("multi");
  });

  test("create prints the report as JSON and sends setup output to stderr", () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);
    writeFileSync(
      join(root, "orchestrate.config.json"),
      JSON.stringify({ version: 2, workspace: { setup: "echo installing" } }),
    );

    const run = orchestrate(root, home, ["workspace", "create", "feat/a", "--run", "feat-x"]);

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

    const run = orchestrate(root, home, [
      "workspace",
      "create",
      "b",
      "--repos",
      "api,web",
      "--run",
      "feat-x",
    ]);

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

    const run = orchestrate(root, home, ["workspace", "create", "b", "--run", "feat-x"]);

    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).repos[0].status).toBe("failed");
  });

  test("a config error exits 1 with the reason and no report", () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);

    const run = orchestrate(root, home, [
      "workspace",
      "create",
      "b",
      "--repos",
      "api",
      "--run",
      "feat-x",
    ]);

    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("mono");
  });

  test("create with a --run no run has exits 1 before any worktree is made", () => {
    const root = tempRepo();
    const home = tempDir();
    initializedRun(home, root);

    const run = orchestrate(root, home, ["workspace", "create", "b", "--run", "ghost"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no run named "ghost"');
    expect(existsSync(join(root, ".worktrees"))).toBe(false);
  });

  test("create with no --run makes the worktree and records no event", () => {
    const root = tempRepo();

    const run = orchestrate(root, tempDir(), ["workspace", "create", "b"]);

    expect(run.code).toBe(0);
    expect(existsSync(join(root, ".worktrees/b"))).toBe(true);
    expect(existsSync(join(root, ".harness"))).toBe(false);
  });

  test("run from inside a multi workspace repo, remove finds the meta repo and its run", async () => {
    const root = makeMulti();
    const home = tempDir();
    initializedRun(home, root);
    orchestrate(root, home, ["workspace", "create", "b", "--repos", "api,web", "--run", "feat-x"]);

    const run = orchestrate(join(root, ".workspaces/b/api"), home, [
      "workspace",
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
    orchestrate(root, home, ["workspace", "create", "b", "--run", "feat-x"]);

    const run = orchestrate(join(root, ".worktrees/b"), home, [
      "workspace",
      "remove",
      "b",
      "--run",
      "feat-x",
    ]);

    expect(run.code).toBe(0);
    expect(existsSync(join(root, ".worktrees/b"))).toBe(false);
  });

  test("add puts a repo into an existing multi workspace and records it", async () => {
    const root = makeMulti();
    const home = tempDir();
    initializedRun(home, root);
    orchestrate(root, home, ["workspace", "create", "b", "--repos", "api", "--run", "feat-x"]);

    const run = orchestrate(root, home, [
      "workspace",
      "add",
      "b",
      "--repos",
      "web",
      "--run",
      "feat-x",
    ]);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout).repos).toMatchObject([{ name: "web", status: "ready" }]);
    expect(existsSync(join(root, ".workspaces/b/web"))).toBe(true);
    expect((await eventsOf(root)).at(-1)?.type).toBe("workspace.repository.added");
  });

  test("add to a workspace that does not exist exits 1", () => {
    const root = makeMulti();
    const home = tempDir();
    initializedRun(home, root);

    const run = orchestrate(root, home, [
      "workspace",
      "add",
      "b",
      "--repos",
      "web",
      "--run",
      "feat-x",
    ]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("no workspace");
  });
});

const BASELINE_NODE = ["--node-id", "baseline", "--node-run-id", "baseline"];
const BASELINE_ARGS = ["baseline", "--run", "feat-x", ...BASELINE_NODE];

const baselineRun = (baseline: string | undefined): { repo: string; home: string } => {
  const repo = tempRepo();
  const home = tempDir();
  writeRegistry(home, [savedRun(repo)]);
  writeFileSync(join(repo, "orchestrate.config.json"), JSON.stringify({ version: 2, baseline }));
  expect(orchestrate(repo, home, ["init", "feat-x", "--run-id", "r-1"]).code).toBe(0);
  const started = ["emit", "workflow.node.started", "--run", "feat-x", "--source", "engine"];
  const payload = ["--payload", '{"nodeType":"exec"}'];
  expect(orchestrate(repo, home, [...started, ...payload, ...BASELINE_NODE]).code).toBe(0);
  return { repo, home };
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
};

describe("orchestrate baseline", () => {
  test("BL12: baseline runs the configured script, writes artifacts/baseline.json and lists it on the node run", () => {
    const { repo, home } = baselineRun(`echo '{"tests":3}'`);

    const run = orchestrate(repo, home, BASELINE_ARGS);

    expect(run.code).toBe(0);
    const path = join(runDirOf(repo, "feat-x"), "artifacts", "baseline.json");
    const baseline = {
      workspace: { command: `echo '{"tests":3}'`, exitCode: 0, output: { tests: 3 } },
      packages: {},
    };
    expect(JSON.parse(run.stdout)).toEqual({ path, workspace: 0, packages: {} });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(baseline);
    const state = JSON.parse(readFileSync(join(runDirOf(repo, "feat-x"), "state.json"), "utf8"));
    expect(state.nodeRuns.baseline.artifacts).toEqual([
      { name: "baseline", path: "artifacts/baseline.json" },
    ]);
  });

  test("BL12: with no baseline script configured, it prints a null path and no exit codes", () => {
    const { repo, home } = baselineRun(undefined);

    const run = orchestrate(repo, home, BASELINE_ARGS);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ path: null, workspace: null, packages: {} });
  });

  test("BL15: SIGTERM kills the running baseline script, exits 143 and writes nothing", async () => {
    const { repo, home } = baselineRun("echo $$ > pid; sleep 30");
    const pidFile = join(repo, "pid");
    const child = Bun.spawn(["bun", SCRIPT, ...BASELINE_ARGS], {
      cwd: repo,
      env: { ...process.env, HARNESS_RUN_ID: undefined, HARNESS_HOME: home },
      stdout: "ignore",
      stderr: "ignore",
    });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(readFileSync(pidFile, "utf8").trim());

    child.kill("SIGTERM");

    expect(await child.exited).toBe(143);
    await waitFor(() => !isAlive(pid), 2000);
    expect(existsSync(join(runDirOf(repo, "feat-x"), "artifacts", "baseline.json"))).toBe(false);
  });
});

const DEMO_SKILL = `---
name: demo
description: A demo skill.
mode: inline
allowed-tools: [Bash]
tier: fast
inputs:
  description: Anything.
  schema: demo.input.v1
outputs:
  description: Anything.
  schema: demo.output.v1
protocols: []
scopes: []
references:
  notes:
    path: notes.md
    description: Notes.
---
`;

const configuredRepo = (config: object): string => {
  const root = tempRepo();
  writeFileSync(join(root, "orchestrate.config.json"), JSON.stringify({ version: 2, ...config }));
  return root;
};

describe("orchestrate skill", () => {
  test("WS32 — skill ref with an extend prints the base text, a blank line, then the extension", () => {
    const skillsDir = tempDir();
    mkdirSync(join(skillsDir, "demo"));
    writeFileSync(join(skillsDir, "demo/SKILL.md"), DEMO_SKILL);
    writeFileSync(join(skillsDir, "demo/notes.md"), "base text\n");
    const root = configuredRepo({
      extensions: { demo: { references: { notes: { extend: "notes-extra.md" } } } },
    });
    writeFileSync(join(root, "notes-extra.md"), "extension text\n");

    const run = orchestrate(root, tempDir(), ["skill", "ref", "demo", "notes"], {
      HARNESS_SKILLS_DIR: skillsDir,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("base text\n\nextension text\n");
  });

  test("skill ref with no HARNESS_SKILLS_DIR reads the harness repo's own skills folder", () => {
    const shipped = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "skills",
      "create-workspace",
      "references",
      "select-repos.md",
    );

    const run = orchestrate(
      configuredRepo({}),
      tempDir(),
      ["skill", "ref", "create-workspace", "select-repos"],
      {
        HARNESS_SKILLS_DIR: undefined,
      },
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(readFileSync(shipped, "utf8"));
  });

  test("WS33 — skill ref for a skill that does not exist exits 1 naming the skill", () => {
    const run = orchestrate(configuredRepo({}), tempDir(), ["skill", "ref", "missing", "notes"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("missing");
  });

  test("skill extension prints the project's extension doc for the skill", () => {
    const root = configuredRepo({ extensions: { demo: { skill: "demo-extra.md" } } });
    writeFileSync(join(root, "demo-extra.md"), "use pnpm\n");

    const run = orchestrate(root, tempDir(), ["skill", "extension", "demo"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("use pnpm\n");
  });
});
