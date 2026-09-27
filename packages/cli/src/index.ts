#!/usr/bin/env bun
import { Command } from "@commander-js/extra-typings";
import { fail } from "./client.ts";
import { doctorCommand } from "./doctor.ts";
import { emitCommand } from "./emit.ts";
import { initCommand, linkSessionCommand, runCommand } from "./run.ts";
import { serverCommand } from "./server.ts";
import { worktreeCommand } from "./worktree.ts";

await new Command()
  .name("harness")
  .description("Harness engineering CLI")
  .addCommand(doctorCommand())
  .addCommand(worktreeCommand())
  .addCommand(runCommand())
  .addCommand(initCommand())
  .addCommand(linkSessionCommand())
  .addCommand(emitCommand())
  .addCommand(serverCommand())
  .parseAsync(process.argv)
  .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
