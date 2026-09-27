import { describe, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Exec } from "./check.ts";
import { createGit, type IGit } from "./git.ts";

type Call = Readonly<{ command: string; args: readonly string[]; cwd: string }>;

const recordingExec = (result: { code: number; stdout?: string; stderr?: string }) => {
  const calls: Call[] = [];
  const exec: Exec = (command, args, cwd) => {
    calls.push({ command, args, cwd });
    return Promise.resolve({
      code: result.code,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
  };
  return { exec, calls };
};

type Case = Readonly<{ name: string; run: (git: IGit) => Promise<unknown>; expected: Call[] }>;

const CASES: Case[] = [
  {
    name: "repoRoot",
    run: (git) => git.repoRoot("/cwd"),
    expected: [{ command: "git", args: ["rev-parse", "--show-toplevel"], cwd: "/cwd" }],
  },
  {
    name: "commonDir",
    run: (git) => git.commonDir("/cwd"),
    expected: [
      {
        command: "git",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd: "/cwd",
      },
    ],
  },
  {
    name: "currentBranch",
    run: (git) => git.currentBranch("/cwd"),
    expected: [{ command: "git", args: ["rev-parse", "--abbrev-ref", "HEAD"], cwd: "/cwd" }],
  },
  {
    name: "headSha",
    run: (git) => git.headSha("/cwd"),
    expected: [{ command: "git", args: ["rev-parse", "HEAD"], cwd: "/cwd" }],
  },
  {
    name: "defaultBranch",
    run: (git) => git.defaultBranch("/cwd"),
    expected: [
      {
        command: "git",
        args: ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        cwd: "/cwd",
      },
    ],
  },
  {
    name: "isValidBranchName",
    run: (git) => git.isValidBranchName("/cwd", "feat/x"),
    expected: [{ command: "git", args: ["check-ref-format", "--branch", "feat/x"], cwd: "/cwd" }],
  },
  {
    name: "branchExists",
    run: (git) => git.branchExists("/cwd", "feat/x"),
    expected: [
      {
        command: "git",
        args: ["rev-parse", "--verify", "--quiet", "refs/heads/feat/x"],
        cwd: "/cwd",
      },
    ],
  },
  {
    name: "isIgnored",
    run: (git) => git.isIgnored("/cwd", "/cwd/.harness/probe"),
    expected: [
      { command: "git", args: ["check-ignore", "-q", "/cwd/.harness/probe"], cwd: "/cwd" },
    ],
  },
  {
    name: "hasRemote",
    run: (git) => git.hasRemote("/cwd", "origin"),
    expected: [{ command: "git", args: ["remote", "get-url", "origin"], cwd: "/cwd" }],
  },
  {
    name: "fetch",
    run: (git) => git.fetch("/cwd", { remote: "origin", ref: "main" }),
    expected: [{ command: "git", args: ["fetch", "origin", "--", "main"], cwd: "/cwd" }],
  },
  {
    name: "remoteHasBranch",
    run: (git) => git.remoteHasBranch("/cwd", "origin", "main"),
    expected: [
      {
        command: "git",
        args: ["ls-remote", "--exit-code", "--heads", "origin", "refs/heads/main"],
        cwd: "/cwd",
      },
    ],
  },
  {
    name: "addWorktree with a base creates the branch from it",
    run: (git) => git.addWorktree("/cwd", { path: "/wt", branch: "feat/x", base: "main" }),
    expected: [
      { command: "git", args: ["worktree", "add", "-b", "feat/x", "/wt", "main"], cwd: "/cwd" },
    ],
  },
  {
    name: "addWorktree with no base checks the existing branch out",
    run: (git) => git.addWorktree("/cwd", { path: "/wt", branch: "feat/x" }),
    expected: [{ command: "git", args: ["worktree", "add", "/wt", "feat/x"], cwd: "/cwd" }],
  },
  {
    name: "listWorktrees",
    run: (git) => git.listWorktrees("/cwd"),
    expected: [{ command: "git", args: ["worktree", "list", "--porcelain"], cwd: "/cwd" }],
  },
  {
    name: "removeWorktree",
    run: (git) => git.removeWorktree("/cwd", "/wt"),
    expected: [{ command: "git", args: ["worktree", "remove", "/wt"], cwd: "/cwd" }],
  },
  {
    name: "removeWorktree with force",
    run: (git) => git.removeWorktree("/cwd", "/wt", { force: true }),
    expected: [{ command: "git", args: ["worktree", "remove", "--force", "/wt"], cwd: "/cwd" }],
  },
];

describe("createGit", () => {
  test.each(CASES)(
    "SC28: $name sends exactly the documented git arguments",
    async ({ run, expected }) => {
      const { exec, calls } = recordingExec({ code: 1, stdout: "" });
      await run(createGit(exec));
      expect(calls).toEqual(expected);
    },
  );

  test("SC32: repoRoot resolves null, not a thrown error, when exec rejects", async () => {
    const exec: Exec = () => Promise.reject(new Error("timed out after 5s"));
    await expect(createGit(exec).repoRoot("/cwd")).resolves.toBeNull();
  });
});

const pExecFile = promisify(execFile);

// A real exec, so the integration tests below drive actual git.
const realExec: Exec = async (command, args, cwd) => {
  try {
    const { stdout, stderr } = await pExecFile(command, [...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "git-sdk-")));

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

describe("createGit (integration)", () => {
  test("repoRoot returns the repository's top folder from a nested subfolder, and null outside any repository", async () => {
    const root = makeRepo();
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    const plainDir = tempDir();

    expect(await createGit(realExec).repoRoot(nested)).toBe(root);
    expect(await createGit(realExec).repoRoot(plainDir)).toBeNull();
  });

  test("SC29: listWorktrees returns the main checkout first, then a linked branch, then a detached one", async () => {
    const root = makeRepo();
    const base = tempDir();
    const linkedPath = join(base, "linked");
    const detachedPath = join(base, "detached");
    gitCmd(root, "branch", "feat/x");
    gitCmd(root, "worktree", "add", linkedPath, "feat/x");
    gitCmd(root, "worktree", "add", "--detach", detachedPath);

    const result = await createGit(realExec).listWorktrees(root);
    expect(result.ok).toBe(true);
    const entries = result.ok ? result.value : [];
    expect(entries[0]).toEqual({ path: root, branch: "main" });
    expect(entries).toHaveLength(3);
    expect(entries.slice(1)).toEqual(
      expect.arrayContaining([
        { path: linkedPath, branch: "feat/x" },
        { path: detachedPath, branch: null },
      ]),
    );
  });

  test("SC30: defaultBranch is null with no origin, and reads origin/HEAD in a clone", async () => {
    const root = makeRepo();
    expect(await createGit(realExec).defaultBranch(root)).toBeNull();

    const clonePath = join(tempDir(), "clone");
    gitCmd(tmpdir(), "clone", "-q", root, clonePath);
    expect(await createGit(realExec).defaultBranch(clonePath)).toBe("main");
  });

  test("hasRemote is false with no origin and true in a clone; fetch fails once origin is gone", async () => {
    const root = makeRepo();
    const git = createGit(realExec);
    expect(await git.hasRemote(root, "origin")).toBe(false);

    const clonePath = join(tempDir(), "clone");
    gitCmd(tmpdir(), "clone", "-q", root, clonePath);
    expect(await git.hasRemote(clonePath, "origin")).toBe(true);
    expect((await git.fetch(clonePath, { remote: "origin", ref: "main" })).ok).toBe(true);

    gitCmd(clonePath, "remote", "set-url", "origin", join(tempDir(), "gone"));
    const fetched = await git.fetch(clonePath, { remote: "origin", ref: "main" });
    expect(fetched.ok ? "" : fetched.error).toContain("gone");
  });

  test("remoteHasBranch is true for a branch on origin, false for one that is not, and an error once origin is gone", async () => {
    const root = makeRepo();
    const git = createGit(realExec);
    const clonePath = join(tempDir(), "clone");
    gitCmd(tmpdir(), "clone", "-q", root, clonePath);
    expect(await git.remoteHasBranch(clonePath, "origin", "main")).toEqual({
      ok: true,
      value: true,
    });
    expect(await git.remoteHasBranch(clonePath, "origin", "nope")).toEqual({
      ok: true,
      value: false,
    });

    gitCmd(clonePath, "remote", "set-url", "origin", join(tempDir(), "gone"));
    expect((await git.remoteHasBranch(clonePath, "origin", "main")).ok).toBe(false);
  });

  test("SC31: addWorktree creates a new branch from base, then checks out the existing branch", async () => {
    const root = makeRepo();
    const git = createGit(realExec);
    const base = gitCmd(root, "rev-parse", "HEAD");
    const wt1 = join(tempDir(), "wt1");

    const created = await git.addWorktree(root, { path: wt1, branch: "feat/new", base });
    expect(created.ok).toBe(true);
    expect(gitCmd(wt1, "rev-parse", "HEAD")).toBe(base);
    expect(gitCmd(wt1, "branch", "--show-current")).toBe("feat/new");

    gitCmd(root, "worktree", "remove", wt1);
    gitCmd(
      root,
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "2",
    );
    const wt2 = join(tempDir(), "wt2");

    const checkedOut = await git.addWorktree(root, { path: wt2, branch: "feat/new" });
    expect(checkedOut.ok).toBe(true);
    // Still the old tip, not the new HEAD: proof it checked the branch out rather than recreating it.
    expect(gitCmd(wt2, "rev-parse", "HEAD")).toBe(base);
    expect(gitCmd(wt2, "branch", "--show-current")).toBe("feat/new");
  });
});
