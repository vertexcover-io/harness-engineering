import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  agentProvider,
  createLogger,
  harnessTerminalHost,
  resolveLevel,
  type WorkflowAgent,
} from "@harness/core";
import type { Check, IAgentProvider, ILogger, ITerminalHost } from "@harness/sdk";
import { noopLogger, registryPath } from "@harness/sdk";
import { createRegistry } from "@harness/sdk/internal";
import prettyFactory from "pino-pretty";
import serverPackage from "../package.json";
import { createApp } from "./app.ts";
import { resumeDeliveries, stopDeliveries } from "./delivery.ts";
import { pidPath, socketPath } from "./protocol.ts";
import { startViewer } from "./viewer.ts";
export type Runtime = Readonly<{
  host: ITerminalHost;
  providerFor: (agent: WorkflowAgent) => IAgentProvider;
}>;

export const defaultRuntime = (log: ILogger = noopLogger): Runtime => {
  const host = harnessTerminalHost(process.env, log);
  return { host, providerFor: (agent) => agentProvider({ agent, host, env: process.env, log }) };
};

export const runtimeChecks = (agent: WorkflowAgent): readonly Check[] => {
  const { host, providerFor } = defaultRuntime();
  return [...host.checks, ...providerFor(agent).checks];
};

// Callers check /health first: this always starts, and replaces any socket file it finds.
export const startServer = async ({
  home,
  runtime,
}: {
  home: string;
  runtime?: Runtime;
}): Promise<Readonly<{ stop: () => Promise<void> }>> => {
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

  const { host, providerFor } = runtime ?? defaultRuntime(log);
  const registry = createRegistry(registryPath(home), log);
  const version = String(serverPackage.version);
  const viewerLog = log.child({ component: "viewer" });
  const viewer = await startViewer({ home, registry, providerFor, host, log: viewerLog });
  void resumeDeliveries({ registry, providerFor, host, log: viewerLog, now: () => new Date() });
  const app = createApp({
    registry,
    providerFor,
    log,
    home,
    viewerOrigin: viewer.origin,
    pid: process.pid,
    version,
  });

  const server = Bun.serve({ unix: socket, fetch: app.fetch });
  await writeFile(pidPath(home), String(process.pid));
  serverLog.info({ socket, pid: process.pid, version, viewer: viewer.origin }, "server listening");

  const stop = async (): Promise<void> => {
    stopDeliveries();
    // stop() resolves once in-flight requests finish, so a run still launching gets recorded.
    await server.stop();
    await Promise.all([
      viewer.stop(),
      rm(socket, { force: true }),
      rm(pidPath(home), { force: true }),
    ]);
  };

  const shutdown = (signal: string): void => {
    serverLog.info({ signal }, `received ${signal}; stopping once in-flight requests finish`);
    void stop().then(() => {
      serverLog.info({}, "server stopped; tmux sessions keep running");
      process.exit(0);
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return { stop };
};
