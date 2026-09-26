import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");

const makeRepo = (dir: string, ignored: string): string => {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ignored);
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const harness = (cwd: string, ...args: string[]) => {
  const run = spawnSync("bun", [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "wt-cli-")));

const tempRepo = (): string => makeRepo(tempDir(), ".worktrees/\n");

const makeMulti = (): string => {
  const root = makeRepo(tempDir(), ".workspaces/\napi/\nweb/\n");
  makeRepo(join(root, "api"), "");
  makeRepo(join(root, "web"), "");
  writeFileSync(
    join(root, "orchestrate.config.json"),
    JSON.stringify({
      version: 2,
      worktree: { layout: "multi" },
      packages: { api: { path: "api" }, web: { path: "web" } },
    }),
  );
  return root;
};

describe("harness worktree", () => {
  test("create prints the report as JSON and sends setup output to stderr", () => {
    const root = tempRepo();
    writeFileSync(
      join(root, "orchestrate.config.json"),
      JSON.stringify({
        version: 2,
        worktree: { setup: "echo installing" },
      }),
    );
    const run = harness(root, "worktree", "create", "feat/a");
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({
      layout: "mono",
      branch: "feat/a",
      repos: [{ path: join(root, ".worktrees/feat-a"), status: "ready" }],
    });
    expect(run.stderr).toContain("installing");
  });

  test("create in a multi repo takes a comma-separated --repos", () => {
    const root = makeMulti();
    const run = harness(root, "worktree", "create", "b", "--repos", "api,web");
    expect(run.code).toBe(0);
    expect(existsSync(join(root, ".workspaces/b/api"))).toBe(true);
    expect(existsSync(join(root, ".workspaces/b/web"))).toBe(true);
  });

  test("a failed setup exits 1 and still prints the report", () => {
    const root = tempRepo();
    writeFileSync(
      join(root, "orchestrate.config.json"),
      JSON.stringify({
        version: 2,
        worktree: { setup: "exit 2" },
      }),
    );
    const run = harness(root, "worktree", "create", "b");
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout).repos[0].status).toBe("failed");
  });

  test("a config error exits 1 with the reason and no report", () => {
    const root = tempRepo();
    const run = harness(root, "worktree", "create", "b", "--repos", "api");
    expect(run.code).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("mono");
  });

  test("run from inside a multi workspace repo, remove finds the meta repo", () => {
    const root = makeMulti();
    harness(root, "worktree", "create", "b", "--repos", "api,web");
    const run = harness(join(root, ".workspaces/b/api"), "worktree", "remove", "b");
    expect(run.code).toBe(0);
    expect(existsSync(join(root, ".workspaces/b"))).toBe(false);
  });

  test("run from inside a worktree, remove still finds the main checkout", () => {
    const root = tempRepo();
    harness(root, "worktree", "create", "b");
    const run = harness(join(root, ".worktrees/b"), "worktree", "remove", "b");
    expect(run.code).toBe(0);
    expect(existsSync(join(root, ".worktrees/b"))).toBe(false);
  });
});
