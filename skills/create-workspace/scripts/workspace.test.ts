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
import { ERROR_MESSAGE_LIMIT, type RunRef, runDirOf } from "@harness/sdk";
import { jsonlEventStore } from "@harness/sdk/internal";
import {
  addRepositories,
  CreateWorkspaceInputSchema,
  createWorkspace,
  type OutputLine,
  type RepoOutcome,
  removeWorkspace,
} from "./workspace.ts";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const commit = (cwd: string, message: string): string => {
  git(
    cwd,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    message,
  );
  return git(cwd, "rev-parse", "HEAD");
};

const failure = (repo: RepoOutcome | undefined) =>
  repo?.status === "failed" ? repo.error : undefined;

const ready = (repo: RepoOutcome | undefined) => (repo?.status === "ready" ? repo : undefined);

const makeRepo = (dir: string, ignored: readonly string[] = [".worktrees/"]): string => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), `${ignored.join("\n")}\n`);
  git(dir, "add", ".");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "wt-")));

// A run folder of its own, so the events a command records never land in the repo under test.
const newRun = (): RunRef => {
  const run = { id: "r-1", cwd: tempDir(), name: "feat-x" };
  mkdirSync(runDirOf(run.cwd, run.name), { recursive: true });
  return run;
};

const eventsOf = (run: RunRef) => jsonlEventStore(runDirOf(run.cwd, run.name)).read();

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
    workspace: { layout: "multi" },
    packages: { serana: { path: "serana" }, courier: { path: "courier" } },
    ...config,
  });
  return root;
};

