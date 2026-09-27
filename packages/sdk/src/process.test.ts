import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  execWithTimeout,
  killRunning,
  NOT_FOUND,
  spawn,
  spawnDetached,
  spawnInteractive,
} from "./process.ts";

const cwd = process.cwd();

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitFor = async (check: () => Promise<boolean> | boolean): Promise<boolean> => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await check()) return true;
    await sleep(25);
  }
  return false;
};

const readPid = async (pidFile: string): Promise<number> => {
  await waitFor(async () => (await readFile(pidFile, "utf8").catch(() => "")).trim() !== "");
  return Number((await readFile(pidFile, "utf8")).trim());
};

const backgroundSleep = async (): Promise<{ dir: string; pidFile: string; script: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "spawn-"));
  const pidFile = join(dir, "pid");
  return { dir, pidFile, script: `sleep 30 & echo $! > ${pidFile}; wait` };
};

describe("spawn", () => {
  test("returns the exit code, stdout and stderr", async () => {
    expect(await spawn("sh", ["-c", "echo out; echo err >&2; exit 2"], { cwd })).toEqual({
      code: 2,
      stdout: "out\n",
      stderr: "err\n",
      stopped: null,
    });
  });

  test("a missing binary returns code 127", async () => {
    expect(await spawn("no-such-binary-xyz", [], { cwd })).toMatchObject({ code: NOT_FOUND });
  });

  test("onStdout and onStderr get whole lines, even when a line arrives in two chunks", async () => {
    const out: string[] = [];
    const err: string[] = [];
    await spawn("sh", ["-c", "printf 'a\\nb'; sleep 0.1; printf 'c\\n'; echo oops >&2"], {
      cwd,
      onStdout: (line) => out.push(line),
      onStderr: (line) => err.push(line),
    });
    expect(out).toEqual(["a", "bc"]);
    expect(err).toEqual(["oops"]);
  });

  test("a last line with no newline still reaches the callback", async () => {
    const out: string[] = [];
    await spawn("printf", ["tail"], { cwd, onStdout: (line) => out.push(line) });
    expect(out).toEqual(["tail"]);
  });

  test("env adds to the parent's environment, and undefined removes a variable", async () => {
    process.env.SPAWN_TEST_DROP = "here";
    const result = await spawn(
      "sh",
      ["-c", 'echo "$SPAWN_TEST_ADD|$(printenv SPAWN_TEST_DROP || echo unset)"'],
      {
        cwd,
        env: { SPAWN_TEST_ADD: "added", SPAWN_TEST_DROP: undefined },
      },
    );
    delete process.env.SPAWN_TEST_DROP;
    expect(result.stdout).toBe("added|unset\n");
  });

  test("input is written to stdin", async () => {
    expect((await spawn("cat", [], { cwd, input: "hello" })).stdout).toBe("hello");
  });

  test("a timeout kills the process and its children and says so", async () => {
    const { dir, pidFile, script } = await backgroundSleep();
    const result = await spawn("sh", ["-c", script], { cwd: dir, timeoutMs: 200 });
    expect(result.stopped).toBe("timeout");
    const pid = await readPid(pidFile);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  });

  test("an abort signal kills the process and says so", async () => {
    const controller = new AbortController();
    const pending = spawn("sleep", ["30"], { cwd, signal: controller.signal });
    controller.abort();
    expect((await pending).stopped).toBe("aborted");
  });

  test("maxOutputBytes keeps only the first bytes of each stream", async () => {
    const result = await spawn("sh", ["-c", "printf 0123456789"], { cwd, maxOutputBytes: 4 });
    expect(result.stdout).toBe("0123");
  });

  test("a background child left behind does not keep spawn waiting", async () => {
    const started = Date.now();
    const result = await spawn("sh", ["-c", "sleep 10 & echo hi"], { cwd });
    expect(result.stdout).toBe("hi\n");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("killRunning takes down a running process and everything it started", async () => {
    const { dir, pidFile, script } = await backgroundSleep();
    const pending = spawn("sh", ["-c", script], { cwd: dir });
    const pid = await readPid(pidFile);

    killRunning();

    expect((await pending).code).toBe(1);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  });
});

describe("spawnInteractive", () => {
  test("waits for the process and returns its exit code", async () => {
    expect(await spawnInteractive("sh", ["-c", "exit 3"], { cwd })).toBe(3);
  });
});

describe("spawnDetached", () => {
  test("returns at once, and the process writes to the output file", async () => {
    const output = join(await mkdtemp(join(tmpdir(), "spawn-detached-")), "out.log");
    const pid = spawnDetached("sh", ["-c", "sleep 0.2; echo done"], { cwd, output });

    expect(isAlive(pid)).toBe(true);
    expect(
      await waitFor(async () => (await readFile(output, "utf8").catch(() => "")) === "done\n"),
    ).toBe(true);
  });
});

describe("execWithTimeout", () => {
  test("returns the exit code, stdout and stderr in the Exec shape", async () => {
    expect(await execWithTimeout(1000)("sh", ["-c", "echo oops >&2; exit 2"], cwd)).toEqual({
      code: 2,
      stdout: "",
      stderr: "oops\n",
    });
  });

  test("a command past the deadline is killed with its children and rejects", async () => {
    const { dir, pidFile, script } = await backgroundSleep();
    await expect(execWithTimeout(200)("sh", ["-c", script], dir)).rejects.toThrow(
      "timed out after 0.2s",
    );
    const pid = await readPid(pidFile);
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  });
});
