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
const CLI = join(import.meta.dir, "index.ts");
const FAKE_AGENT = join(import.meta.dir, "..", "..", "server", "src", "fixtures", "fake-agent.ts");

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
  writeFileSync(join(dir, "orchestrate.config.json"), "{}\n");
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
  const run = spawnSync("bun", [CLI, ...args], { cwd, env, encoding: "utf8" });
  return { code: run.status ?? 1, stdout: run.stdout, stderr: run.stderr };
};

const spawnHarness = (
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolvePromise) => {
    const child = spawn("bun", [CLI, ...args], { cwd, env });
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

const waitFor = (predicate: () => boolean, timeoutMs = 5000): void => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    Bun.sleepSync(50);
  }
};

describe("harness run", () => {
  test(
    "SC12: starts a server, launches the fake agent, and server status shows a pid",
    () => {
      const repo = makeRepo();
      const { env, fakeOut } = makeEnv();

      const run = harness(repo, env, "run", "ok.yaml", "--prompt", "hi");
      expect(run.code).toBe(0);
      const [runId, attach] = run.stdout.trim().split("\n");
      expect(runId).toMatch(/^r-[0-9a-f]{8}$/);
      expect(attach).toContain("attach-session");

      const status = harness(repo, env, "server", "status");
      expect(status.code).toBe(0);
      expect(status.stdout).toMatch(/^pid \d+/);

      waitFor(() =>
        readLines(fakeOut).some(
          (record) => Array.isArray(record.argv) && record.argv.includes("--session-id"),
        ),
      );
      const record = readLines(fakeOut).find(
        (line) => Array.isArray(line.argv) && line.argv.includes("--session-id"),
      );
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
    "SC13: a cyclic workflow fails to compile and records no run",
    () => {
      const repo = makeRepo();
      const { env, home } = makeEnv();

      const run = harness(repo, env, "run", "bad.yaml", "--prompt", "x");
      expect(run.code).toBe(1);
      expect(run.stderr.toLowerCase()).toContain("cycle");
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

describe("harness init / link-session", () => {
  test(
    "SC23: init with HARNESS_RUN_ID prints { runId, dir } and writes state.json under it",
    () => {
      const repo = makeRepo();
      const { env } = makeEnv();

      const run = harness(repo, env, "run", "ok.yaml", "--prompt", "hi");
      expect(run.code).toBe(0);
      const [runId] = run.stdout.trim().split("\n");
      if (runId === undefined) throw new Error("run did not print a run id");

      const init = harness(repo, { ...env, HARNESS_RUN_ID: runId }, "init", "fix-login");
      expect(init.code).toBe(0);
      const printed = JSON.parse(init.stdout.trim()) as { runId: string; dir: string };
      expect(printed.runId).toBe(runId);
      expect(existsSync(join(printed.dir, "state.json"))).toBe(true);

      stopServer(repo, env);
    },
    TIMEOUT_MS,
  );

  test(
    "SC24: init and link-session with no --run-id and no HARNESS_RUN_ID both exit 1 with the no-run message",
    () => {
      const repo = makeRepo();
      const { env } = makeEnv();
      const envWithoutRunId = { ...env, HARNESS_RUN_ID: undefined };

      const init = harness(repo, envWithoutRunId, "init", "n");
      expect(init.code).toBe(1);
      expect(init.stderr.trim()).toBe("no run: pass --run-id or run inside a harness session");

      const link = harness(repo, envWithoutRunId, "link-session", "s", "--agent", "claude");
      expect(link.code).toBe(1);
      expect(link.stderr.trim()).toBe("no run: pass --run-id or run inside a harness session");
    },
    TIMEOUT_MS,
  );
});
