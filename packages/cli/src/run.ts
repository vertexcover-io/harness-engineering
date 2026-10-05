import { resolve } from "node:path";
import { Command } from "@commander-js/extra-typings";
import {
  buildNotifierCheck,
  type DoctorReport,
  findWorkflowPath,
  loadStartEnv,
  runDoctor,
  verdict,
  workflowChecks,
} from "@yok/core";
import { createGit, type JsonObject, loadNamedConfig, spawnInteractive } from "@yok/sdk";
import { isCompiled } from "@yok/sdk/internal";
import { runtimeChecks } from "@yok/server";
import {
  apiErrorText,
  cliLog,
  commandLog,
  compileOrFail,
  ensureServer,
  fail,
  openForPerson,
  yokClient,
} from "./client.ts";

const collectInput = (pair: string, acc: Record<string, string>): Record<string, string> => {
  const index = pair.indexOf("=");
  if (index === -1) throw new Error(`--input must be KEY=VALUE, got "${pair}"`);
  return { ...acc, [pair.slice(0, index)]: pair.slice(index + 1) };
};

// The verdict alone names the failing checks; each one's detail says what to fix.
const blockedText = (report: DoctorReport): string =>
  [
    verdict(report),
    ...report.results
      .filter((row) => row.status === "fail")
      .map((row) => `${row.name}: ${row.detail}`),
  ].join("\n");

export const runCommand = () =>
  new Command("run")
    .argument("<workflow>", "shipped workflow name (e.g. task), or workflow file to run")
    .requiredOption("--prompt <text>", "first message sent to the agent")
    .option("--name <name>", "run name (default: derived from the prompt)")
    .option("--input <key=value>", "extra input, repeatable", collectInput, {})
    .option("--attach", "attach to the session's terminal once it starts")
    .option("--config <file>", "orchestrate config file the run reads (default: the checkout's)")
    .option("--no-open", "do not open the run's page in the browser")
    .action(async (workflowArg, opts) => {
      const log = commandLog("run");
      const cwd = process.cwd();
      const workflowPath = findWorkflowPath(workflowArg, cwd);

      const plan = await compileOrFail(workflowPath, cwd);
      if (plan === null) return;
      log.debug({ workflow: plan.name, path: workflowPath }, "workflow compiled");

      const config = opts.config === undefined ? undefined : resolve(cwd, opts.config);
      if (config !== undefined) {
        const loaded = await loadNamedConfig(config);
        if (!loaded.ok) return fail(loaded.error);
      }

      // Built once: the doctor's env checks and the session see the same values.
      const env = await loadStartEnv(config ?? null, cwd, plan);
      const report = await runDoctor({
        cwd,
        config,
        extraChecks: [
          ...runtimeChecks(plan.agent),
          ...workflowChecks(plan.doctor, env),
          buildNotifierCheck(plan.notifier, env),
        ],
        log: cliLog(),
      });
      const doctorVerdict = verdict(report);
      log.debug({ verdict: doctorVerdict }, "doctor finished");
      if (doctorVerdict.startsWith("BLOCKED")) return fail(blockedText(report));

      const repoRoot = await createGit().repoRoot(cwd);
      if (repoRoot === null) return fail("not inside a git repository");
      if (!env.ok) return fail(env.error);

      await ensureServer();
      const result = await yokClient().run({
        workflow: plan.name,
        workflowPath,
        inputs: { prompt: opts.prompt, ...opts.input } satisfies JsonObject,
        cwd: repoRoot,
        agent: plan.agent,
        env: env.value,
        tiers: plan.tiers,
        ...(opts.name === undefined ? {} : { name: opts.name }),
        ...(config === undefined ? {} : { config }),
      });
      if (!result.ok) return fail(apiErrorText(result.error));
      const { run } = result.value;
      const { terminal } = run;
      log.info({ runId: run.id, workflow: run.workflow, cwd: run.cwd, terminal }, "run started");

      console.log(run.id);
      console.log(`${isCompiled ? "yok" : "yok-dev"} attach --run-id ${run.id}`);
      console.log(`view: ${result.value.view}`);
      openForPerson(result.value.view, opts.open === false);

      if (opts.attach === true) {
        const [command, ...args] = result.value.attach;
        // Without TMUX, the attach also works from inside the user's own tmux.
        const exitCode = await spawnInteractive(command as string, args, {
          cwd,
          env: { TMUX: undefined },
        });
        log.info({ runId: run.id, terminal, exitCode }, "detached from the session");
        process.exitCode = exitCode;
      }
    });
