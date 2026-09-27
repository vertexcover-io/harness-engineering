import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createLogger, harnessHome, resolveLevel, withLock } from "@harness/core";
import { type ILogger, spawnDetached } from "@harness/sdk";
import { type ApiError, logPath, socketPath } from "@harness/server";
import { createHarnessClient, type HarnessClient } from "@harness/server/client";

const HEALTH_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

let level: ReturnType<typeof resolveLevel> | null = null;
// Read once, so a bad LOG_LEVEL warns once.
const cliLevel = (): ReturnType<typeof resolveLevel> => {
  level ??= resolveLevel(process.env, "warn");
  return level;
};

let logger: ILogger | null = null;
// The CLI's own logger: stderr keeps stdout clean for command output, so `--json` stays parseable.
export const cliLog = (): ILogger => {
  logger ??= createLogger(
    { service: "harness-cli" },
    {
      destination: { write: (chunk: string) => void process.stderr.write(chunk) },
      level: cliLevel(),
    },
  );
  return logger;
};

// A command's own lines, tagged with which command wrote them.
export const commandLog = (command: string): ILogger =>
  cliLog().child({ component: "cli", command });

// On the terminal an error shows its message; its stack is for debugging, under LOG_LEVEL=debug.
// The server's own logs keep every stack.
export const fail = (problem: string | Error): void => {
  const debug = cliLevel() === "debug" || cliLevel() === "trace";
  const text =
    typeof problem === "string"
      ? problem
      : debug
        ? (problem.stack ?? problem.message)
        : problem.message;
  console.error(text);
  process.exitCode = 1;
};

// How a server error reads on the terminal.
export const apiErrorText = (error: ApiError): string => `${error.code}: ${error.message}`;

export const harnessClient = (home: string = harnessHome()): HarnessClient =>
  createHarnessClient({ home, log: cliLog() });

// `[process.execPath, Bun.main]` re-runs the interpreted CLI; a compiled `dist/harness` binary
// re-runs itself with just its own path.
export const selfCommand = (): readonly string[] =>
  basename(process.execPath) === "bun" ? [process.execPath, Bun.main] : [process.execPath];

const tailOf = (path: string, lines = 20): string =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").slice(-lines).join("\n") : "";

const waitForHealth = async (client: HarnessClient, deadline: number): Promise<boolean> => {
  while (Date.now() < deadline) {
    if ((await client.health()).ok) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return (await client.health()).ok;
};

// Starts `harness server start` when nothing answers /health. A lock stops two CLIs racing to
// start two servers; a stale socket file from a crashed server is removed before spawning.
export const ensureServer = async (home: string = harnessHome()): Promise<void> => {
  const client = harnessClient(home);
  // Fast path: a running server skips the lock. The check inside the lock covers another
  // command having started the server while this one waited for it.
  if ((await client.health()).ok) return;
  await withLock(join(home, ".start.lock"), async () => {
    if ((await client.health()).ok) return;
    mkdirSync(home, { recursive: true });
    rmSync(socketPath(home), { force: true });

    const log = cliLog().child({ component: "cli" });
    const [command, ...args] = [...selfCommand(), "server", "start"];
    const startedAt = Date.now();
    const pid = spawnDetached(command as string, args, { cwd: home, output: logPath(home) });
    log.info({ pid, command: [command, ...args], log: logPath(home) }, "server process started");

    const started = await waitForHealth(client, Date.now() + HEALTH_TIMEOUT_MS);
    if (started) {
      log.info({ pid, durationMs: Date.now() - startedAt }, "server answering /health");
      return;
    }
    const tail = tailOf(logPath(home));
    log.error({ pid, tail }, "server did not answer /health within 5s");
    throw new Error(`harness server did not start within ${HEALTH_TIMEOUT_MS / 1000}s\n${tail}`);
  });
};
