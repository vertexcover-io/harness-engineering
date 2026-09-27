import { resolve } from "node:path";
import { Command, Option } from "@commander-js/extra-typings";
import { compileWorkflow, type JsonObject, runDoctor, verdict } from "@harness/core";
import { AgentTypeSchema, createGit, spawnInteractive } from "@harness/sdk";
import { runtimeChecks } from "@harness/server";
import { cliLog, commandLog, ensureServer, fail, harnessClient } from "./client.ts";

const collectInput = (pair: string, acc: Record<string, string>): Record<string, string> => {
  const index = pair.indexOf("=");
  if (index === -1) throw new Error(`--input must be KEY=VALUE, got "${pair}"`);
  return { ...acc, [pair.slice(0, index)]: pair.slice(index + 1) };
};

const NO_RUN_MESSAGE = "no run: pass --run-id or run inside a harness session";
const resolveRunId = (run: string | undefined): string | null =>
  run ?? process.env.HARNESS_RUN_ID ?? null;

export const runCommand = () =>
  new Command("run")
    .argument("<workflow>", "workflow file to compile and run")
    .requiredOption("--prompt <text>", "first message sent to the agent")
    .option("--input <key=value>", "extra input, repeatable", collectInput, {})
    .option("--attach", "attach to the session's terminal once it starts")
    .action(async (workflowArg, opts) => {
      const log = commandLog("run");
      const cwd = process.cwd();
      const workflowPath = resolve(cwd, workflowArg);

      const plan = await compileWorkflow(workflowPath).catch((error: unknown) => {
        fail(error instanceof Error ? error : String(error));
        return null;
      });
      if (plan === null) return;
      log.debug({ workflow: plan.name, path: workflowPath }, "workflow compiled");

      const report = await runDoctor({
        cwd,
        extraChecks: runtimeChecks(),
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
      });
      if (!result.ok) return fail(`${result.error.code}: ${result.error.message}`);
      const { run } = result.value;
      const sessionId = run.sessions[0]?.sessionId;
      log.info({ runId: run.id, workflow: run.workflow, cwd: run.cwd, sessionId }, "run started");

      console.log(run.id);
      console.log(result.value.attach.join(" "));

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

export const initCommand = () =>
  new Command("init")
    .argument("<name>", "run name, used for its folder .harness/NAME")
    .option("--run-id <id>", "run id (defaults to $HARNESS_RUN_ID)")
    .action(async (name, opts) => {
      const runId = resolveRunId(opts.runId);
      if (runId === null) return fail(NO_RUN_MESSAGE);

      await ensureServer();
      const result = await harnessClient().init(runId, { name });
      if (!result.ok) return fail(`${result.error.code}: ${result.error.message}`);
      commandLog("init").info({ runId, name, dir: result.value.dir }, "run initialized");

      console.log(JSON.stringify({ runId, dir: result.value.dir }));
    });

export const linkSessionCommand = () =>
  new Command("link-session")
    .argument("<sessionId>", "agent session id")
    .addOption(
      new Option("--agent <type>", "agent type")
        .choices(AgentTypeSchema.options)
        .makeOptionMandatory(),
    )
    .option("--run-id <id>", "run id (defaults to $HARNESS_RUN_ID)")
    .action(async (sessionId, opts) => {
      const runId = resolveRunId(opts.runId);
      if (runId === null) return fail(NO_RUN_MESSAGE);

      await ensureServer();
      const result = await harnessClient().linkSession(runId, { agent: opts.agent, sessionId });
      if (!result.ok) return fail(`${result.error.code}: ${result.error.message}`);
      commandLog("link-session").info(
        { runId, agent: opts.agent, sessionId, sessions: result.value.run.sessions.length },
        "session linked",
      );

      console.log(JSON.stringify(result.value.run.sessions));
    });
