import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoctorJsonSchema } from "@harness/core";

const TIMEOUT_MS = 40_000;
// Bun would load the repo's .env into the CLI, and from there the server and tmux, by itself.
const NO_DOTENV = "--env-file=/dev/null";

const CLI = join(import.meta.dir, "index.ts");
const FAKE_AGENT = join(
  import.meta.dir,
  "..",
  "..",
  "core",
  "src",
  "agents",
  "fixtures",
  "fake-agent.ts",
);
const ORCHESTRATE = join(import.meta.dir, "..", "..", "core", "src", "orchestrate.ts");

const OK_WORKFLOW = [
  "name: ok",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "",
].join("\n");

const CYCLE_WORKFLOW = [
  "name: bad",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "    dependsOn: [b]",
  "  - id: b",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "    dependsOn: [a]",
  "",
].join("\n");

const makeRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "harness-run-e2e-repo-")));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ".harness/\n");
  writeFileSync(join(dir, "orchestrate.config.json"), '{ "version": 2 }\n');
  writeFileSync(join(dir, "ok.yaml"), OK_WORKFLOW);
  writeFileSync(join(dir, "bad.yaml"), CYCLE_WORKFLOW);
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

// A server started by ensureServer runs with its cwd set to HARNESS_HOME.
const serverPids = (home: string): readonly number[] =>
  spawnSync("lsof", ["-t", "-a", "-d", "cwd", "+d", home], { encoding: "utf8" })
    .stdout.split("\n")
    .filter((line) => line !== "")
    .map(Number)
    .filter((pid) =>
      spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.includes(
        "server start",
      ),
    );

type TestEnv = Readonly<{ home: string; socket: string; fakeOut: string; env: NodeJS.ProcessEnv }>;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const makeEnv = (): TestEnv => {
  const home = mkdtempSync(join(tmpdir(), "harness-run-e2e-home-"));
  const socket = `harness-e2e-${randomUUID()}`;
  const fakeOut = join(mkdtempSync(join(tmpdir(), "harness-run-e2e-out-")), "out.jsonl");
  cleanups.push(() => {
    for (const pid of serverPids(home)) process.kill(pid, "SIGKILL");
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    rmSync(home, { recursive: true, force: true });
  });
  return {
    home,
    socket,
    fakeOut,
    env: {
      ...process.env,
      HARNESS_HOME: home,
      HARNESS_TMUX_SOCKET: socket,
      HARNESS_CLAUDE_BIN: FAKE_AGENT,
      FAKE_AGENT_OUT: fakeOut,
    },
  };
};

const harness = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): { code: number; stdout: string; stderr: string } => {
  const run = spawnSync("bun", [NO_DOTENV, CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
};

const spawnHarness = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    const child = spawn("bun", [NO_DOTENV, CLI, ...args], { cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
  });

const stopServer = (cwd: string, env: NodeJS.ProcessEnv): void => {
  harness(cwd, env, "server", "stop");
};

const readLines = (path: string): Array<Record<string, unknown>> =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    : [];

// The doctor runs the fake agent with --version; the launch is the call that carries the hooks.
const isLaunch = (record: Record<string, unknown>): boolean =>
  Array.isArray(record.argv) && record.argv.includes("--settings");

const waitFor = (predicate: () => boolean, timeoutMs = 5000): void => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    Bun.sleepSync(50);
  }
};

