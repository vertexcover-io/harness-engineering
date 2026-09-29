import { resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { compileWorkflow, WorkflowError } from "@harness/core";
import { fail } from "./client.ts";

const errorText = (error: unknown): string | Error => {
  if (error instanceof WorkflowError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error : String(error);
};

export const verifyCommand = () =>
  new Command("verify")
    .description("Compile a workflow and print its compile error, if any")
    .argument("<workflow>", "workflow file to compile")
    .action(async (workflowArg) => {
      const cwd = process.cwd();
      const plan = await compileWorkflow(resolve(cwd, workflowArg), { cwd }).catch(
        (error: unknown) => {
          fail(errorText(error));
          return null;
        },
      );
      if (plan === null) return;
      const count = plan.nodes.length;
      console.log(`ok: workflow ${plan.name} compiles (${count} node${count === 1 ? "" : "s"})`);
    });
