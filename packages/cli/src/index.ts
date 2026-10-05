#!/usr/bin/env -S bun --no-env-file
import { Command } from "@commander-js/extra-typings";
import { orchestrateCommand } from "@yok/core";
import { isCompiled, VERSION } from "@yok/sdk/internal";
import { attachCommand } from "./attach.ts";
import { fail } from "./client.ts";
import { doctorCommand } from "./doctor.ts";
import { runCommand } from "./run.ts";
import { serverCommand } from "./server.ts";
import { verifyCommand } from "./verify.ts";
import { viewCommand } from "./view.ts";

// How to start this program again, for every self-call and every child that makes one.
process.env.YOK_SELF = JSON.stringify(
  isCompiled ? [process.execPath] : [process.execPath, "--no-env-file", import.meta.path],
);

await new Command()
  .name("yok")
  .description("Yok engineering CLI")
  .version(VERSION)
  .enablePositionalOptions()
  .addCommand(attachCommand())
  .addCommand(doctorCommand())
  .addCommand(orchestrateCommand())
  .addCommand(runCommand())
  .addCommand(serverCommand())
  .addCommand(verifyCommand())
  .addCommand(viewCommand())
  .parseAsync(process.argv)
  .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
