import { Command } from "@commander-js/extra-typings";
import { createRegistryReader, registryPath, requireRun } from "@harness/sdk";
import { apiErrorText, ensureServer, fail, harnessClient, openForPerson } from "./client.ts";

export const viewCommand = () =>
  new Command("view")
    .description("Open a run's artifact page in the browser")
    .argument("[name]", "run name in this repo (default: $HARNESS_RUN_ID)")
    .option("--run-id <id>", "view by run id instead of name")
    .option("--print", "print the page URL without opening it")
    .action(async (name, opts) => {
      const run = await requireRun({
        registry: createRegistryReader(registryPath()),
        name,
        id: opts.runId,
        env: process.env,
        cwd: process.cwd(),
      });
      if (!run.ok) return fail(run.error);
      await ensureServer();
      const reply = await harnessClient().view(run.value.id);
      if (!reply.ok) return fail(apiErrorText(reply.error));
      console.log(reply.value.view);
      openForPerson(reply.value.view, opts.print === true);
    });
