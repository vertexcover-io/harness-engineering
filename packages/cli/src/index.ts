#!/usr/bin/env bun
import { Command } from "@commander-js/extra-typings";
import { doctorCommand } from "./doctor.ts";
import { worktreeCommand } from "./worktree.ts";

await new Command()
  .name("harness")
  .description("Harness engineering CLI")
  .addCommand(doctorCommand())
  .addCommand(worktreeCommand())
  .parseAsync(process.argv);
