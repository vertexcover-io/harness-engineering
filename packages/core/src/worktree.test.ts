import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
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
import { createWorktrees, type OutputLine, removeWorktrees } from "./worktree.ts";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeRepo = (dir: string, ignored: readonly string[] = [".worktrees/"]): string => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), `${ignored.join("\n")}\n`);
  git(dir, "add", ".");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "wt-")));

const writeConfig = (root: string, config: object): void =>
  writeFileSync(join(root, "orchestrate.config.json"), JSON.stringify({ version: 2, ...config }));

const RECORD_ENV = `import { writeFileSync } from "node:fs";
const keys = ["WORKTREE_PATH", "PRIMARY_WORKTREE_PATH", "BRANCH_NAME", "REPO_NAME", "WORKSPACE_PATH"];
writeFileSync("env.json", JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k]]))));
`;

const readEnv = (worktree: string): unknown =>
  JSON.parse(readFileSync(join(worktree, "env.json"), "utf8"));

const makeMulti = (config: Record<string, unknown>): string => {
  const root = makeRepo(tempDir(), [".workspaces/", "serana/", "courier/"]);
  makeRepo(join(root, "serana"));
  makeRepo(join(root, "courier"));
  writeConfig(root, {
    worktree: { layout: "multi" },
    packages: { serana: { path: "serana" }, courier: { path: "courier" } },
    ...config,
  });
  return root;
};

describe("mono repo", () => {
  test("with no worktree config, creates .worktrees/BRANCH on a new branch and runs nothing", async () => {
    const root = makeRepo(tempDir());
    const result = await createWorktrees({ root, branch: "feat/auth" });
    const path = join(root, ".worktrees/feat-auth");
    expect(result).toEqual({
      ok: true,
      value: {
        layout: "mono",
        branch: "feat/auth",
        workspace: path,
        repos: [{ name: expect.any(String), path, status: "ready" }],
      },
    });
    expect(git(path, "branch", "--show-current")).toBe("feat/auth");
  });

  test("runs a TypeScript setup inside the worktree with every variable set", async () => {
    const root = makeRepo(tempDir());
    writeFileSync(join(root, "record.ts"), RECORD_ENV);
    writeConfig(root, {
      worktree: {
        path: ".worktrees/x-{{ branch }}",
        setup: 'bun "$PRIMARY_WORKTREE_PATH/record.ts"',
      },
    });
    const result = await createWorktrees({ root, branch: "feat/auth" });
    const path = join(root, ".worktrees/x-feat-auth");
    expect(result.ok && result.value.repos[0]?.status).toBe("ready");
    expect(readEnv(path)).toEqual({
      WORKTREE_PATH: path,
      PRIMARY_WORKTREE_PATH: root,
      BRANCH_NAME: "feat/auth",
      REPO_NAME: expect.any(String),
      WORKSPACE_PATH: path,
    });
  });

  test("checks out a branch that already exists instead of creating it", async () => {
    const root = makeRepo(tempDir());
    git(root, "branch", "feat/old");
    const result = await createWorktrees({ root, branch: "feat/old" });
    expect(result.ok).toBe(true);
    expect(git(join(root, ".worktrees/feat-old"), "branch", "--show-current")).toBe("feat/old");
  });

  test("a failing setup keeps the worktree and reports the exit code", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { worktree: { setup: "echo broke >&2; exit 3" } });
    const lines: OutputLine[] = [];
    const result = await createWorktrees({
      root,
      branch: "b",
      onOutput: (line) => lines.push(line),
    });
    const repo = result.ok ? result.value.repos[0] : undefined;
    expect(repo?.status).toBe("failed");
    expect(repo?.failedAt).toBe("setup");
    expect(repo?.error).toContain("exit code 3");
    expect(existsSync(join(root, ".worktrees/b"))).toBe(true);
    expect(lines.map((line) => line.text)).toContain("broke");
  });

  test("a partial stdout line is never glued onto a stderr line", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, {
      worktree: { setup: "printf out; sleep 0.1; printf 'err\\n' >&2; sleep 0.1; printf '\\n'" },
    });
    const lines: OutputLine[] = [];
    await createWorktrees({ root, branch: "b", onOutput: (line) => lines.push(line) });
    expect(lines.map((line) => line.text).sort()).toEqual(["err", "out"]);
  });

  test("remove runs teardown, then removes the worktree", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { worktree: { teardown: 'touch "$PRIMARY_WORKTREE_PATH/torn-down"' } });
    await createWorktrees({ root, branch: "b" });
    const result = await removeWorktrees({ root, branch: "b" });
    expect(result.ok && result.value.repos[0]?.status).toBe("removed");
    expect(existsSync(join(root, "torn-down"))).toBe(true);
    expect(existsSync(join(root, ".worktrees/b"))).toBe(false);
  });

  test("a failing teardown keeps the worktree", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { worktree: { teardown: "exit 1" } });
    await createWorktrees({ root, branch: "b" });
    const result = await removeWorktrees({ root, branch: "b" });
    expect(result.ok && result.value.repos[0]?.failedAt).toBe("teardown");
    expect(existsSync(join(root, ".worktrees/b"))).toBe(true);
  });

  test("a branch git refuses to check out fails at the add step with nothing on disk", async () => {
    const root = makeRepo(tempDir());
    const result = await createWorktrees({ root, branch: "main" });
    const repo = result.ok ? result.value.repos[0] : undefined;
    expect(repo?.failedAt).toBe("add");
    expect(repo?.error).toContain("main");
    expect(existsSync(join(root, ".worktrees/main"))).toBe(false);
  });

  test("a new branch starts from --base", async () => {
    const root = makeRepo(tempDir());
    const first = git(root, "rev-parse", "HEAD");
    git(
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
    await createWorktrees({ root, branch: "b", base: first });
    expect(git(join(root, ".worktrees/b"), "rev-parse", "HEAD")).toBe(first);
  });

  test("a worktree with untracked files is removed only with force", async () => {
    const root = makeRepo(tempDir());
    await createWorktrees({ root, branch: "b" });
    writeFileSync(join(root, ".worktrees/b/scratch.txt"), "work");
    const kept = await removeWorktrees({ root, branch: "b" });
    expect(kept.ok && kept.value.repos[0]?.failedAt).toBe("remove");
    expect(existsSync(join(root, ".worktrees/b"))).toBe(true);
    const forced = await removeWorktrees({ root, branch: "b", force: true });
    expect(forced.ok && forced.value.repos[0]?.status).toBe("removed");
    expect(existsSync(join(root, ".worktrees/b"))).toBe(false);
  });

  test("remove with a branch that resolves outside .worktrees never runs teardown", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { worktree: { teardown: 'touch "$WORKTREE_PATH/torn-down"' } });
    const result = await removeWorktrees({ root, branch: "..", force: true });
    expect(result.ok ? "" : result.error).toContain("invalid branch name");
    expect(existsSync(join(root, "torn-down"))).toBe(false);
  });

  test("remove leaves alone a worktree that belongs to a different branch at the same path", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { worktree: { teardown: 'touch "$PRIMARY_WORKTREE_PATH/torn-down"' } });
    await createWorktrees({ root, branch: "feat/a" });
    const result = await removeWorktrees({ root, branch: "feat-a" });
    const repo = result.ok ? result.value.repos[0] : undefined;
    expect(repo?.status).toBe("failed");
    expect(repo?.error).toContain("feat/a");
    expect(existsSync(join(root, "torn-down"))).toBe(false);
    expect(existsSync(join(root, ".worktrees/feat-a"))).toBe(true);
  });

  test("removing a worktree that does not exist is an error", async () => {
    const root = makeRepo(tempDir());
    const result = await removeWorktrees({ root, branch: "nope" });
    expect(result.ok).toBe(false);
  });
});