describe("mono repo", () => {
  test("with no workspace config, creates .worktrees/BRANCH on a new branch and runs nothing", async () => {
    const root = makeRepo(tempDir());
    const result = await createWorkspace({ root, branch: "feat/auth" });
    const path = join(root, ".worktrees/feat-auth");
    expect(result).toEqual({
      ok: true,
      value: {
        layout: "mono",
        branch: "feat/auth",
        workspaceDir: path,
        repos: [
          {
            name: expect.any(String),
            worktreeDir: path,
            checkoutDir: root,
            status: "ready",
            baseBranch: "main",
            startSha: git(root, "rev-parse", "HEAD"),
          },
        ],
      },
    });
    expect(git(path, "branch", "--show-current")).toBe("feat/auth");
  });

  test("runs a TypeScript setup inside the worktree with every variable set", async () => {
    const root = makeRepo(tempDir());
    writeFileSync(join(root, "record.ts"), RECORD_ENV);
    writeConfig(root, {
      workspace: {
        path: ".worktrees/x-{{ branch }}",
        setup: 'bun "$PRIMARY_WORKTREE_PATH/record.ts"',
      },
    });
    const result = await createWorkspace({ root, branch: "feat/auth" });
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
    const result = await createWorkspace({ root, branch: "feat/old" });
    expect(result.ok).toBe(true);
    expect(git(join(root, ".worktrees/feat-old"), "branch", "--show-current")).toBe("feat/old");
  });

  test("a failing setup keeps the worktree and reports the exit code", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { workspace: { setup: "echo broke >&2; exit 3" } });
    const lines: OutputLine[] = [];
    const result = await createWorkspace({
      root,
      branch: "b",
      onOutput: (line) => lines.push(line),
    });
    const repo = result.ok ? result.value.repos[0] : undefined;
    expect(repo?.status).toBe("failed");
    expect(failure(repo)?.kind).toBe("setup");
    expect(failure(repo)?.message).toContain("exit code 3");
    expect(failure(repo)?.message).toContain("broke");
    expect(existsSync(join(root, ".worktrees/b"))).toBe(true);
    expect(lines.map((line) => line.text)).toContain("broke");
  });

  test("a partial stdout line is never glued onto a stderr line", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, {
      workspace: { setup: "printf out; sleep 0.1; printf 'err\\n' >&2; sleep 0.1; printf '\\n'" },
    });
    const lines: OutputLine[] = [];
    await createWorkspace({ root, branch: "b", onOutput: (line) => lines.push(line) });
    expect(lines.map((line) => line.text).sort()).toEqual(["err", "out"]);
  });

  test("remove runs teardown, then removes the worktree", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { workspace: { teardown: 'touch "$PRIMARY_WORKTREE_PATH/torn-down"' } });
    await createWorkspace({ root, branch: "b" });
    const result = await removeWorkspace({ root, branch: "b" });
    expect(result.ok && result.value.repos[0]?.status).toBe("removed");
    expect(existsSync(join(root, "torn-down"))).toBe(true);
    expect(existsSync(join(root, ".worktrees/b"))).toBe(false);
  });

  test("a failing teardown keeps the worktree", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { workspace: { teardown: "exit 1" } });
    await createWorkspace({ root, branch: "b" });
    const result = await removeWorkspace({ root, branch: "b" });
    expect(result.ok && failure(result.value.repos[0])?.kind).toBe("teardown");
    expect(existsSync(join(root, ".worktrees/b"))).toBe(true);
  });

  test("a branch git refuses to check out fails at the add step with nothing on disk", async () => {
    const root = makeRepo(tempDir());
    const result = await createWorkspace({ root, branch: "main" });
    const repo = result.ok ? result.value.repos[0] : undefined;
    expect(failure(repo)?.kind).toBe("add");
    expect(failure(repo)?.message).toContain("main");
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
    await createWorkspace({ root, branch: "b", base: first });
    expect(git(join(root, ".worktrees/b"), "rev-parse", "HEAD")).toBe(first);
  });

  test("a worktree with untracked files is removed only with force", async () => {
    const root = makeRepo(tempDir());
    await createWorkspace({ root, branch: "b" });
    writeFileSync(join(root, ".worktrees/b/scratch.txt"), "work");
    const kept = await removeWorkspace({ root, branch: "b" });
    expect(kept.ok && failure(kept.value.repos[0])?.kind).toBe("remove");
    expect(existsSync(join(root, ".worktrees/b"))).toBe(true);
    const forced = await removeWorkspace({ root, branch: "b", force: true });
    expect(forced.ok && forced.value.repos[0]?.status).toBe("removed");
    expect(existsSync(join(root, ".worktrees/b"))).toBe(false);
  });

  test("remove with a branch that resolves outside .worktrees never runs teardown", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { workspace: { teardown: 'touch "$WORKTREE_PATH/torn-down"' } });
    const result = await removeWorkspace({ root, branch: "..", force: true });
    expect(result.ok ? "" : result.error).toContain("invalid branch name");
    expect(existsSync(join(root, "torn-down"))).toBe(false);
  });

  test("remove refuses a worktree that belongs to a different branch at the same path", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { workspace: { teardown: 'touch "$PRIMARY_WORKTREE_PATH/torn-down"' } });
    await createWorkspace({ root, branch: "feat/a" });
    const result = await removeWorkspace({ root, branch: "feat-a" });
    expect(result.ok ? "" : result.error).toContain("feat/a");
    expect(existsSync(join(root, "torn-down"))).toBe(false);
    expect(existsSync(join(root, ".worktrees/feat-a"))).toBe(true);
  });

  test("removing a worktree that does not exist is an error", async () => {
    const root = makeRepo(tempDir());
    const result = await removeWorkspace({ root, branch: "nope" });
    expect(result.ok).toBe(false);
  });
});

