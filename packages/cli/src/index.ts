#!/usr/bin/env bun
import { Command } from "@commander-js/extra-typings";
import { attachCommand } from "./attach.ts";
import { fail } from "./client.ts";
import { doctorCommand } from "./doctor.ts";
import { runCommand } from "./run.ts";
import { serverCommand } from "./server.ts";
import { verifyCommand } from "./verify.ts";
import { viewCommand } from "./view.ts";

await new Command()
  .name("yok")
  .description("Yok engineering CLI")
  .addCommand(attachCommand())
  .addCommand(doctorCommand())
  .addCommand(runCommand())
  .addCommand(serverCommand())
  .addCommand(verifyCommand())
  .addCommand(viewCommand())
  .parseAsync(process.argv)
  .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
