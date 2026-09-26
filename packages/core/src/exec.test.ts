import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execWithTimeout, findRepoRoot, killRunning, NOT_FOUND } from "./exec.ts";

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("execWithTimeout", () => {
  test("SC25: a missing binary resolves with code 127 and empty stdout", async () => {
    const exec = execWithTimeout(1000);
    expect(await exec("no-such-binary-xyz", [], process.cwd())).toMatchObject({
      code: NOT_FOUND,
      stdout: "",
    });
  });

  test("SC10: a command past the deadline is killed with its children and rejects with a timeout message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exec-timeout-"));
    const pidFile = join(dir, "pid");
    const exec = execWithTimeout(200);
    const script = `sleep 30 & echo $! > ${pidFile}; wait`;

    await expect(exec("sh", ["-c", script], dir)).rejects.toThrow("timed out after 0.2s");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const pid = Number((await readFile(pidFile, "utf8")).trim());
        if (!isAlive(pid)) break;
      } catch {
        // pid file not written yet
      }
      await sleep(50);
    }
    const pid = Number((await readFile(pidFile, "utf8")).trim());
    expect(isAlive(pid)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

const waitForPid = async (pidFile: string): Promise<number> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = await readFile(pidFile, "utf8").catch(() => "");
    if (text.trim() !== "") return Number(text.trim());
    await sleep(25);
  }
  throw new Error(`no pid in ${pidFile}`);
};

const waitUntilDead = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 40 && isAlive(pid); attempt += 1) await sleep(25);
  return !isAlive(pid);
};

describe("execWithTimeout, beyond the planned scenarios", () => {
  test("captures stderr beside the exit code", async () => {
    const result = await execWithTimeout(1000)(
      "sh",
      ["-c", "echo oops >&2; exit 2"],
      process.cwd(),
    );
    expect(result).toEqual({ code: 2, stdout: "", stderr: "oops\n" });
  });

  test("a command that exits while a background child still runs resolves at once", async () => {
    const started = Date.now();
    const result = await execWithTimeout(3000)("sh", ["-c", "sleep 10 & echo hi"], process.cwd());
    expect(result).toMatchObject({ code: 0, stdout: "hi\n" });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("killRunning takes down a running command and everything it started", async () => {
    const dir = await mkdtemp(join(tmpdir(), "exec-kill-"));
    const pidFile = join(dir, "pid");
    const pending = execWithTimeout(10_000)(
      "sh",
      ["-c", `sleep 30 & echo $! > ${pidFile}; wait`],
      dir,
    );
    const pid = await waitForPid(pidFile);

    killRunning();

    expect(await pending).toMatchObject({ code: 1 });
    expect(await waitUntilDead(pid)).toBe(true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("findRepoRoot", () => {
  test("SC24: returns the repository's top folder from a nested subfolder, and null outside any repository", async () => {
    const exec = execWithTimeout(5000);
    const repoDir = await mkdtemp(join(tmpdir(), "exec-repo-"));
    await exec("git", ["init"], repoDir);
    const nested = join(repoDir, "a", "b");
    await exec("mkdir", ["-p", nested], repoDir);
    const plainDir = await mkdtemp(join(tmpdir(), "exec-plain-"));

    const root = await findRepoRoot(nested, exec);
    expect(root).toBe(await realpath(repoDir));
    expect(await findRepoRoot(plainDir, exec)).toBeNull();

    await rm(repoDir, { recursive: true, force: true });
    await rm(plainDir, { recursive: true, force: true });
  });
});