describe("multi repo", () => {
  test("creates one worktree per repo under the workspace, each set up with its own variables", async () => {
    const root = makeMulti({});
    writeFileSync(join(root, "record.ts"), RECORD_ENV);
    writeConfig(root, {
      workspace: {
        layout: "multi",
        setup: `bun ${join(root, "record.ts")} && echo "hi $REPO_NAME"`,
      },
      packages: { serana: { path: "serana" }, courier: { path: "courier" } },
    });
    const lines: OutputLine[] = [];
    const result = await createWorkspace({
      root,
      branch: "feat/x",
      repos: ["serana", "courier"],
      onOutput: (line) => lines.push(line),
    });
    const workspace = join(root, ".workspaces/feat-x");
    expect(result.ok && result.value.workspaceDir).toBe(workspace);
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

  test("a package's own workspaceSetup beats the shared setup", async () => {
    const root = makeMulti({
      workspace: { layout: "multi", setup: "echo shared > marker" },
      packages: {
        serana: { path: "serana", commands: { workspaceSetup: "echo own > marker" } },
        courier: { path: "courier" },
      },
    });
    await createWorkspace({ root, branch: "b", repos: ["serana", "courier"] });
    const marker = (repo: string) =>
      readFileSync(join(root, ".workspaces/b", repo, "marker"), "utf8").trim();
    expect(marker("serana")).toBe("own");
    expect(marker("courier")).toBe("shared");
  });

  test("a package whose workspaceSetup is null runs no setup at all", async () => {
    const root = makeMulti({
      workspace: { layout: "multi", setup: "echo shared > marker" },
      packages: {
        serana: { path: "serana", commands: { workspaceSetup: null } },
        courier: { path: "courier" },
      },
    });
    await createWorkspace({ root, branch: "b", repos: ["serana", "courier"] });
    expect(existsSync(join(root, ".workspaces/b/serana/marker"))).toBe(false);
    expect(existsSync(join(root, ".workspaces/b/courier/marker"))).toBe(true);
  });

  test("one repo's failed setup does not stop the others", async () => {
    const root = makeMulti({
      packages: {
        serana: { path: "serana", commands: { workspaceSetup: "exit 1" } },
        courier: { path: "courier" },
      },
    });
    const result = await createWorkspace({ root, branch: "b", repos: ["serana", "courier"] });
    expect(result.ok && result.value.repos.map((r) => r.status)).toEqual(["failed", "ready"]);
    expect(existsSync(join(root, ".workspaces/b/serana"))).toBe(true);
  });

  test("remove with no repos named removes every repo's worktree and the empty workspace", async () => {
    const root = makeMulti({});
    await createWorkspace({ root, branch: "b", repos: ["serana", "courier"] });
    const result = await removeWorkspace({ root, branch: "b" });
    expect(result.ok && result.value.repos.map((r) => [r.name, r.status])).toEqual([
      ["serana", "removed"],
      ["courier", "removed"],
    ]);
    expect(existsSync(join(root, ".workspaces/b"))).toBe(false);
  });
});

describe("repo outcome details", () => {
  test("WS8 — mono repo with no origin on main: worktreeDir is workspaceDir, base is main, startSha is the worktree HEAD, nothing fetched", async () => {
    const root = makeRepo(tempDir());
    const result = await createWorkspace({ root, branch: "feat-x" });
    if (!result.ok) throw new Error(result.error);
    const [repo] = result.value.repos;
    expect(repo?.worktreeDir).toBe(result.value.workspaceDir);
    expect(ready(repo)?.baseBranch).toBe("main");
    expect(ready(repo)?.startSha).toBe(git(join(root, ".worktrees/feat-x"), "rev-parse", "HEAD"));
    expect(existsSync(join(root, ".git/FETCH_HEAD"))).toBe(false);
  });

  test("WS9 — multi layout: a package at services/api gets its worktree at that path inside the workspace", async () => {
    const root = makeRepo(tempDir(), [".workspaces/", "services/"]);
    makeRepo(join(root, "services/api"));
    writeConfig(root, {
      workspace: { layout: "multi" },
      packages: { api: { path: "services/api" } },
    });
    const result = await createWorkspace({ root, branch: "feat-x", repos: ["api"], base: "main" });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.repos[0]).toMatchObject({
      worktreeDir: join(result.value.workspaceDir, "services/api"),
      checkoutDir: join(root, "services/api"),
      baseBranch: "main",
      status: "ready",
    });
  });

  test("a setup command node cannot start fails at setup, keeping the thrown error's stack", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { workspace: { setup: "true\u0000" } });
    const result = await createWorkspace({ root, branch: "feat-x" });
    const repo = result.ok ? result.value.repos[0] : undefined;
    expect(repo?.status).toBe("failed");
    expect(failure(repo)?.kind).toBe("setup");
    expect(failure(repo)?.message).toContain("could not start");
    expect(failure(repo)).toMatchObject({ stack: expect.stringContaining("Error") });
  });

  test("a setup's long output is cut to ERROR_MESSAGE_LIMIT in the error message", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { workspace: { setup: `exit 1 # ${"x".repeat(2000)}` } });
    const result = await createWorkspace({ root, branch: "feat-x" });
    const message = result.ok ? failure(result.value.repos[0])?.message : undefined;
    expect(message?.length).toBe(ERROR_MESSAGE_LIMIT);
  });

  test("WS10 — a repo whose setup exits 1 fails at setup with no startSha", async () => {
    const root = makeRepo(tempDir());
    writeConfig(root, { workspace: { setup: "exit 1" } });
    const result = await createWorkspace({ root, branch: "feat-x" });
    const repo = result.ok ? result.value.repos[0] : undefined;
    expect(repo?.status).toBe("failed");
    expect(failure(repo)?.kind).toBe("setup");
    expect(ready(repo)?.startSha).toBeUndefined();
  });
});

