import { spawn as nodeSpawn } from "node:child_process";
import { openSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { Exec } from "./check.ts";

export const NOT_FOUND = 127;
// What a shell returns for a command it found but could not run, e.g. EACCES.
const CANNOT_RUN = 126;

// Added to the parent's environment; an undefined value removes that variable.
export type SpawnEnv = Readonly<Record<string, string | undefined>>;

export type SpawnOptions = Readonly<{
  cwd: string;
  env?: SpawnEnv;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  onStdout?: (line: string) => void;
  onStderr?: (line: string) => void;
}>;

export type SpawnResult = Readonly<{
  code: number;
  stdout: string;
  stderr: string;
  stopped: "timeout" | "aborted" | null;
}>;

export type SpawnInteractiveOptions = Readonly<{ cwd: string; env?: SpawnEnv }>;

// A path is appended to; a number is an open file descriptor.
export type SpawnDetachedOptions = Readonly<{
  cwd: string;
  env?: SpawnEnv;
  output: string | number | "ignore";
}>;

const buildEnv = (env: SpawnEnv = {}): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries({ ...process.env, ...env }).filter(([, value]) => value !== undefined),
  );

// Process groups still running, so a caller interrupted by a signal can take them down with it.
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

// Kills every process spawn started that is still running; for a SIGINT/SIGTERM handler.
export const killRunning = (): void => {
  for (const pid of running) killGroup(pid);
  running.clear();
};

const stopRunning = (exitCode: number): void => {
  killRunning();
  process.exit(exitCode);
};

// Commands run in their own process groups, so a signal to this process would not reach them.
// Installs handlers that kill them and exit with the shell's code for the signal.
export const stopRunningOnSignal = (): void => {
  process.once("SIGINT", () => stopRunning(130));
  process.once("SIGTERM", () => stopRunning(143));
};

// Collects a stream up to a byte cap and hands each complete line to a callback as it arrives.
const collector = (maxBytes: number, onLine: ((line: string) => void) | undefined) => {
  const kept: Buffer[] = [];
  let keptBytes = 0;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (text: string): void => {
    if (onLine === undefined) return;
    const lines = (pending + text).split("\n");
    pending = lines.pop() ?? "";
    lines.forEach(onLine);
  };
  return {
    push: (chunk: Buffer): void => {
      const part = chunk.subarray(0, Math.max(0, maxBytes - keptBytes));
      kept.push(part);
      keptBytes += part.length;
      emit(decoder.write(chunk));
    },
    finish: (): string => {
      emit(decoder.end());
      if (pending !== "") onLine?.(pending);
      pending = "";
      return Buffer.concat(kept).toString("utf8");
    },
  };
};

// Runs a command in its own process group and waits for it. The group is killed when the
// command exits, so a background child it left behind cannot hold the output pipes open,
// and on a timeout or abort, which settle at once with whatever output arrived.
export const spawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<SpawnResult> =>
  new Promise((settle) => {
    const child = nodeSpawn(command, [...args], {
      cwd: options.cwd,
      env: buildEnv(options.env),
      detached: true,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid !== undefined) running.add(pid);
    const maxBytes = options.maxOutputBytes ?? Number.POSITIVE_INFINITY;
    const stdout = collector(maxBytes, options.onStdout);
    const stderr = collector(maxBytes, options.onStderr);
    let settled = false;

    const finish = (code: number, stopped: SpawnResult["stopped"]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (pid !== undefined) running.delete(pid);
      settle({ code, stdout: stdout.finish(), stderr: stderr.finish(), stopped });
    };
    const stop = (reason: "timeout" | "aborted") => (): void => {
      killGroup(pid);
      finish(1, reason);
    };
    const onAbort = stop("aborted");
    const timer =
      options.timeoutMs === undefined ? undefined : setTimeout(stop("timeout"), options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();

    child.stdout?.on("data", stdout.push);
    child.stderr?.on("data", stderr.push);
    child.on("error", (error) => {
      const code = "code" in error && error.code === "ENOENT" ? NOT_FOUND : CANNOT_RUN;
      stderr.push(Buffer.from(error.message));
      finish(code, null);
    });
    child.on("exit", () => killGroup(pid));
    child.on("close", (code) => finish(code ?? 1, null));
    if (child.stdin !== null) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(options.input);
    }
  });

// Hands the terminal to the command and waits for it to exit. Ctrl-C reaches the command, and
// this process ignores it meanwhile so it does not exit first and leave the terminal half-used.
export const spawnInteractive = (
  command: string,
  args: readonly string[],
  options: SpawnInteractiveOptions,
): Promise<number> =>
  new Promise((settle) => {
    const ignore = (): void => undefined;
    process.on("SIGINT", ignore);
    const child = nodeSpawn(command, [...args], {
      cwd: options.cwd,
      env: buildEnv(options.env),
      stdio: "inherit",
    });
    const finish = (code: number): void => {
      process.off("SIGINT", ignore);
      settle(code);
    };
    child.on("error", (error) =>
      finish("code" in error && error.code === "ENOENT" ? NOT_FOUND : CANNOT_RUN),
    );
    child.on("close", (code) => finish(code ?? 1));
  });

// Starts the command cut loose from this process and returns its pid without waiting. Its
// output goes to a file, because no pipe back to this process survives this process exiting.
export const spawnDetached = (
  command: string,
  args: readonly string[],
  options: SpawnDetachedOptions,
): number => {
  const output =
    typeof options.output === "string" && options.output !== "ignore"
      ? openSync(options.output, "a")
      : options.output;
  const child = nodeSpawn(command, [...args], {
    cwd: options.cwd,
    env: buildEnv(options.env),
    detached: true,
    stdio: ["ignore", output, output],
  });
  child.unref();
  if (child.pid === undefined) throw new Error(`could not start ${command}`);
  return child.pid;
};

// spawn in the Exec shape that checks and git take: rejects when the command runs past the
// deadline, so a caller can tell a hang from a failed command.
export const execWithTimeout =
  (timeoutMs: number): Exec =>
  async (command, args, cwd) => {
    const { code, stdout, stderr, stopped } = await spawn(command, args, { cwd, timeoutMs });
    if (stopped === "timeout") throw new Error(`timed out after ${timeoutMs / 1000}s`);
    return { code, stdout, stderr };
  };
