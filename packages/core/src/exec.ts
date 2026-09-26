import { spawn } from "node:child_process";
import type { Exec } from "@harness/sdk";

export const NOT_FOUND = 127;
// What a shell returns for a command it found but could not run, e.g. EACCES.
const CANNOT_RUN = 126;

// Groups still running, so a caller interrupted by a signal can take them down with it.
const running = new Set<number>();

// SIGKILL, not SIGTERM: a tool can ignore SIGTERM, and a stuck group would outlive its caller.
const killGroup = (pid: number | undefined): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
};

// Detached gives each command its own process group, so the workers it forks die with it.
export const execWithTimeout =
  (timeoutMs: number): Exec =>
  (command, args, cwd) =>
    new Promise((settle, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const pid = child.pid;
      if (pid !== undefined) running.add(pid);
      const done = (): void => {
        clearTimeout(timer);
        if (pid !== undefined) running.delete(pid);
      };
      const timer = setTimeout(() => {
        killGroup(pid);
        done();
        reject(new Error(`timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        done();
        const code = "code" in error && error.code === "ENOENT" ? NOT_FOUND : CANNOT_RUN;
        settle({ code, stdout: "", stderr: error.message });
      });
      // A worker left behind holds the pipe open, and close would wait for the timeout.
      child.on("exit", () => killGroup(pid));
      child.on("close", (code) => {
        done();
        settle({ code: code ?? 1, stdout, stderr });
      });
    });

// Kills every command still running; for a caller's SIGINT/SIGTERM handler.
export const killRunning = (): void => {
  for (const pid of running) killGroup(pid);
  running.clear();
};

// null outside a git repository, or when git itself fails; the caller decides the fallback.
export const findRepoRoot = async (cwd: string, exec: Exec): Promise<string | null> => {
  try {
    const { code, stdout } = await exec("git", ["rev-parse", "--show-toplevel"], cwd);
    return code === 0 ? stdout.trim() : null;
  } catch {
    return null;
  }
};