type Remote = Readonly<{ origin: string; clone: string; pusher: string }>;

const makeRemote = (): Remote => {
  const dir = tempDir();
  const seed = makeRepo(join(dir, "seed"));
  const origin = join(dir, "origin.git");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(seed, "push", "-q", origin, "main");
  git(dir, "clone", "-q", origin, join(dir, "clone"));
  git(dir, "clone", "-q", origin, join(dir, "pusher"));
  return { origin, clone: join(dir, "clone"), pusher: join(dir, "pusher") };
};

const pushCommit = (remote: Remote, branch = "main"): string => {
  git(remote.pusher, "checkout", "-q", "-B", branch);
  const sha = commit(remote.pusher, `on ${branch}`);
  git(remote.pusher, "push", "-q", "origin", branch);
  return sha;
};

describe("fetching the base branch", () => {
  test("WS11 — with no base, branches from the fetched origin default branch and leaves the checkout alone", async () => {
    const remote = makeRemote();
    const localMain = git(remote.clone, "rev-parse", "main");
    git(remote.clone, "checkout", "-q", "-b", "old");
    const pushed = pushCommit(remote);
    const result = await createWorkspace({ root: remote.clone, branch: "feat-x" });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.repos[0]).toMatchObject({ baseBranch: "main", startSha: pushed });
    expect(git(remote.clone, "rev-parse", "main")).toBe(localMain);
    expect(git(remote.clone, "branch", "--show-current")).toBe("old");
    expect(git(remote.clone, "status", "--porcelain")).toBe("");
  });

  test("WS12 — base release, which exists only on origin, branches from origin/release", async () => {
    const remote = makeRemote();
    const pushed = pushCommit(remote, "release");
    const result = await createWorkspace({ root: remote.clone, branch: "feat-x", base: "release" });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.repos[0]).toMatchObject({ baseBranch: "release", startSha: pushed });
  });

  test("with no --base, branches from workspace.baseBranch instead of the origin default", async () => {
    const remote = makeRemote();
    const pushed = pushCommit(remote, "release");
    writeConfig(remote.clone, { workspace: { baseBranch: "release" } });
    const result = await createWorkspace({ root: remote.clone, branch: "feat-x" });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.repos[0]).toMatchObject({ baseBranch: "release", startSha: pushed });
  });

  test("--base wins over workspace.baseBranch", async () => {
    const remote = makeRemote();
    pushCommit(remote, "release");
    const onMain = pushCommit(remote);
    writeConfig(remote.clone, { workspace: { baseBranch: "release" } });
    const result = await createWorkspace({ root: remote.clone, branch: "feat-x", base: "main" });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.repos[0]).toMatchObject({ baseBranch: "main", startSha: onMain });
  });

  test.each([
    [
      "a branch that exists only in the clone",
      (clone: string) => {
        git(clone, "checkout", "-q", "-b", "local-only");
        const sha = commit(clone, "local only");
        git(clone, "checkout", "-q", "main");
        return { base: "local-only", sha };
      },
    ],
    [
      "a commit id",
      (clone: string) => {
        const sha = git(clone, "rev-parse", "HEAD");
        commit(clone, "after the base");
        return { base: sha, sha };
      },
    ],
  ])("with an origin, a base that is %s branches from it locally", async (_label, prepare) => {
    const remote = makeRemote();
    const { base, sha } = prepare(remote.clone);
    const result = await createWorkspace({ root: remote.clone, branch: "feat-x", base });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.repos[0]).toMatchObject({
      status: "ready",
      baseBranch: base,
      startSha: sha,
    });
  });

  test("WS13 — an origin that no longer exists fails at fetch, with no worktree and no branch made", async () => {
    const remote = makeRemote();
    git(remote.clone, "remote", "set-url", "origin", join(remote.origin, "..", "gone.git"));
    const result = await createWorkspace({ root: remote.clone, branch: "feat-x" });
    const repo = result.ok ? result.value.repos[0] : undefined;
    expect(repo?.status).toBe("failed");
    expect(failure(repo)?.kind).toBe("fetch");
    expect(existsSync(join(remote.clone, ".worktrees/feat-x"))).toBe(false);
    expect(git(remote.clone, "branch", "--list", "feat-x")).toBe("");
  });

  test("WS14 — an existing branch is checked out as is: nothing fetched, nothing reset", async () => {
    const remote = makeRemote();
    git(remote.clone, "checkout", "-q", "-b", "feat-x");
    const own = commit(remote.clone, "own work");
    git(remote.clone, "checkout", "-q", "main");
    const trackedMain = git(remote.clone, "rev-parse", "origin/main");
    pushCommit(remote);
    const result = await createWorkspace({ root: remote.clone, branch: "feat-x" });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.repos[0]).toMatchObject({ status: "ready", startSha: own });
    expect(git(join(remote.clone, ".worktrees/feat-x"), "rev-parse", "HEAD")).toBe(own);
    expect(git(remote.clone, "rev-parse", "origin/main")).toBe(trackedMain);
  });
});

