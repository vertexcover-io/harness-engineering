import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  compileWorkflow,
  createLogger,
  loadProjectConfig,
  resolveLevel,
  WorkflowError,
  type WorkflowPlan,
} from "@yok/core";
import { type ILogger, spawnDetached, withLock, yokHome } from "@yok/sdk";
import { selfArgv } from "@yok/sdk/internal";
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
// Logs go to stderr, so `--json` output on stdout stays parseable.
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

export const commandLog = (command: string): ILogger =>
  cliLog().child({ component: "cli", command });

const stackOf = (error: Error): string => {
  const own = error.stack ?? error.message;
  return error.cause instanceof Error ? `${own}\nCaused by: ${stackOf(error.cause)}` : own;
};

// The terminal shows only the message; LOG_LEVEL=debug adds the stack.
export const fail = (problem: string | Error): void => {
  const debug = cliLevel() === "debug" || cliLevel() === "trace";
  const text = typeof problem === "string" ? problem : debug ? stackOf(problem) : problem.message;
  console.error(text);
  process.exitCode = 1;
};

// The original error stays as the cause, so LOG_LEVEL=debug still shows its stack.
const errorText = (error: unknown): string | Error => {
  if (error instanceof WorkflowError) {
    return new Error(`${error.code}: ${error.message}`, { cause: error });
  }
  return error instanceof Error ? error : String(error);
};

// null means the error is already printed and the exit code set.
export const compileOrFail = async (
  path: string,
  cwd: string,
  configFile: string | null = null,
): Promise<WorkflowPlan | null> => {
  const config = await loadProjectConfig(configFile, cwd);
  if (!config.ok && configFile !== null) {
    fail(config.error);
    return null;
  }
  // A broken checkout config is the doctor's to report, so compile goes on without it.
  const options = config.ok ? { cwd, config: config.value } : { cwd };
  return compileWorkflow(path, options).catch((error: unknown) => {
    fail(errorText(error));
    return null;
  });
};

export const apiErrorText = (error: ApiError): string => `${error.code}: ${error.message}`;

export const yokClient = (home: string = yokHome()): YokClient =>
  createYokClient({ home, log: cliLog() });

const tailOf = (path: string, lines = 20): string =>
  existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").slice(-lines).join("\n") : "";

const waitForHealth = async (client: YokClient, deadline: number): Promise<boolean> => {
  while (Date.now() < deadline) {
    if ((await client.health()).ok) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return (await client.health()).ok;
};

// The lock stops two CLIs from starting two servers. A crashed server can leave a stale socket
// file, so it is removed first.
export const ensureServer = async (home: string = yokHome()): Promise<void> => {
  const client = yokClient(home);
  // Checked again inside the lock: another command may have started the server meanwhile.
  if ((await client.health()).ok) return;
  await withLock(join(home, ".start.lock"), async () => {
    if ((await client.health()).ok) return;
    mkdirSync(home, { recursive: true });
    rmSync(socketPath(home), { force: true });

    const log = cliLog().child({ component: "cli" });
    const [command, ...args] = [...selfArgv(), "server", "start"];
    const startedAt = Date.now();
    const pid = spawnDetached(command, args, { cwd: home, output: logPath(home) });
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

// Over SSH with no display, xdg-open can start a text browser that takes over the terminal.
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
