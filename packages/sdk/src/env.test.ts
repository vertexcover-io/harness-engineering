import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "./config.ts";
import { loadEnv, readProjectEnv, sessionEnv } from "./env.ts";

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "sdk-env-")));

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeRepo = (dir = tempDir()): string => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ".worktrees/\n.yok/\n");
  git(dir, "add", ".");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const addWorktree = (main: string, branch = "dev"): string => {
  const dir = join(main, ".worktrees", branch);
  git(main, "worktree", "add", "-q", "-b", branch, dir);
  return realpathSync(dir);
};

const writeConfig = (dir: string, config: object): void => {
  writeFileSync(join(dir, "orchestrate.config.json"), JSON.stringify({ version: 2, ...config }));
};

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const errorOf = (result: { ok: true } | { ok: false; error: string }): string =>
  result.ok ? "" : result.error;

describe("readProjectEnv", () => {
  const withKey = async (check: () => Promise<void>) => {
    delete process.env.PROJECT_ENV_PICK;
    await check();
  };

  test("a worktree with its own .env reads only that file, never main's", async () => {
    const main = makeRepo();
    writeFileSync(join(main, ".env"), "PROJECT_ENV_PICK=main\nPROJECT_ENV_ONLY_MAIN=1\n");
    const worktree = addWorktree(main);
    writeFileSync(join(worktree, ".env"), "PROJECT_ENV_PICK=worktree\n");

    await withKey(async () => {
      expect(await readProjectEnv(join(worktree), "PROJECT_ENV_PICK")).toBe("worktree");
      expect(await readProjectEnv(worktree, "PROJECT_ENV_ONLY_MAIN")).toBeUndefined();
    });
  });

  test("a worktree with no .env reads main's", async () => {
    const main = makeRepo();
    writeFileSync(join(main, ".env"), "PROJECT_ENV_PICK=main\n");
    const worktree = addWorktree(main);
    mkdirSync(join(worktree, "src"));

    await withKey(async () => {
      expect(await readProjectEnv(join(worktree, "src"), "PROJECT_ENV_PICK")).toBe("main");
    });
  });

  test("a sub-repo of a multi-layout meta folder reads the meta folder's .env, not its own", async () => {
    const meta = tempDir();
    writeConfig(meta, { workspace: { layout: "multi" }, packages: { api: { path: "api" } } });
    writeFileSync(join(meta, ".env"), "PROJECT_ENV_PICK=meta\n");
    const api = makeRepo(join(meta, "api"));
    writeFileSync(join(api, ".env"), "DATABASE_URL=x\n");

    await withKey(async () => {
      expect(await readProjectEnv(api, "PROJECT_ENV_PICK")).toBe("meta");
    });
  });
});

describe("readProjectEnv outside a git repo", () => {
  const withEnv = async (content: string | null, run: (root: string) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "project-env-"));
    if (content !== null) writeFileSync(join(root, ".env"), content);
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("parses plain, exported and quoted values, skipping comments and blanks", async () => {
    const content = ["# note", "", "A=1", "export B=two", 'C="three four"', "D='five'"].join("\n");
    await withEnv(content, async (root) => {
      expect(await readProjectEnv(root, "A")).toBe("1");
      expect(await readProjectEnv(root, "B")).toBe("two");
      expect(await readProjectEnv(root, "C")).toBe("three four");
      expect(await readProjectEnv(root, "D")).toBe("five");
    });
  });

  test("strips an inline comment and expands an escaped newline in a double-quoted value", async () => {
    await withEnv('E=six # note\nF="a\\nb"\n', async (root) => {
      expect(await readProjectEnv(root, "E")).toBe("six");
      expect(await readProjectEnv(root, "F")).toBe("a\nb");
    });
  });

  test("a key the file sets wins over the process environment", async () => {
    process.env.PROJECT_ENV_TEST_KEY = "from-process";
    await withEnv("PROJECT_ENV_TEST_KEY=from-file\n", async (root) => {
      expect(await readProjectEnv(root, "PROJECT_ENV_TEST_KEY")).toBe("from-file");
    });
    delete process.env.PROJECT_ENV_TEST_KEY;
  });

  test("a key the file lacks, or a missing file, falls back to the process environment", async () => {
    process.env.PROJECT_ENV_TEST_KEY = "from-process";
    await withEnv("OTHER=1\n", async (root) => {
      expect(await readProjectEnv(root, "PROJECT_ENV_TEST_KEY")).toBe("from-process");
    });
    await withEnv(null, async (root) => {
      expect(await readProjectEnv(root, "PROJECT_ENV_TEST_KEY")).toBe("from-process");
      expect(await readProjectEnv(root, "PROJECT_ENV_TEST_ABSENT")).toBeUndefined();
    });
    delete process.env.PROJECT_ENV_TEST_KEY;
  });
});