describe("harness run", () => {
  test(
    "a supplied --name reaches the launched agent without replacing the prompt input",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();

      const result = harness(
        repo,
        env,
        "run",
        "ok.yaml",
        "--prompt",
        "different",
        "--name",
        "fix-login",
      );
      expect(result.code).toBe(0);
      const isSession = (record: Record<string, unknown>) => isLaunch(record);
      waitFor(() => readLines(fakeOut).some(isSession));
      const launch = readLines(fakeOut).find(isSession);
      const argv = launch?.argv;
      const prompt = Array.isArray(argv) ? argv.at(-1) : undefined;
      expect(prompt).toContain('--inputs {"prompt":"different"} --name fix-login');

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "a workflow tier launches the session on the model the checkout's config maps it to",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      writeFileSync(
        join(repo, "orchestrate.config.json"),
        JSON.stringify({ version: 2, agents: { claude: { tiers: { deep: { model: "opus" } } } } }),
      );
      writeFileSync(join(repo, "deep.yaml"), `tier: deep\n${OK_WORKFLOW}`);

      expect(harness(repo, env, "run", "deep.yaml", "--prompt", "hi", "--no-open").code).toBe(0);
      waitFor(() => readLines(fakeOut).some(isLaunch));
      const argv = readLines(fakeOut).find(isLaunch)?.argv;
      const args = Array.isArray(argv) ? argv.map(String) : [];

      expect(args[args.indexOf("--model") + 1]).toBe("opus");

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "the agent session starts with the .env, config env and workflow env and envFile values",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      writeFileSync(join(repo, ".env"), "E2E_DOTENV=dotenv\nE2E_SHARED=dotenv\n");
      writeFileSync(
        join(repo, "orchestrate.config.json"),
        JSON.stringify({ version: 2, env: { E2E_CONFIG: "config", E2E_SHARED: "config" } }),
      );
      writeFileSync(join(repo, "flow.env"), "E2E_FLOW_FILE=file\n");
      writeFileSync(
        join(repo, "env.yaml"),
        `envFile: flow.env\nenv:\n  E2E_SHARED: workflow\n${OK_WORKFLOW}`,
      );

      expect(harness(repo, env, "run", "env.yaml", "--prompt", "hi", "--no-open").code).toBe(0);
      waitFor(() => readLines(fakeOut).some(isLaunch));
      const launched = readLines(fakeOut).find(isLaunch)?.env as Record<string, string>;

      expect(launched).toMatchObject({
        E2E_DOTENV: "dotenv",
        E2E_CONFIG: "config",
        E2E_FLOW_FILE: "file",
        E2E_SHARED: "workflow",
      });

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "a workflow tier the config does not map for the agent fails the run before any session starts",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      writeFileSync(join(repo, "deep.yaml"), `tier: deep\n${OK_WORKFLOW}`);

      const result = harness(repo, env, "run", "deep.yaml", "--prompt", "hi", "--no-open");

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("agents.claude.tiers.deep");
      expect(readLines(fakeOut).some(isLaunch)).toBe(false);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "a run the doctor blocks prints why each failing check failed",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();
      writeFileSync(
        join(repo, "orchestrate.config.json"),
        JSON.stringify({ version: 2, tiers: { deep: { agent: "claude", model: "opus" } } }),
      );

      const result = harness(repo, env, "run", "ok.yaml", "--prompt", "hi", "--no-open");

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("BLOCKED orchestrate-config");
      expect(result.stderr).toContain("orchestrate-config: ");
      expect(result.stderr).toContain('Unrecognized key: "tiers"');
      expect(readLines(fakeOut).some(isLaunch)).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "SC23: the agent the server launched can init its run with orchestrate, using only its own environment",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();

      const run = harness(repo, env, "run", "ok.yaml", "--prompt", "hi");
      expect(run.code).toBe(0);
      const isSession = (record: Record<string, unknown>) => isLaunch(record);
      waitFor(() => readLines(fakeOut).some(isSession));
      const launch = readLines(fakeOut).find(isSession);
      const agentEnv = launch?.env as NodeJS.ProcessEnv;

      const init = spawnSync("bun", [ORCHESTRATE, "init", "fix-login"], {
        cwd: String(launch?.cwd),
        env: agentEnv,
        encoding: "utf8",
      });

      expect(init.status).toBe(0);
      expect(existsSync(join(repo, ".harness", "fix-login", "state.json"))).toBe(true);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC26 — the session harness run launches carries the Stop hook",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();

      expect(harness(repo, env, "run", "ok.yaml", "--prompt", "hi").code).toBe(0);
      const isSession = (record: Record<string, unknown>) => isLaunch(record);
      waitFor(() => readLines(fakeOut).some(isSession));
      const argv = readLines(fakeOut).find(isSession)?.argv;
      const args = Array.isArray(argv) ? argv.map(String) : [];
      const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");

      expect(settings.hooks.Stop[0].hooks[0].command).toContain(
        "packages/core/src/orchestrate.ts' 'hook' 'stop' '--agent' 'claude'",
      );

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC18 — the session harness run launches carries the PreToolUse hook",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();

      expect(harness(repo, env, "run", "ok.yaml", "--prompt", "hi").code).toBe(0);
      const isSession = (record: Record<string, unknown>) => isLaunch(record);
      waitFor(() => readLines(fakeOut).some(isSession));
      const argv = readLines(fakeOut).find(isSession)?.argv;
      const args = Array.isArray(argv) ? argv.map(String) : [];
      const settings = JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}");

      expect(settings.hooks.PreToolUse[0].matcher).toBe("Write|Edit|MultiEdit|NotebookEdit|Bash");
      expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain(
        "packages/core/src/orchestrate.ts' 'hook' 'pre-tool-use' '--agent' 'claude'",
      );

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC6: the run starts with no session, its terminal is the launched tmux name, and a SessionStart hook call links the session",
    () => {
      const repo = makeRepo();
      const { env, fakeOut, home, socket } = makeEnv();

      const run = harness(repo, env, "run", "ok.yaml", "--prompt", "hi");
      expect(run.code).toBe(0);
      const runId = run.stdout.trim().split("\n")[0] ?? "";
      waitFor(() => readLines(fakeOut).some((record) => isLaunch(record)));
      const launch = readLines(fakeOut).find((record) => isLaunch(record));
      expect(launch?.argv).not.toContain("--session-id");

      const registryFile = join(home, "registry.json");
      const saved = () => JSON.parse(readFileSync(registryFile, "utf8")).runs[runId];
      expect(saved().sessions).toEqual([]);
      const tmuxNames = spawnSync(
        "tmux",
        ["-L", socket, "list-sessions", "-F", "#{session_name}"],
        {
          encoding: "utf8",
        },
      ).stdout.split("\n");
      expect(tmuxNames).toContain(saved().terminal);

      const hook = spawnSync(
        "bun",
        [ORCHESTRATE, "hook", "session-start", "--agent", "claude", "--handler", "link-session"],
        {
          cwd: String(launch?.cwd),
          env: launch?.env as NodeJS.ProcessEnv,
          input: JSON.stringify({ session_id: "claude-chose-this", source: "startup", cwd: repo }),
          encoding: "utf8",
        },
      );
      expect(hook.status).toBe(0);
      expect(saved().sessions).toEqual([{ agent: "claude", sessionId: "claude-chose-this" }]);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC12: starts a server, launches the fake agent, and server status shows a pid",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();

      const run = harness(repo, env, "run", "ok.yaml", "--prompt", "hi");
      expect(run.code).toBe(0);
      const [runId, attach] = run.stdout.trim().split("\n");
      expect(runId).toMatch(/^r-[0-9a-f]{8}$/);
      expect(attach).toBe(`harness attach --run-id ${runId}`);

      const status = harness(repo, env, "server", "status");
      expect(status.code).toBe(0);
      expect(status.stdout).toMatch(/^pid \d+/);

      waitFor(() => readLines(fakeOut).some((record) => isLaunch(record)));
      const record = readLines(fakeOut).find(isLaunch);
      const argv = record?.argv as string[] | undefined;
      expect(argv?.at(-1)).toContain(`/orchestrate-v2 --workflow ${join(repo, "ok.yaml")}`);
      expect(record?.runId).toBe(runId);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "at LOG_LEVEL=debug, run logs its run id, and each request's reqId matches server.log",
    () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();

      const run = harness(repo, { ...env, LOG_LEVEL: "debug" }, "run", "ok.yaml", "--prompt", "hi");
      expect(run.code).toBe(0);
      const runId = run.stdout.trim().split("\n")[0];
      const cliLines = run.stderr
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(cliLines).toContainEqual(
        expect.objectContaining({ component: "cli", command: "run", msg: "run started", runId }),
      );
      const post = cliLines.find(
        (line) => line.msg === "server request finished" && line.path === "/runs",
      );
      expect(typeof post?.reqId).toBe("string");
      expect(readFileSync(join(home, "server.log"), "utf8")).toContain(`"reqId":"${post?.reqId}"`);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "a workflow's env check for an unset key blocks the run before any agent launches",
    () => {
      const repo = makeRepo();
      const { env, home, fakeOut } = makeEnv();
      const doctor = [
        "doctor:",
        "  - check: env",
        "    key: HARNESS_E2E_UNSET_KEY",
        "    fix: Set HARNESS_E2E_UNSET_KEY in .env",
      ];
      writeFileSync(join(repo, "needs-key.yaml"), [...doctor, OK_WORKFLOW].join("\n"));
      const { HARNESS_E2E_UNSET_KEY: _, ...withoutKey } = env;

      const run = harness(repo, withoutKey, "run", "needs-key.yaml", "--prompt", "x");
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("BLOCKED env:HARNESS_E2E_UNSET_KEY");
      const launches = readLines(fakeOut).filter((record) => isLaunch(record));
      expect(launches).toEqual([]);
      expect(existsSync(join(home, "registry.json"))).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "--config FILE, resolved against the current folder, is saved on the run and recorded by init, even with no config in the repo",
    () => {
      const repo = makeRepo();
      rmSync(join(repo, "orchestrate.config.json"));
      mkdirSync(join(repo, "configs"));
      const file = join(repo, "configs", "custom.json");
      writeFileSync(file, '{ "version": 2 }\n');
      const { env, home, fakeOut } = makeEnv();

      const run = harness(
        join(repo, "configs"),
        env,
        "run",
        "../ok.yaml",
        "--prompt",
        "hi",
        "--config",
        "custom.json",
      );
      expect(run.stderr).not.toContain("BLOCKED");
      expect(run.code).toBe(0);
      const runId = run.stdout.trim().split("\n")[0] ?? "";
      const registry = JSON.parse(readFileSync(join(home, "registry.json"), "utf8"));
      expect(registry.runs[runId].config).toBe(file);
      waitFor(() => readLines(fakeOut).some(isLaunch));
      const launch = readLines(fakeOut).find(isLaunch);
      const init = spawnSync("bun", [ORCHESTRATE, "init", "fix-login"], {
        cwd: String(launch?.cwd),
        env: launch?.env as NodeJS.ProcessEnv,
        encoding: "utf8",
      });
      expect(init.status).toBe(0);
      const state = JSON.parse(
        readFileSync(join(repo, ".harness", "fix-login", "state.json"), "utf8"),
      );
      expect(state.config).toEqual({ path: file, root: join(repo, "configs") });

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test.each([
    ["a missing file", (_file: string) => {}],
    ["an invalid file", (file: string) => writeFileSync(file, "{")],
    ["a directory", (file: string) => mkdirSync(file)],
  ])(
    "--config naming %s stops harness run before any run or session starts",
    (_case, create) => {
      const repo = makeRepo();
      const file = join(repo, "custom.json");
      create(file);
      const { env, home, fakeOut } = makeEnv();

      const run = harness(repo, env, "run", "ok.yaml", "--prompt", "x", "--config", "custom.json");

      expect(run.code).toBe(1);
      expect(run.stderr).toContain(file);
      expect(readLines(fakeOut)).toEqual([]);
      expect(existsSync(join(home, "registry.json"))).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "SC13: a cyclic workflow fails to compile and records no run",
    () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();

      const run = harness(repo, env, "run", "bad.yaml", "--prompt", "x");
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("cycle: dependency cycle among");
      expect(existsSync(join(home, "registry.json"))).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "an error shows only its message, and its stack only when LOG_LEVEL=debug",
    () => {
      const repo = makeRepo();
      const { env } = makeEnv();

      const plain = harness(repo, { ...env, LOG_LEVEL: "" }, "run", "bad.yaml", "--prompt", "x");
      expect(plain.stderr).toContain("dependency cycle");
      expect(plain.stderr).not.toContain("    at ");

      const debug = harness(
        repo,
        { ...env, LOG_LEVEL: "debug" },
        "run",
        "bad.yaml",
        "--prompt",
        "x",
      );
      expect(debug.stderr).toContain("    at ");
      expect(debug.stderr).toContain("compile.ts");
    },
    TIMEOUT_MS,
  );

  test(
    "SC14: a stale socket file with no server behind it still lets run succeed",
    () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "harness.sock"), "");

      const run = harness(repo, env, "run", "ok.yaml", "--prompt", "x");
      expect(run.code).toBe(0);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC15: two runs started together succeed with different ids and one server",
    async () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();

      const [a, b] = await Promise.all([
        spawnHarness(repo, env, ["run", "ok.yaml", "--prompt", "x"]),
        spawnHarness(repo, env, ["run", "ok.yaml", "--prompt", "x"]),
      ]);
      expect(a.code).toBe(0);
      expect(b.code).toBe(0);
      const idA = a.stdout.trim().split("\n")[0];
      const idB = b.stdout.trim().split("\n")[0];
      expect(idA).not.toBe(idB);

      const registry = JSON.parse(readFileSync(join(home, "registry.json"), "utf8")) as {
        runs: Record<string, unknown>;
      };
      expect(Object.keys(registry.runs).sort()).toEqual(
        [idA, idB].filter((id) => id !== undefined).sort(),
      );
      expect(serverPids(home)).toHaveLength(1);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC16: server stop removes the socket and pid file but the run's tmux session stays alive",
    () => {
      const repo = makeRepo();
      const { env, home, socket } = makeEnv();

      const run = harness(repo, env, "run", "ok.yaml", "--prompt", "x");
      expect(run.code).toBe(0);

      const stop = harness(repo, env, "server", "stop");
      expect(stop.code).toBe(0);
      expect(existsSync(join(home, "harness.sock"))).toBe(false);
      expect(existsSync(join(home, "server.pid"))).toBe(false);

      const sessions = spawnSync("tmux", ["-L", socket, "list-sessions", "-F", "#{session_name}"], {
        encoding: "utf8",
      });
      expect(sessions.stdout.trim().length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  test(
    "SC17: doctor --json rows include tmux and claude",
    () => {
      const repo = makeRepo();
      const { env } = makeEnv();

      const result = harness(repo, env, "doctor", "--json");
      const json = DoctorJsonSchema.parse(JSON.parse(result.stdout));
      const names = json.results.map((row) => row.name);
      expect(names).toContain("tmux");
      expect(names).toContain("claude");
    },
    TIMEOUT_MS,
  );
});
