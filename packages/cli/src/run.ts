import { dirname, resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { runDoctor, verdict, workflowChecks } from "@harness/core";
import { createGit, type JsonObject, spawnInteractive } from "@harness/sdk";
import { runtimeChecks } from "@harness/server";
import {
  apiErrorText,
  cliLog,
  commandLog,
  compileOrFail,
  ensureServer,
  fail,
  harnessClient,
} from "./client.ts";

const collectInput = (pair: string, acc: Record<string, string>): Record<string, string> => {
  const index = pair.indexOf("=");
  if (index === -1) throw new Error(`--input must be KEY=VALUE, got "${pair}"`);
  return { ...acc, [pair.slice(0, index)]: pair.slice(index + 1) };
};

export const runCommand = () =>
  new Command("run")
    .argument("<workflow>", "workflow file to compile and run")
    .requiredOption("--prompt <text>", "first message sent to the agent")
    .option("--name <name>", "run name (default: derived from the prompt)")
    .option("--input <key=value>", "extra input, repeatable", collectInput, {})
    .option("--attach", "attach to the session's terminal once it starts")
    .action(async (workflowArg, opts) => {
      const log = commandLog("run");
      const cwd = process.cwd();
      const workflowPath = resolve(cwd, workflowArg);

      const plan = await compileOrFail(workflowPath, cwd);
      if (plan === null) return;
      log.debug({ workflow: plan.name, path: workflowPath }, "workflow compiled");

      const report = await runDoctor({
        cwd,
        extraChecks: [...runtimeChecks(), ...workflowChecks(plan.doctor, dirname(workflowPath))],
        log: cliLog(),
      });
      const doctorVerdict = verdict(report);
      log.debug({ verdict: doctorVerdict }, "doctor finished");
      if (doctorVerdict.startsWith("BLOCKED")) return fail(doctorVerdict);

      const repoRoot = await createGit().repoRoot(cwd);
      if (repoRoot === null) return fail("not inside a git repository");

      await ensureServer();
      const result = await harnessClient().run({
        workflow: plan.name,
        workflowPath,
        inputs: { prompt: opts.prompt, ...opts.input } satisfies JsonObject,
        cwd: repoRoot,
        ...(opts.name === undefined ? {} : { name: opts.name }),
      });
      if (!result.ok) return fail(apiErrorText(result.error));
      const { run } = result.value;
      const sessionId = run.sessions[0]?.sessionId;
      log.info({ runId: run.id, workflow: run.workflow, cwd: run.cwd, sessionId }, "run started");

      console.log(run.id);
      console.log(`harness attach --run-id ${run.id}`);

      if (opts.attach === true) {
        const [command, ...args] = result.value.attach;
        // Without TMUX, the attach also works from inside the user's own tmux.
        const exitCode = await spawnInteractive(command as string, args, {
          cwd,
          env: { TMUX: undefined },
        });
        log.info({ runId: run.id, sessionId, exitCode }, "detached from the session");
        process.exitCode = exitCode;
      }
    });
