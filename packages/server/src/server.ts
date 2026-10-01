import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { claudeProvider, createLogger, harnessTmux, resolveLevel } from "@harness/core";
import type { Check, IAgentProvider, ILogger, ITerminal } from "@harness/sdk";
import { noopLogger, registryPath } from "@harness/sdk";
import { createRegistry } from "@harness/sdk/internal";
import prettyFactory from "pino-pretty";
import serverPackage from "../package.json";
import { createApp } from "./app.ts";
import { pidPath, socketPath } from "./protocol.ts";
export type Runtime = Readonly<{ terminal: ITerminal; provider: IAgentProvider }>;

export const defaultRuntime = (log: ILogger = noopLogger): Runtime => {
  const terminal = harnessTmux(process.env, log);
  const provider = claudeProvider({
    terminal,
    binary: process.env.HARNESS_CLAUDE_BIN ?? "claude",
    log,
  });
  return { terminal, provider };
};

export const runtimeChecks = (): readonly Check[] => {
  const { terminal, provider } = defaultRuntime();
  return [...terminal.checks, ...provider.checks];
};

// Callers check /health first: this always starts, and replaces any socket file it finds.
export const startServer = async ({ home }: { home: string }): Promise<void> => {
  const isTTY = process.stdout.isTTY === true;
  const level = resolveLevel(process.env);
  const log = createLogger(
    { service: "harness-server" },
    isTTY
      ? {
          level,
          destination: prettyFactory({
            colorize: true,
            translateTime: "SYS:HH:MM:ss",
            ignore: "pid,hostname",
          }),
        }
      : { level },
  );

  const serverLog = log.child({ component: "server" });
  await mkdir(home, { recursive: true });
  const socket = socketPath(home);
  if (existsSync(socket)) {
    await rm(socket, { force: true });
    serverLog.info({ socket }, "removed a socket file left by a server that is no longer running");
  }

  const { terminal, provider } = defaultRuntime(log);
  const registry = createRegistry(registryPath(home), log);
  const version = String(serverPackage.version);
  const app = createApp({
    registry,
    provider,
    terminal,
    log,
    home,
    pid: process.pid,
    version,
  });

  const server = Bun.serve({ unix: socket, fetch: app.fetch });
  await writeFile(pidPath(home), String(process.pid));
  serverLog.info({ socket, pid: process.pid, version }, "server listening");

  const shutdown = (signal: string): void => {
    serverLog.info({ signal }, `received ${signal}; stopping once in-flight requests finish`);
    // stop() resolves once in-flight requests finish, so a run still launching gets recorded.
    void server
      .stop()
      .then(() => Promise.all([rm(socket, { force: true }), rm(pidPath(home), { force: true })]))
      .then(() => {
        serverLog.info({}, "server stopped; tmux sessions keep running");
        process.exit(0);
      });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};
