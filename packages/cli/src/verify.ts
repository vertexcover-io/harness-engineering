import { resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { compileOrFail } from "./client.ts";

export const verifyCommand = () =>
  new Command("verify")
    .description("Compile a workflow and print its compile error, if any")
    .argument("<workflow>", "workflow file to compile")
    .action(async (workflowArg) => {
      const cwd = process.cwd();
      const plan = await compileOrFail(resolve(cwd, workflowArg), cwd);
      if (plan === null) return;
      const count = plan.nodes.length;
      console.log(`ok: workflow ${plan.name} compiles (${count} node${count === 1 ? "" : "s"})`);
    });
