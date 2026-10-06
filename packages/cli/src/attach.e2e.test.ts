import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registryPath, type WorkflowRun } from "@harness/sdk";
import { createRegistry } from "@harness/sdk/internal";

const CLI = join(import.meta.dir, "index.ts");

const makeRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-attach-repo-")));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
};

const runFolder = (cwd: string, name: string): void => {
  mkdirSync(join(cwd, ".harness", name), { recursive: true });
};

const run = (id: string, name: string, cwd: string, terminal: string | null): WorkflowRun => ({
  id,
  workflow: "ok",
  workflowPath: join(cwd, "ok.yaml"),
  inputs: {},
  cwd,
  sessions: [],
  name,
  terminal,
  config: null,
  tiers: null,
  createdAt: new Date().toISOString(),
});

const attach = (cwd: string, home: string, ...args: string[]) => {
  const result = spawnSync("bun", [CLI, "attach", "--print", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HARNESS_HOME: home, HARNESS_TMUX_SOCKET: "attach-test" },
  });
  return { code: result.status ?? 1, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
};

describe("harness attach", () => {
  test("SC7: finds a run by name, and refuses unknown names and runs without a terminal", async () => {
    const cwd = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "harness-attach-home-"));
    writeFileSync(join(home, ".keep"), "");
    const registry = createRegistry(registryPath(home));
    await registry.addRun(run("r-1a2b3c4d", "fix-login", cwd, "claude-fix-login-3c4d"));
    await registry.addRun(run("r-5e6f7a8b", "pending", cwd, null));
    runFolder(cwd, "fix-login");
    runFolder(cwd, "pending");

    const found = attach(cwd, home, "fix-login");
    expect(found.code).toBe(0);
    expect(found.stdout).toEndWith("attach-session -t =claude-fix-login-3c4d:");

    const unknown = attach(cwd, home, "nope");
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("nope");

    const noTerminal = attach(cwd, home, "pending");
    expect(noTerminal.code).toBe(1);
    expect(noTerminal.stderr).toContain("no terminal yet");
  }, 40_000);

  test("takes a run id only through --run-id, and refuses a name and --run-id that disagree", async () => {
    const cwd = makeRepo();
    const home = mkdtempSync(join(tmpdir(), "harness-attach-home-"));
    const registry = createRegistry(registryPath(home));
    await registry.addRun(run("r-1a2b3c4d", "fix-login", cwd, "claude-fix-login-3c4d"));
    runFolder(cwd, "fix-login");

    const byId = attach(cwd, home, "--run-id", "r-1a2b3c4d");
    expect(byId.code).toBe(0);
    expect(byId.stdout).toEndWith("attach-session -t =claude-fix-login-3c4d:");

    const idAsName = attach(cwd, home, "r-1a2b3c4d");
    expect(idAsName.code).toBe(1);
    expect(idAsName.stderr).toContain('no run named "r-1a2b3c4d"');

    const unknownId = attach(cwd, home, "--run-id", "r-00000000");
    expect(unknownId.code).toBe(1);
    expect(unknownId.stderr).toContain("r-00000000");

    expect(attach(cwd, home).code).toBe(1);
    const mismatched = attach(cwd, home, "other-run", "--run-id", "r-1a2b3c4d");
    expect(mismatched.code).toBe(1);
    expect(mismatched.stderr).toContain("name different runs");
  }, 40_000);

  test("finds a run started in a linked worktree of this repo, as orchestrate does", async () => {
    const cwd = makeRepo();
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd });
    const worktree = join(cwd, "wt");
    execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "wt"], { cwd });
    const home = mkdtempSync(join(tmpdir(), "harness-attach-home-"));
    const registry = createRegistry(registryPath(home));
    await registry.addRun(run("r-9c0d1e2f", "in-worktree", worktree, "claude-in-worktree-1e2f"));
    runFolder(worktree, "in-worktree");

    const found = attach(cwd, home, "in-worktree");

    expect(found.stderr).toBe("");
    expect(found.stdout).toEndWith("attach-session -t =claude-in-worktree-1e2f:");
  }, 40_000);
});