describe("multi repo", () => {
  test("creates one worktree per repo under the workspace, each set up with its own variables", async () => {
    const root = makeMulti({});
    writeFileSync(join(root, "record.ts"), RECORD_ENV);
    writeConfig(root, {
      worktree: {
        layout: "multi",
        setup: `bun ${join(root, "record.ts")} && echo "hi $REPO_NAME"`,
      },
      packages: { serana: { path: "serana" }, courier: { path: "courier" } },
    });
    const lines: OutputLine[] = [];
    const result = await createWorktrees({
      root,
      branch: "feat/x",
      repos: ["serana", "courier"],
      onOutput: (line) => lines.push(line),
    });
    const workspace = join(root, ".workspaces/feat-x");
    expect(result.ok && result.value.workspace).toBe(workspace);
    expect(result.ok && result.value.repos.map((r) => [r.name, r.status])).toEqual([
      ["serana", "ready"],
      ["courier", "ready"],
    ]);
    expect(readEnv(join(workspace, "serana"))).toEqual({
      WORKTREE_PATH: join(workspace, "serana"),
      PRIMARY_WORKTREE_PATH: join(root, "serana"),
      BRANCH_NAME: "feat/x",
      REPO_NAME: "serana",
      WORKSPACE_PATH: workspace,
    });
    expect(git(join(workspace, "courier"), "branch", "--show-current")).toBe("feat/x");
    expect(git(join(root, "courier"), "branch", "--show-current")).toBe("main");
    expect(lines).toContainEqual({ repo: "serana", text: "hi serana" });
  });

  test("a package's own worktreeSetup beats the shared setup", async () => {
    const root = makeMulti({
      worktree: { layout: "multi", setup: "echo shared > marker" },
      packages: {
        serana: { path: "serana", commands: { worktreeSetup: "echo own > marker" } },
        courier: { path: "courier" },
      },
    });
    await createWorktrees({ root, branch: "b", repos: ["serana", "courier"] });
    const marker = (repo: string) =>
      readFileSync(join(root, ".workspaces/b", repo, "marker"), "utf8").trim();
    expect(marker("serana")).toBe("own");
    expect(marker("courier")).toBe("shared");
  });

  test("a package whose worktreeSetup is null runs no setup at all", async () => {
    const root = makeMulti({
      worktree: { layout: "multi", setup: "echo shared > marker" },
      packages: {
        serana: { path: "serana", commands: { worktreeSetup: null } },
        courier: { path: "courier" },
      },
    });
    await createWorktrees({ root, branch: "b", repos: ["serana", "courier"] });
    expect(existsSync(join(root, ".workspaces/b/serana/marker"))).toBe(false);
    expect(existsSync(join(root, ".workspaces/b/courier/marker"))).toBe(true);
  });

  test("one repo's failed setup does not stop the others", async () => {
    const root = makeMulti({
      packages: {
        serana: { path: "serana", commands: { worktreeSetup: "exit 1" } },
        courier: { path: "courier" },
      },
    });
    const result = await createWorktrees({ root, branch: "b", repos: ["serana", "courier"] });
    expect(result.ok && result.value.repos.map((r) => r.status)).toEqual(["failed", "ready"]);
    expect(existsSync(join(root, ".workspaces/b/serana"))).toBe(true);
  });

  test("remove with no repos named removes every repo's worktree and the empty workspace", async () => {
    const root = makeMulti({});
    await createWorktrees({ root, branch: "b", repos: ["serana", "courier"] });
    const result = await removeWorktrees({ root, branch: "b" });
    expect(result.ok && result.value.repos.map((r) => [r.name, r.status])).toEqual([
      ["serana", "removed"],
      ["courier", "removed"],
    ]);
    expect(existsSync(join(root, ".workspaces/b"))).toBe(false);
  });
});

