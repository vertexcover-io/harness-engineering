import { Command } from "@commander-js/extra-typings";
import {
  createWorktrees,
  findRoot,
  type Result,
  removeWorktrees,
  type WorktreeOptions,
  type WorktreeReport,
} from "@harness/core";
import { cliLog, commandLog, fail } from "./client.ts";

const splitList = (value: string): string[] =>
  value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");

const report = (result: Result<WorktreeReport>): void => {
  if (!result.ok) {
    fail(result.error);
    return;
  }
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  const failed = result.value.repos.filter((repo) => repo.status === "failed");
  commandLog("worktree").debug(
    { branch: result.value.branch, repos: result.value.repos.length, failed: failed.length },
    "worktree command finished",
  );
  if (failed.length > 0) process.exitCode = 1;
};

const run = async (
  command: typeof createWorktrees,
  flags: Omit<WorktreeOptions, "root" | "onOutput"> & { root?: string },
): Promise<void> => {
  const root: Result<string> =
    flags.root === undefined ? await findRoot(process.cwd()) : { ok: true, value: flags.root };
  if (!root.ok) return report(root);
  const onOutput: WorktreeOptions["onOutput"] = (line) =>
    process.stderr.write(`[${line.repo}] ${line.text}\n`);
  const log = cliLog();
  report(await command({ ...flags, root: root.value, onOutput, log }));
};

export const worktreeCommand = () => {
  const worktree = new Command("worktree").description(
    "Create and remove git worktrees, running the project's setup and teardown",
  );
  worktree
    .command("create")
    .argument("<branch>", "branch to create or check out")
    .option("--repos <names>", "multi layout: comma-separated packages to branch", splitList)
    .option("--base <ref>", "commit a new branch starts from (default: HEAD)")
    .option("--root <dir>", "repo holding orchestrate.config.json (default: main checkout)")
    .action((branch, flags) => run(createWorktrees, { ...flags, branch }));
  worktree
    .command("remove")
    .argument("<branch>", "branch whose worktrees to remove")
    .option("--repos <names>", "multi layout: comma-separated packages (default: all)", splitList)
    .option("--force", "remove worktrees with uncommitted or untracked files")
    .option("--root <dir>", "repo holding orchestrate.config.json (default: main checkout)")
    .action((branch, flags) => run(removeWorktrees, { ...flags, branch }));
  return worktree;
};
