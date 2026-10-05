import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  devPluginDir,
  execWithTimeout,
  isCompiled,
  killRunning,
  NOT_FOUND,
  selfArgv,
  spawn,
  spawnDetached,
  spawnInteractive,
  writeShim,
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

describe("selfArgv", () => {
  const setSelf = (value: string | undefined): void => {
    if (value === undefined) delete process.env.YOK_SELF;
    else process.env.YOK_SELF = value;
  };
  const withSelf = <T>(value: string | undefined, read: () => T): T => {
    const saved = process.env.YOK_SELF;
    setSelf(value);
    try {
      return read();
    } finally {
      setSelf(saved);
    }
  };

  test("SC20: from source the program reads as not compiled, selfArgv returns YOK_SELF's argv, and an unset, empty or non-JSON value throws", () => {
    expect(isCompiled).toBe(false);
    const argv = JSON.stringify(["/b", "--no-env-file", "/c/index.ts"]);
    expect(withSelf(argv, selfArgv)).toEqual(["/b", "--no-env-file", "/c/index.ts"]);
    expect(() => withSelf(undefined, selfArgv)).toThrow("YOK_SELF is unset");
    expect(() => withSelf("[]", selfArgv)).toThrow();
    expect(() => withSelf("not json", selfArgv)).toThrow();
  });

  test("SC71: from source, devPluginDir is the repo three folders above the CLI entry YOK_SELF names, and the real entry gives the folder holding the plugin manifest", () => {
    const fake = JSON.stringify(["/b", "--no-env-file", "/r/packages/cli/src/index.ts"]);
    expect(withSelf(fake, devPluginDir)).toBe("/r");
    const repo = devPluginDir();
    expect(repo).toBeDefined();
    expect(existsSync(join(repo ?? "", ".claude-plugin", "plugin.json"))).toBe(true);
  });
});

describe("writeShim", () => {
  test("SC60: the same program reuses its shim folder, holding only yok and no temp file; another program gets another folder under HOME/shims", async () => {
    const home = await mkdtemp(join(tmpdir(), "shim-"));
    const first = writeShim(["/b", "--no-env-file", "/one/index.ts"], home);
    const again = writeShim(["/b", "--no-env-file", "/one/index.ts"], home);
    const other = writeShim(["/b", "--no-env-file", "/two/index.ts"], home);
    expect(again).toBe(first);
    expect(other).not.toBe(first);
    expect(dirname(first)).toBe(join(home, "shims"));
    expect(dirname(other)).toBe(join(home, "shims"));
    expect(readdirSync(first)).toEqual(["yok"]);
    expect(readdirSync(other)).toEqual(["yok"]);
  });

  test("SC61: a compiled program's shim is a symlink to the binary", async () => {
    const home = await mkdtemp(join(tmpdir(), "shim-"));
    const shim = join(writeShim(["/opt/yok/bin/yok"], home, true), "yok");
    expect(lstatSync(shim).isSymbolicLink()).toBe(true);
    expect(readlinkSync(shim)).toBe("/opt/yok/bin/yok");
  });

  test("SC65: a source shim runs the program that wrote it with the caller's arguments, and exits with its code", async () => {
    const home = await mkdtemp(join(tmpdir(), "shim-"));
    const fixture = join(home, "fixture.ts");
    await writeFile(
      fixture,
      "console.log(JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n",
    );
    const shim = join(writeShim([process.execPath, fixture], home), "yok");
    const result = await spawn(shim, ["a", "b c"], { cwd });
    expect(result.stdout.trim()).toBe(JSON.stringify(["a", "b c"]));
    expect(result.code).toBe(7);
  });
});

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
