#!/usr/bin/env bun
import { Command } from "@commander-js/extra-typings";
import { doctorCommand } from "./doctor.ts";

await new Command()
  .name("harness")
  .description("Harness engineering CLI")
  .addCommand(doctorCommand())
  .parseAsync(process.argv);