describe("CreateWorkspaceInputSchema", () => {
  test("WS35 — an empty repos list is rejected: it would mean no repo at all", () => {
    expect(CreateWorkspaceInputSchema.safeParse({ specName: "feat-x", repos: [] }).success).toBe(
      false,
    );
  });

  test("WS36 — only specName is required", () => {
    expect(CreateWorkspaceInputSchema.safeParse({ specName: "feat-x" }).success).toBe(true);
  });
});

type Rejection = Readonly<{
  name: string;
  root: () => string;
  branch?: string;
  base?: string;
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
    root: withConfig({ workspace: { path: ".worktrees/{{ repo }}" } }),
    messages: ["{{ repo }}"],
  },
  {
    name: "config not matching the schema, every problem named",
    root: withConfig({ workspace: { layout: "poly", path: 3 } }),
    messages: ["workspace.layout", "workspace.path"],
  },
  {
    name: "invalid branch name",
    root: withConfig({}),
    branch: "bad..name",
    messages: ["bad..name"],
  },
  {
    name: "base that git would read as an option",
    root: withConfig({}),
    base: "--upload-pack=touch pwned",
    messages: ["--upload-pack"],
  },
  {
    name: "workspace.baseBranch that git would read as an option",
    root: withConfig({ workspace: { baseBranch: "--upload-pack=touch pwned" } }),
    messages: ["workspace.baseBranch", "--upload-pack"],
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
    name: "package workspace command in a mono repo",
    root: withConfig({ packages: { api: { path: "api", commands: { workspaceSetup: "true" } } } }),
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
        workspace: { layout: "multi" },
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
  const run = newRun();
  const result = await createWorkspace({
    run,
    root,
    branch: rejection.branch ?? "b",
    base: rejection.base,
    repos: rejection.repos,
  });
  const error = result.ok ? "" : result.error;
  for (const message of rejection.messages) expect(error).toContain(message);
  expect(existsSync(join(root, ".worktrees/b"))).toBe(createdBefore);
  expect(existsSync(join(root, ".workspaces"))).toBe(false);
  expect(await eventsOf(run)).toEqual([]);
});

const twoRepoWorkspace = async (config: Record<string, unknown> = {}): Promise<string> => {
  const root = makeMulti(config);
  const created = await createWorkspace({ root, branch: "b", repos: ["serana", "courier"] });
  if (!created.ok) throw new Error(created.error);
  return root;
};

