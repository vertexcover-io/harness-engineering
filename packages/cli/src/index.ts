#!/usr/bin/env -S bun --no-env-file
import { Command } from "@commander-js/extra-typings";
import { orchestrateCommand } from "@yok/core";
import { isCompiled, VERSION } from "@yok/sdk/internal";
import { agentCommand } from "./agent.ts";
import { attachCommand } from "./attach.ts";
import { fail } from "./client.ts";
import { doctorCommand } from "./doctor.ts";
import { runCommand } from "./run.ts";
import { serveModules } from "./serve.ts";
import { serverCommand } from "./server.ts";
import { typesCommand } from "./types.ts";
import { verifyCommand } from "./verify.ts";
import { viewCommand } from "./view.ts";

// How to start this program again, for every self-call and every child that makes one.
process.env.YOK_SELF = JSON.stringify(
  isCompiled ? [process.execPath] : [process.execPath, "--no-env-file", import.meta.path],
);

// Before any command runs, so every module it loads gets the served imports.
serveModules();

await new Command()
  .name("yok")
  .description("Yok engineering CLI")
  .version(VERSION)
  .enablePositionalOptions()
  .addCommand(attachCommand())
  .addCommand(agentCommand("claude"))
  .addCommand(agentCommand("codex"))
  .addCommand(doctorCommand())
  .addCommand(orchestrateCommand())
  .addCommand(runCommand())
  .addCommand(serverCommand())
  .addCommand(typesCommand())
  .addCommand(verifyCommand())
  .addCommand(viewCommand())
  .parseAsync(process.argv)
  .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
