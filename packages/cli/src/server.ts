import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Command } from "@commander-js/extra-typings";
import { harnessHome } from "@harness/core";
import { socketPath, startServer } from "@harness/server";
import { commandLog, fail, harnessClient } from "./client.ts";

const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;

// Bun.file().exists() reports false for a socket file, so this uses existsSync.
const socketGone = (path: string): boolean => !existsSync(path);

export const serverCommand = () => {
  const server = new Command("server").description("Manage the harness server process");

  server
    .command("start")
    .description("Run the harness server in the foreground")
    .action(async () => {
      const home = harnessHome();
      const running = await harnessClient(home).health();
      if (running.ok) {
        commandLog("server start").info({ pid: running.value.pid }, "server already running");
        console.log(`already running (pid ${running.value.pid})`);
        return;
      }
      // Bun.serve keeps the process alive; startServer's own SIGINT/SIGTERM handler exits it.
      await startServer({ home });
    });

  server
    .command("stop")
    .description("Stop the running harness server")
    .action(async () => {
      const home = harnessHome();
      // Signal the pid the live server reports, never a pid file a crash may have left behind.
      const running = await harnessClient(home).health();
      if (!running.ok) {
        return fail("not running");
      }
      const log = commandLog("server stop");
      const { pid } = running.value;
      const startedAt = Date.now();
      process.kill(pid, "SIGTERM");
      while (!socketGone(socketPath(home)) && Date.now() < startedAt + STOP_TIMEOUT_MS) {
        await sleep(POLL_INTERVAL_MS);
      }
      if (socketGone(socketPath(home))) {
        log.info({ pid, durationMs: Date.now() - startedAt }, "server stopped");
        return;
      }
      log.warn({ pid }, "server still running 5s after SIGTERM");
      fail(`server (pid ${pid}) is still running ${STOP_TIMEOUT_MS / 1000}s after SIGTERM`);
    });

  server
    .command("status")
    .description("Show whether the harness server is running")
    .action(async () => {
      const result = await harnessClient().health();
      if (!result.ok) {
        console.log("not running");
        process.exitCode = 1;
        return;
      }
      console.log(`pid ${result.value.pid}, version ${result.value.version}`);
    });

  return server;
};