describe("create events", () => {
  test("a create with no run makes the worktree and records no event anywhere", async () => {
    const root = makeRepo(tempDir());
    const result = await createWorkspace({ root, branch: "feat-x" });
    expect(result.ok && result.value.repos.map((repo) => repo.status)).toEqual(["ready"]);
    expect(existsSync(join(root, ".harness"))).toBe(false);
  });

  test("WS17 — a multi create of two repos records one workspace.created listing both under their repo ids", async () => {
    const root = makeMulti({
      packages: { apiServer: { path: "serana" }, courier: { path: "courier" } },
    });
    const run = newRun();
    const result = await createWorkspace({
      run,
      root,
      branch: "feat-x",
      repos: ["apiServer", "courier"],
    });
    if (!result.ok) throw new Error(result.error);
    const workspaceDir = join(root, ".workspaces/feat-x");
    expect(await eventsOf(run)).toMatchObject([
      {
        type: "workspace.created",
        source: "orchestrate",
        runId: "r-1",
        payload: {
          layout: "multi",
          branch: "feat-x",
          workspaceDir,
          repositories: {
            "api-server": {
              name: "apiServer",
              worktreeDir: join(workspaceDir, "serana"),
              checkoutDir: join(root, "serana"),
              baseBranch: "main",
              startSha: git(join(root, "serana"), "rev-parse", "HEAD"),
            },
            courier: { name: "courier", baseBranch: "main" },
          },
        },
      },
    ]);
  });

  test("WS18 — one repo's failed setup records only workspace.create-failed naming that repo, and keeps the ready repo", async () => {
    const root = makeMulti({
      packages: {
        serana: { path: "serana", commands: { workspaceSetup: "exit 1" } },
        courier: { path: "courier" },
      },
    });
    const run = newRun();
    await createWorkspace({ run, root, branch: "b", repos: ["serana", "courier"] });
    const events = await eventsOf(run);
    expect(events).toMatchObject([
      {
        type: "workspace.create-failed",
        source: "orchestrate",
        payload: {
          workspaceDir: join(root, ".workspaces/b"),
          branch: "b",
          errors: [{ repoId: "serana", kind: "setup" }],
        },
      },
    ]);
    expect(events[0]?.payload).toMatchObject({ errors: { length: 1 } });
    expect(existsSync(join(root, ".workspaces/b/courier"))).toBe(true);
  });

  test("WS19 — an existing workspace folder fails with already exists, records nothing, and changes nothing", async () => {
    const root = makeMulti({});
    mkdirSync(join(root, ".workspaces/b"), { recursive: true });
    const run = newRun();
    const result = await createWorkspace({ run, root, branch: "b", repos: ["serana"] });
    expect(result.ok ? "" : result.error).toContain("already exists");
    expect(await eventsOf(run)).toEqual([]);
    expect(git(join(root, "serana"), "worktree", "list").split("\n")).toHaveLength(1);
    expect(git(join(root, "serana"), "branch", "--list", "b")).toBe("");
  });

  test("WS38 — an event that cannot be stored still returns the report, with the store error, and leaves the worktree on disk", async () => {
    const root = makeRepo(tempDir());
    const run = newRun();
    writeFileSync(join(runDirOf(run.cwd, run.name), "event.jsonl"), "not json\n");
    const result = await createWorkspace({ run, root, branch: "feat-x" });
    if (!result.ok) throw new Error(result.error);
    expect(result.value.repos.map((repo) => repo.status)).toEqual(["ready"]);
    expect(result.value.eventError).toContain("not valid JSON");
    expect(existsSync(join(root, ".worktrees/feat-x"))).toBe(true);
  });
});

describe("addRepositories", () => {
  test("WS20 — adding courier to a workspace holding serana checks it out on the branch and records one workspace.repository.added", async () => {
    const root = makeMulti({});
    await createWorkspace({ root, branch: "b", repos: ["serana"] });
    const run = newRun();
    const result = await addRepositories({ run, root, branch: "b", repos: ["courier"] });
    if (!result.ok) throw new Error(result.error);
    const workspaceDir = join(root, ".workspaces/b");
    expect(result.value.repos).toMatchObject([{ name: "courier", status: "ready" }]);
    expect(await eventsOf(run)).toMatchObject([
      {
        type: "workspace.repository.added",
        source: "orchestrate",
        payload: {
          workspaceDir,
          branch: "b",
          repoId: "courier",
          repository: {
            name: "courier",
            worktreeDir: join(workspaceDir, "courier"),
            checkoutDir: join(root, "courier"),
            baseBranch: "main",
            startSha: git(join(root, "courier"), "rev-parse", "HEAD"),
          },
        },
      },
    ]);
    expect(git(join(workspaceDir, "courier"), "branch", "--show-current")).toBe("b");
  });

  test("WS20 — an add where one repo's setup fails records one event per repo, in order: added, then add-failed", async () => {
    const root = makeRepo(tempDir(), [".workspaces/", "serana/", "courier/", "api/"]);
    for (const name of ["serana", "courier", "api"]) makeRepo(join(root, name));
    writeConfig(root, {
      workspace: { layout: "multi" },
      packages: {
        api: { path: "api" },
        serana: { path: "serana" },
        courier: { path: "courier", commands: { workspaceSetup: "exit 1" } },
      },
    });
    await createWorkspace({ root, branch: "b", repos: ["api"] });
    const run = newRun();
    await addRepositories({ run, root, branch: "b", repos: ["serana", "courier"] });
    expect(await eventsOf(run)).toMatchObject([
      { type: "workspace.repository.added", payload: { repoId: "serana" } },
      {
        type: "workspace.repository.add-failed",
        payload: {
          repoId: "courier",
          name: "courier",
          worktreeDir: join(root, ".workspaces/b/courier"),
          checkoutDir: join(root, "courier"),
          error: { kind: "setup" },
        },
      },
    ]);
  });

  test("WS21 — with no workspace folder, add fails before touching git and records nothing", async () => {
    const root = makeMulti({});
    const run = newRun();
    const result = await addRepositories({ run, root, branch: "b", repos: ["serana", "courier"] });
    expect(result.ok ? "" : result.error).toContain("no workspace");
    expect(result.ok ? "" : result.error).toContain("create it with workspace.ts create");
    expect(await eventsOf(run)).toEqual([]);
    expect(git(join(root, "serana"), "branch", "--list", "b")).toBe("");
  });

  test("WS21 — in mono layout, add fails before touching git and records nothing", async () => {
    const root = makeRepo(tempDir());
    await createWorkspace({ root, branch: "b" });
    const run = newRun();
    const result = await addRepositories({ run, root, branch: "b", repos: ["api"] });
    expect(result.ok ? "" : result.error).toContain("multi");
    expect(await eventsOf(run)).toEqual([]);
    expect(git(root, "worktree", "list").split("\n")).toHaveLength(2);
  });
});

