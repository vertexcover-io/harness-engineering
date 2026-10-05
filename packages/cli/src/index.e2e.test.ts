import { beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoctorJsonSchema } from "@yok/core";
import { spawn as spawnProcess } from "@yok/sdk";
import { VERSION } from "@yok/sdk/internal";
import sdkPackage from "../../sdk/package.json";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO_ROOT, "node_modules", ".bin", "yok-dev");
const CLI = join(REPO_ROOT, "packages", "cli", "src", "index.ts");

const runBin = (args: readonly string[]): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(BIN, [...args], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });

describe("yok doctor (installed bin)", () => {
  test("SC11: prints ENVIRONMENT, a header row, a git row and a VERDICT line, exiting per the verdict", async () => {
    const { code, stdout } = await runBin(["doctor"]);
    expect(stdout.startsWith("ENVIRONMENT")).toBe(true);
    expect(stdout).toMatch(/CHECK\s+REQUIRED\s+STATUS\s+DETAIL\s+FIX/);
    expect(stdout).toMatch(/^git\s/m);
    const verdictLine = stdout.split("\n").find((line) => /^(READY|DEGRADED|BLOCKED)/.test(line));
    expect(verdictLine).toBeDefined();
    expect(code).toBe(verdictLine?.startsWith("BLOCKED") ? 1 : 0);
  }, 40_000);

  test("SC12: yok-dev doctor --json prints a report that parses against DoctorJsonSchema, exiting per the verdict", async () => {
    const { code, stdout } = await runBin(["doctor", "--json"]);
    const json = DoctorJsonSchema.parse(JSON.parse(stdout));
    expect(json.results.map((row) => row.name)).toContain("git");
    expect(code).toBe(json.verdict.startsWith("BLOCKED") ? 1 : 0);
  }, 40_000);
});

// A request `orchestrate run-hook call` accepts on stdin: one module hook and a minimal valid input.
const callRequest = (module: string, handler: string) => ({
  hook: { name: "probe", blocking: true, timeoutSeconds: 10, module, handler },
  input: {
    event: {
      schemaVersion: 1,
      seq: 1,
      id: "evt-1",
      ts: "2026-10-03T10:00:00Z",
      type: "custom.demo.ping",
      source: "test",
      runId: "r-1",
      payload: null,
    },
    state: {
      schemaVersion: 1,
      lastEventSeq: 1,
      runId: "r-1",
      runName: "demo",
      runDir: "/work/.yok/demo",
      version: "2.0.0",
      workflow: { name: "demo", path: "workflow.yaml" },
      input: {},
      scope: null,
      startedAt: "2026-10-03T10:00:00Z",
      completedAt: null,
      status: "running",
      workspace: {
        type: "mono",
        path: "/work",
        repositories: {
          app: { path: "/work", git: { branch: "b", baseBranch: "main", startSha: "a" } },
        },
      },
      nodeRuns: {},
      activeSessions: [],
      eventHandlers: {},
      hooks: {},
    },
    run: { id: "r-1", cwd: "/work", name: "demo" },
  },
});

const HOOKS = `
export const leak = () => process.env.YOK_LEAK ?? "unset";
export const self = () => process.env.YOK_SELF;
`;

describe("yok as one program", () => {
  let repo = "";
  let hooks = "";
  beforeAll(async () => {
    repo = await realpath(await mkdtemp(join(tmpdir(), "yok-self-")));
    hooks = join(repo, "hooks.ts");
    await writeFile(hooks, HOOKS);
    await writeFile(join(repo, ".env"), "YOK_LEAK=1\n");
  });

  const callHookAt = async (
    argv: readonly [string, ...string[]],
    handler: string,
    env: Readonly<Record<string, string>> = {},
  ) => {
    const [program, ...args] = argv;
    const input = JSON.stringify(callRequest(hooks, handler));
    return await spawnProcess(program, [...args, "orchestrate", "run-hook", "call"], {
      cwd: repo,
      env,
      input,
      timeoutMs: 20_000,
    });
  };

  test("SC29: yok --version prints the sdk's package.json version and exits 0", async () => {
    const result = await spawnProcess(process.execPath, ["--no-env-file", CLI, "--version"], {
      cwd: REPO_ROOT,
    });
    expect([result.code, result.stdout.trim()]).toEqual([0, sdkPackage.version]);
    expect(VERSION).toBe(sdkPackage.version);
  }, 20_000);

  test("SC30: yok orchestrate --help lists the skill actions and hides run-hook, which still runs", async () => {
    const help = await spawnProcess(
      process.execPath,
      ["--no-env-file", CLI, "orchestrate", "--help"],
      {
        cwd: REPO_ROOT,
      },
    );
    const listed = [...help.stdout.matchAll(/^ {2}([a-z-]+)/gm)].map((match) => match[1]);
    expect(listed).toEqual(
      expect.arrayContaining([
        "init",
        "link-session",
        "emit",
        "next",
        "exec",
        "done",
        "node",
        "skill",
        "hook",
        "statusline",
        "context",
        "limit-wait",
        "comments",
      ]),
    );
    expect(help.stdout).not.toContain("run-hook");
    const called = await callHookAt([process.execPath, "--no-env-file", CLI], "leak");
    expect([called.code, called.stdout]).toEqual([0, JSON.stringify("unset")]);
  }, 30_000);

  test("SC32: a self-call or the yok-dev shebang started in a repo with a .env does not load it", async () => {
    const self = JSON.parse(process.env.YOK_SELF ?? "[]");
    const viaSelf = await callHookAt(self, "leak");
    const viaShebang = await callHookAt([BIN], "leak");
    const version = await spawnProcess(BIN, ["--version"], { cwd: repo });
    expect([viaSelf.stdout, viaShebang.stdout]).toEqual([
      JSON.stringify("unset"),
      JSON.stringify("unset"),
    ]);
    expect(version.stdout.trim()).toBe(VERSION);
  }, 30_000);

  test("SC33: a process the CLI starts from source sees YOK_SELF naming the CLI, not the stale value its parent set", async () => {
    const result = await callHookAt([process.execPath, "--no-env-file", CLI], "self", {
      YOK_SELF: JSON.stringify(["/stale"]),
    });
    expect(JSON.parse(JSON.parse(result.stdout))).toEqual([process.execPath, "--no-env-file", CLI]);
  }, 20_000);
});