type Rejection = Readonly<{
  name: string;
  root: () => string;
  branch?: string;
  repos?: readonly string[];
  messages: readonly string[];
}>;

const withConfig = (config: object, ignored?: readonly string[]) => (): string => {
  const root = makeRepo(tempDir(), ignored);
  writeConfig(root, config);
  return root;
};

const REJECTIONS: Rejection[] = [
  {
    name: "unknown path placeholder",
    root: withConfig({ worktree: { path: ".worktrees/{{ repo }}" } }),
    messages: ["{{ repo }}"],
  },
  {
    name: "config not matching the schema, every problem named",
    root: withConfig({ worktree: { layout: "poly", path: 3 } }),
    messages: ["worktree.layout", "worktree.path"],
  },
  {
    name: "invalid branch name",
    root: withConfig({}),
    branch: "bad..name",
    messages: ["bad..name"],
  },
  { name: "path git does not ignore", root: withConfig({}, ["other/"]), messages: ["not ignored"] },
  {
    name: "path that already exists",
    root: () => {
      const root = makeRepo(tempDir());
      mkdirSync(join(root, ".worktrees/b"), { recursive: true });
      return root;
    },
    messages: ["already exists"],
  },
  { name: "--repos in a mono repo", root: withConfig({}), repos: ["serana"], messages: ["mono"] },
  {
    name: "package worktree command in a mono repo",
    root: withConfig({ packages: { api: { path: "api", commands: { worktreeSetup: "true" } } } }),
    messages: ["api"],
  },
  { name: "no --repos in a multi repo", root: () => makeMulti({}), messages: ["--repos"] },
  {
    name: "unknown repo in a multi repo",
    root: () => makeMulti({}),
    repos: ["serana", "ghost"],
    messages: ["ghost"],
  },
  {
    name: "multi workspace the meta repo does not ignore",
    root: () => {
      const root = makeRepo(tempDir(), ["serana/"]);
      makeRepo(join(root, "serana"));
      writeConfig(root, {
        worktree: { layout: "multi" },
        packages: { serana: { path: "serana" } },
      });
      return root;
    },
    repos: ["serana"],
    messages: ["not ignored"],
  },
  {
    name: "multi package that is not its own git repo",
    root: () => {
      const root = makeMulti({ packages: { plain: { path: "plain" } } });
      mkdirSync(join(root, "plain"));
      return root;
    },
    repos: ["plain"],
    messages: ["plain"],
  },
];

test.each(REJECTIONS)("rejected before anything is created: $name", async (rejection) => {
  const root = rejection.root();
  const createdBefore = existsSync(join(root, ".worktrees/b"));
  const result = await createWorktrees({
    root,
    branch: rejection.branch ?? "b",
    repos: rejection.repos,
  });
  const error = result.ok ? "" : result.error;
  for (const message of rejection.messages) expect(error).toContain(message);
  expect(existsSync(join(root, ".worktrees/b"))).toBe(createdBefore);
  expect(existsSync(join(root, ".workspaces"))).toBe(false);
});