describe("remove events", () => {
  test("WS22 — removing courier by name records workspace.repository.removed; removing with no repos named records workspace.removed listing serana", async () => {
    const root = await twoRepoWorkspace();
    const workspaceDir = join(root, ".workspaces/b");
    const run = newRun();
    await removeWorkspace({ run, root, branch: "b", repos: ["courier"] });
    await removeWorkspace({ run, root, branch: "b" });
    expect(await eventsOf(run)).toMatchObject([
      {
        type: "workspace.repository.removed",
        source: "orchestrate",
        payload: {
          workspaceDir,
          branch: "b",
          repoId: "courier",
          name: "courier",
          worktreeDir: join(workspaceDir, "courier"),
        },
      },
      {
        type: "workspace.removed",
        source: "orchestrate",
        payload: { workspaceDir, branch: "b", repositories: ["serana"] },
      },
    ]);
  });

  test("WS23 — remove naming every repo records one workspace.repository.removed per repo, never workspace.removed", async () => {
    const root = await twoRepoWorkspace();
    const run = newRun();
    await removeWorkspace({ run, root, branch: "b", repos: ["serana", "courier"] });
    const types = (await eventsOf(run)).map((event) => event.type);
    expect(types).toEqual(["workspace.repository.removed", "workspace.repository.removed"]);
  });

  test("remove naming a repo the workspace doesn't hold is refused before any teardown, and records nothing", async () => {
    const root = makeMulti({});
    await createWorkspace({ root, branch: "b", repos: ["serana"] });
    const run = newRun();
    const result = await removeWorkspace({ run, root, branch: "b", repos: ["serana", "courier"] });
    expect(result.ok ? "" : result.error).toContain("courier");
    expect(existsSync(join(root, ".workspaces/b/serana"))).toBe(true);
    expect(await eventsOf(run)).toEqual([]);
  });

  test("WS37 — a failing teardown records repository.remove-failed for a named repo, then remove-failed naming only it for the whole workspace", async () => {
    const root = await twoRepoWorkspace({
      packages: {
        serana: { path: "serana", commands: { workspaceTeardown: "exit 1" } },
        courier: { path: "courier" },
      },
    });
    const run = newRun();
    await removeWorkspace({ run, root, branch: "b", repos: ["serana"] });
    await removeWorkspace({ run, root, branch: "b" });
    const events = await eventsOf(run);
    expect(events).toMatchObject([
      {
        type: "workspace.repository.remove-failed",
        payload: { repoId: "serana", name: "serana", error: { kind: "teardown" } },
      },
      {
        type: "workspace.remove-failed",
        payload: { errors: [{ repoId: "serana", kind: "teardown" }] },
      },
    ]);
    expect(events[1]?.payload).toMatchObject({ errors: { length: 1 } });
  });

  test("a remove refused before touching any repo records nothing", async () => {
    const root = makeMulti({});
    const run = newRun();
    const result = await removeWorkspace({ run, root, branch: "b" });
    expect(result.ok).toBe(false);
    expect(await eventsOf(run)).toEqual([]);
  });
});
