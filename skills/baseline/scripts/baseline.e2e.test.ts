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
import { runDirOf, type WorkflowRun } from "@harness/sdk";
import { createState } from "@harness/sdk/internal";

const SCRIPT = join(import.meta.dir, "baseline.ts");

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "baseline-e2e-")));

// A repo holding orchestrate.config.json with `baseline`, and a run named feat-x registered in
// HARNESS_HOME, as `orchestrate init` leaves it.
const baselineRun = (baseline: string | undefined): Readonly<{ repo: string; home: string }> => {
  const repo = tempDir();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  writeFileSync(join(repo, "orchestrate.config.json"), JSON.stringify({ version: 2, baseline }));
  const workflowPath = join(repo, "ok.yaml");
  writeFileSync(workflowPath, "name: ok\nnodes: []\n");
  const run: WorkflowRun = {
    id: "r-1",
    workflow: "ok",
    workflowPath,
    inputs: { prompt: "hi" },
    cwd: repo,
    sessions: [],
    name: "feat-x",
    terminal: null,
    config: null,
    tier: null,
    createdAt: new Date().toISOString(),
  };
  const home = tempDir();
  writeFileSync(join(home, "registry.json"), JSON.stringify({ version: 1, runs: { "r-1": run } }));
  mkdirSync(runDirOf(repo, "feat-x"), { recursive: true });
  return { repo, home };
};

// A run id or harness home from the shell running the tests must never reach a real registry.
const env = (home: string) => ({ ...process.env, HARNESS_RUN_ID: undefined, HARNESS_HOME: home });

const baseline = (
  cwd: string,
  home: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
) => {
  const run = spawnSync("bun", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...env(home), ...extra },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
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

describe("baseline.ts", () => {
  test("runs the configured script and writes artifacts/baseline.json", () => {
    const { repo, home } = baselineRun(`echo '{"tests":3}'`);

    const run = baseline(repo, home, ["--run", "feat-x", "--dir", repo]);

    expect(run.code).toBe(0);
    const path = join(runDirOf(repo, "feat-x"), "artifacts", "baseline.json");
    expect(JSON.parse(run.stdout)).toEqual({ path, workspace: 0, packages: {} });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      workspace: { command: `echo '{"tests":3}'`, exitCode: 0, output: { tests: 3 } },
      packages: {},
    });
  });

  test("with no baseline script configured, it prints a null path and no exit codes", () => {
    const { repo, home } = baselineRun(undefined);

    const run = baseline(repo, home, ["--run", "feat-x", "--dir", repo]);

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ path: null, workspace: null, packages: {} });
  });

  test("a run whose state.json records a config file runs that file's baseline, not the repo's", async () => {
    const { repo, home } = baselineRun("echo from-repo-config");
    const elsewhere = tempDir();
    const file = join(elsewhere, "custom.json");
    writeFileSync(file, JSON.stringify({ version: 2, baseline: "echo from-run-config" }));
    const runDir = runDirOf(repo, "feat-x");
    writeFileSync(join(runDir, "workflow.yaml"), "name: ok\nnodes: []\n");
    await createState({
      runId: "r-1",
      runDir,
      version: "1.0.0",
      eventHandlers: {},
      config: { path: file, root: elsewhere },
    });

    const run = baseline(repo, home, ["--run", "feat-x", "--dir", repo]);

    expect(run.code).toBe(0);
    const recorded = JSON.parse(readFileSync(join(runDir, "artifacts", "baseline.json"), "utf8"));
    expect(recorded.workspace.command).toBe("echo from-run-config");
  });

  test("$HARNESS_RUN_ID picks the run with no flag, and --run-id picks it from outside the repo", () => {
    const { repo, home } = baselineRun("echo ok");
    const path = join(runDirOf(repo, "feat-x"), "artifacts", "baseline.json");

    const fromSession = baseline(repo, home, ["--dir", repo], { HARNESS_RUN_ID: "r-1" });
    const byId = baseline(tempDir(), home, ["--run-id", "r-1", "--dir", repo]);

    expect(fromSession.code).toBe(0);
    expect(JSON.parse(fromSession.stdout).path).toBe(path);
    expect(byId.code).toBe(0);
    expect(JSON.parse(byId.stdout).path).toBe(path);
  });

  test.each([
    ["no --run", ["--dir", "."], "no run: pass --run or --run-id"],
    ["a run the registry does not have", ["--run", "ghost", "--dir", "."], "ghost"],
    ["an unknown flag", ["--run", "feat-x", "--nope"], "--nope"],
    ["--root", ["--run", "feat-x", "--root", "."], "--root"],
  ])("exits 1 on %s, naming it", (_case, args, named) => {
    const { repo, home } = baselineRun(undefined);

    const run = baseline(repo, home, args);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain(named);
  });

  test("SIGTERM kills the running baseline script, exits 143 and writes nothing", async () => {
    const { repo, home } = baselineRun("echo $$ > pid; sleep 30");
    const pidFile = join(repo, "pid");
    const child = Bun.spawn(["bun", SCRIPT, "--run", "feat-x", "--dir", repo], {
      cwd: repo,
      env: env(home),
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
