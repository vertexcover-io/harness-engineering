import { Command } from "@commander-js/extra-typings";
import { harnessTmux } from "@harness/core";
import { type Result, registryPath, resolveRoot, spawnInteractive } from "@harness/sdk";
import {
  createRegistry,
  findRunByIdOrName,
  type Registry,
  type RunTarget,
} from "@harness/sdk/internal";
import { commandLog, fail } from "./client.ts";

// A name is looked up in the repo the command runs in; an id needs no repo.
const pickTarget = async (
  name: string | undefined,
  runId: string | undefined,
): Promise<Result<RunTarget>> => {
  if (runId !== undefined && name === undefined) return { ok: true, value: { runId } };
  if (name === undefined || runId !== undefined) {
    return { ok: false, error: "pass a run name or --run-id, not both" };
  }
  const root = await resolveRoot(undefined);
  return root.ok ? { ok: true, value: { name, root: root.value } } : root;
};

const attachArgv = async (
  registry: Registry,
  target: RunTarget,
): Promise<Result<readonly string[]>> => {
  const run = await findRunByIdOrName(registry, target);
  if (!run.ok) return run;
  const { id, terminal } = run.value;
  if (terminal === null) return { ok: false, error: `run ${id} has no terminal yet` };
  return { ok: true, value: harnessTmux().attachCommand(terminal) };
};

export const attachCommand = () =>
  new Command("attach")
    .description("Attach to a run's terminal")
    .argument("[name]", "run name in this repo")
    .option("--run-id <id>", "attach by run id instead of name")
    .option("--print", "print the attach command instead of running it")
    .action(async (name, opts) => {
      const target = await pickTarget(name, opts.runId);
      if (!target.ok) return fail(target.error);
      const argv = await attachArgv(createRegistry(registryPath()), target.value);
      if (!argv.ok) return fail(argv.error);
      if (opts.print === true) {
        console.log(argv.value.join(" "));
        return;
      }
      const [command, ...args] = argv.value;
      const exitCode = await spawnInteractive(command as string, args, {
        cwd: process.cwd(),
        env: { TMUX: undefined },
      });
      commandLog("attach").info({ ...target.value, exitCode }, "detached from the session");
      process.exitCode = exitCode;
    });
