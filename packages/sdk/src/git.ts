import type { Exec, ExecResult } from "./check.ts";
import type { Result } from "./contracts.ts";
import { execWithTimeout } from "./process.ts";

export type WorktreeEntry = Readonly<{ path: string; branch: string | null }>;

export interface IGit {
  repoRoot(cwd: string): Promise<string | null>;
  commonDir(cwd: string): Promise<string | null>;
  currentBranch(cwd: string): Promise<Result<string>>;
  headSha(cwd: string): Promise<Result<string>>;
  defaultBranch(cwd: string): Promise<string | null>;
  isValidBranchName(cwd: string, name: string): Promise<boolean>;
  branchExists(cwd: string, branch: string): Promise<boolean>;
  isIgnored(cwd: string, path: string): Promise<boolean>;
  hasRemote(cwd: string, remote: string): Promise<boolean>;
  remoteHasBranch(cwd: string, remote: string, branch: string): Promise<Result<boolean>>;
  fetch(cwd: string, target: { remote: string; ref: string }): Promise<Result<void>>;
  // With a base, creates the branch from it; without one, checks the existing branch out.
  addWorktree(
    cwd: string,
    worktree: { path: string; branch: string; base?: string },
  ): Promise<Result<void>>;
  listWorktrees(cwd: string): Promise<Result<readonly WorktreeEntry[]>>;
  removeWorktree(cwd: string, path: string, options?: { force?: boolean }): Promise<Result<void>>;
}

const parseWorktreeBlock = (block: string): WorktreeEntry => {
  const field = (key: string): string | undefined =>
    block
      .split("\n")
      .find((line) => line.startsWith(`${key} `))
      ?.slice(key.length + 1);
  const branch = field("branch");
  return {
    path: field("worktree") ?? "",
    branch: branch ? branch.replace(/^refs\/heads\//, "") : null,
  };
};

const GIT_TIMEOUT_MS = 10_000;

// Every helper runs one git command and parses its output; a rejected exec (a timeout) never
// throws out of a helper, it just looks like a failed command. Callers leave `exec` out; tests
// pass a fake one.
export const createGit = (exec: Exec = execWithTimeout(GIT_TIMEOUT_MS)): IGit => {
  const run = async (cwd: string, args: readonly string[]): Promise<ExecResult> => {
    try {
      return await exec("git", args, cwd);
    } catch (error) {
      // The reason (such as "timed out after 10s") is the only stderr a rejected run has.
      return {
        code: 1,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const branchExists = async (cwd: string, branch: string): Promise<boolean> =>
    (await run(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;

  return {
    repoRoot: async (cwd) => {
      const { code, stdout } = await run(cwd, ["rev-parse", "--show-toplevel"]);
      return code === 0 ? stdout.trim() : null;
    },

    commonDir: async (cwd) => {
      const { code, stdout } = await run(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ]);
      return code === 0 ? stdout.trim() : null;
    },

    currentBranch: async (cwd) => {
      const { code, stdout, stderr } = await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      return code === 0 ? { ok: true, value: stdout.trim() } : { ok: false, error: stderr.trim() };
    },

    headSha: async (cwd) => {
      const { code, stdout, stderr } = await run(cwd, ["rev-parse", "HEAD"]);
      return code === 0 ? { ok: true, value: stdout.trim() } : { ok: false, error: stderr.trim() };
    },

    defaultBranch: async (cwd) => {
      const { code, stdout } = await run(cwd, [
        "symbolic-ref",
        "--short",
        "refs/remotes/origin/HEAD",
      ]);
      return code === 0 ? stdout.trim().replace(/^origin\//, "") : null;
    },

    isValidBranchName: async (cwd, name) =>
      (await run(cwd, ["check-ref-format", "--branch", name])).code === 0,

    branchExists,

    isIgnored: async (cwd, path) => (await run(cwd, ["check-ignore", "-q", path])).code === 0,

    hasRemote: async (cwd, remote) => (await run(cwd, ["remote", "get-url", remote])).code === 0,

    // ls-remote --exit-code exits 2 when nothing matches; any other failure is a real error.
    remoteHasBranch: async (cwd, remote, branch) => {
      const args = ["ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`];
      const { code, stderr } = await run(cwd, args);
      if (code === 0 || code === 2) return { ok: true, value: code === 0 };
      return { ok: false, error: stderr.trim() };
    },

    fetch: async (cwd, target) => {
      // "--" ends the options, so a ref such as "--upload-pack=CMD" can never be read as one.
      const { code, stderr } = await run(cwd, ["fetch", target.remote, "--", target.ref]);
      return code === 0 ? { ok: true, value: undefined } : { ok: false, error: stderr.trim() };
    },

    addWorktree: async (cwd, worktree) => {
      const args =
        worktree.base === undefined
          ? ["worktree", "add", worktree.path, worktree.branch]
          : ["worktree", "add", "-b", worktree.branch, worktree.path, worktree.base];
      const { code, stderr } = await run(cwd, args);
      return code === 0 ? { ok: true, value: undefined } : { ok: false, error: stderr.trim() };
    },

    listWorktrees: async (cwd) => {
      const { code, stdout, stderr } = await run(cwd, ["worktree", "list", "--porcelain"]);
      if (code !== 0) return { ok: false, error: stderr.trim() };
      const blocks = stdout
        .trim()
        .split("\n\n")
        .filter((block) => block !== "");
      return { ok: true, value: blocks.map(parseWorktreeBlock) };
    },

    removeWorktree: async (cwd, path, options) => {
      const force = options?.force === true ? ["--force"] : [];
      const { code, stderr } = await run(cwd, ["worktree", "remove", ...force, path]);
      return code === 0 ? { ok: true, value: undefined } : { ok: false, error: stderr.trim() };
    },
  };
};
