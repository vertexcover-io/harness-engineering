import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  compileWorkflow,
  createLogger,
  resolveLevel,
  WorkflowError,
  type WorkflowPlan,
} from "@yok/core";
import { type ILogger, spawnDetached, withLock, yokHome } from "@yok/sdk";
import { type ApiError, logPath, socketPath } from "@yok/server";
import { createYokClient, type YokClient } from "@yok/server/client";

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
    { service: "yok-cli" },
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

const stackOf = (error: Error): string => {
  const own = error.stack ?? error.message;
  return error.cause instanceof Error ? `${own}\nCaused by: ${stackOf(error.cause)}` : own;
};

// On the terminal an error shows its message; its stack is for debugging, under LOG_LEVEL=debug.
// The server's own logs keep every stack.
export const fail = (problem: string | Error): void => {
  const debug = cliLevel() === "debug" || cliLevel() === "trace";
  const text = typeof problem === "string" ? problem : debug ? stackOf(problem) : problem.message;
  console.error(text);
  process.exitCode = 1;
};

// A compile error reads as CODE: message; the original stays as the cause for LOG_LEVEL=debug.
const errorText = (error: unknown): string | Error => {
  if (error instanceof WorkflowError) {
    return new Error(`${error.code}: ${error.message}`, { cause: error });
  }
  return error instanceof Error ? error : String(error);
};

// null means the error is already printed and the exit code set.
export const compileOrFail = (path: string, cwd: string): Promise<WorkflowPlan | null> =>
  compileWorkflow(path, { cwd }).catch((error: unknown) => {
    fail(errorText(error));
    return null;
  });

// How a server error reads on the terminal.
export const apiErrorText = (error: ApiError): string => `${error.code}: ${error.message}`;

export const yokClient = (home: string = yokHome()): YokClient =>
  createYokClient({ home, log: cliLog() });

// `[process.execPath, Bun.main]` re-runs the interpreted CLI; a compiled `dist/yok` binary
// re-runs itself with just its own path.
export const selfCommand = (): readonly string[] =>
  basename(process.execPath) === "bun" ? [process.execPath, Bun.main] : [process.execPath];

const tailOf = (path: string, lines = 20): string =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").slice(-lines).join("\n") : "";

const waitForHealth = async (client: YokClient, deadline: number): Promise<boolean> => {
  while (Date.now() < deadline) {
    if ((await client.health()).ok) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return (await client.health()).ok;
};

// Starts `yok server start` when nothing answers /health. A lock stops two CLIs racing to
// start two servers; a stale socket file from a crashed server is removed before spawning.
export const ensureServer = async (home: string = yokHome()): Promise<void> => {
  const client = yokClient(home);
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
    throw new Error(`yok server did not start within ${HEALTH_TIMEOUT_MS / 1000}s\n${tail}`);
  });
};

type OpenDecision = Readonly<{
  noOpen: boolean;
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}>;

// On Linux without a display (an SSH session), xdg-open can start a text browser inside the
// user's terminal and take it over.
export const shouldOpenBrowser = ({ noOpen, isTTY, env, platform }: OpenDecision): boolean => {
  if (noOpen || !isTTY) return false;
  if (env.CI !== undefined && env.CI !== "" && env.CI !== "false") return false;
  if (platform !== "linux") return true;
  return Boolean(env.DISPLAY) || Boolean(env.WAYLAND_DISPLAY);
};

const openerFor = (
  platform: NodeJS.Platform,
  url: string,
): readonly [string, readonly string[]] => {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
};

// The URL is always printed as well, so a failed open is only logged.
export const openInBrowser = (url: string): void => {
  const [command, args] = openerFor(process.platform, url);
  try {
    spawnDetached(command, args, { cwd: process.cwd(), output: "ignore" });
  } catch (error) {
    cliLog().debug({ err: error, command }, "could not open the browser");
  }
};

export const openForPerson = (url: string, noOpen: boolean): void => {
  const isTTY = process.stdout.isTTY === true;
  if (shouldOpenBrowser({ noOpen, isTTY, env: process.env, platform: process.platform })) {
    openInBrowser(url);
  }
};