describe("loadEnv", () => {
  const checkout = (root: string, config: object) => ({
    config: ConfigSchema.parse({ version: 2, ...config }),
    path: null,
    root,
  });

  test("layers the project's .env, the config's envFile and env, then the workflow's envFile and env", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".env"), "A=dotenv\nB=dotenv\nC=dotenv\nD=dotenv\nE=dotenv\n");
    const configDir = tempDir();
    writeFileSync(join(configDir, "config.env"), "B=configFile\nC=configFile\n");
    mkdirSync(join(repo, "env"));
    writeFileSync(join(repo, "env", "workflow.env"), "D=workflowFile\nE=workflowFile\n");
    const config = checkout(configDir, { envFile: "config.env", env: { C: "config" } });

    const env = await loadEnv(
      config,
      {
        agent: "claude",
        envFile: "env/workflow.env",
        env: { E: "workflow" },
      },
      repo,
    );

    expect(unwrap(env)).toEqual({
      A: "dotenv",
      B: "configFile",
      C: "config",
      D: "workflowFile",
      E: "workflow",
    });
  });

  test("a project with no .env and no envFile gives only the declared env", async () => {
    const repo = makeRepo();
    expect(
      unwrap(await loadEnv(checkout(repo, {}), { agent: "claude", env: { X: "1" } }, repo)),
    ).toEqual({
      X: "1",
    });
  });

  test("a claude run keeps the variables Claude reads itself out of every env file, but not out of env", async () => {
    const repo = makeRepo();
    const own =
      "ANTHROPIC_API_KEY=app\nANTHROPIC_BASE_URL=http://gateway\nCLAUDE_CODE_USE_BEDROCK=1\nNODE_OPTIONS=--require x\n";
    writeFileSync(join(repo, ".env"), `${own}OPENAI_API_KEY=app\nAPP=1\n`);
    writeFileSync(join(repo, "flow.env"), own);
    const config = checkout(repo, { envFile: "flow.env" });

    const env = await loadEnv(
      config,
      {
        agent: "claude",
        envFile: "flow.env",
        env: { ANTHROPIC_BASE_URL: "http://chosen" },
      },
      repo,
    );

    expect(unwrap(env)).toEqual({
      APP: "1",
      OPENAI_API_KEY: "app",
      ANTHROPIC_BASE_URL: "http://chosen",
    });
  });

  test("a codex run keeps OpenAI and Codex variables out of the project's .env, and Anthropic ones in", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".env"), "OPENAI_BASE_URL=x\nCODEX_HOME=x\nANTHROPIC_API_KEY=app\n");

    const env = await loadEnv(checkout(repo, {}), { agent: "codex", env: {} }, repo);

    expect(unwrap(env)).toEqual({ ANTHROPIC_API_KEY: "app" });
  });

  test("an absolute envFile is read from where it points", async () => {
    const repo = makeRepo();
    const file = join(tempDir(), "abs.env");
    writeFileSync(file, "FROM_ABSOLUTE=1\n");
    const env = await loadEnv(
      checkout(repo, {}),
      { agent: "claude", env: {}, envFile: file },
      repo,
    );
    expect(unwrap(env)).toEqual({ FROM_ABSOLUTE: "1" });
  });

  test("an envFile that is a folder fails with a Result instead of throwing", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "env"));
    const env = await loadEnv(
      checkout(repo, {}),
      {
        agent: "claude",
        env: {},
        envFile: "env",
      },
      repo,
    );
    expect(errorOf(env)).toContain(join(repo, "env"));
  });

  test.each([
    ["the config's", { envFile: "missing.env" }, {}],
    ["the workflow's", {}, { envFile: "missing.env" }],
  ])(
    "an envFile %s that does not exist fails, naming the file",
    async (_label, config, workflow) => {
      const repo = makeRepo();
      const env = await loadEnv(
        checkout(repo, config),
        {
          agent: "claude",
          env: {},
          ...workflow,
        },
        repo,
      );
      expect(errorOf(env)).toContain(join(repo, "missing.env"));
    },
  );
});

describe("sessionEnv", () => {
  test("SC2: a session starts with YOK_RUN_ID and YOK_HOME over the run's env, and no variable of the old name", () => {
    const env = sessionEnv({ A: "1", PATH: "/run/bin" }, "run-1", "/h", "/h/shims/abc");
    expect(env).toEqual({
      A: "1",
      PATH: "/h/shims/abc:/run/bin",
      YOK_RUN_ID: "run-1",
      YOK_HOME: "/h",
    });
    const oldPrefix = `${["HAR", "NESS"].join("")}_`;
    expect(Object.keys(env).filter((key) => key.startsWith(oldPrefix))).toEqual([]);
  });

  test("SC62: the shim folder goes first on the run's PATH, or the caller's PATH when the run has none, and a run's env cannot override YOK_RUN_ID", () => {
    const env = sessionEnv(
      { PATH: "/run/bin", YOK_RUN_ID: "stale", FOO: "1" },
      "run-1",
      "/h",
      "/h/shims/abc",
    );
    expect(env.PATH).toBe("/h/shims/abc:/run/bin");
    expect(env.YOK_RUN_ID).toBe("run-1");
    expect(env.YOK_HOME).toBe("/h");
    expect(env.FOO).toBe("1");
    expect(sessionEnv({}, "run-1", "/h", "/h/shims/abc").PATH).toBe(
      `/h/shims/abc:${process.env.PATH}`,
    );
  });
});
