import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfigOrDefault } from "./config.ts";
import type { Result } from "./contracts.ts";
import { type RunRef, runDirOf } from "./events.ts";
import { createGit } from "./git.ts";
import type { RegistryReader, WorkflowRun } from "./registry.ts";

const git = createGit();

const metaRepoOf = async (repo: string, dir: string): Promise<string | undefined> => {
  const parent = dirname(dir);
  if (parent === dir) return undefined;
  const config = await loadConfigOrDefault(parent);
  const claims =
    config.ok &&
    config.value.workspace.layout === "multi" &&
    Object.values(config.value.packages).some((pkg) => resolve(parent, pkg.path) === repo);
  return claims ? parent : metaRepoOf(repo, parent);
};

// The common git dir is shared by every worktree, so its parent is the main checkout wherever cwd is.
export const findRoot = async (cwd: string): Promise<Result<string>> => {
  const commonDir = await git.commonDir(cwd);
  if (commonDir === null) {
    return { ok: false, error: "not inside a git repo; run from one or pass --root" };
  }
  const main = dirname(commonDir);
  return { ok: true, value: (await metaRepoOf(main, main)) ?? main };
};

// With no --root, a script works from the main checkout, even inside a workspace worktree:
// that is where runs live.
export const resolveRoot = (root: string | undefined): Promise<Result<string>> =>
  root === undefined
    ? findRoot(process.cwd())
    : Promise.resolve({ ok: true, value: resolve(root) });

export type RunLookup = Readonly<{ registry: RegistryReader; root: string; name: string }>;

// Every action after init names its run by spec name; the folder must still exist, since
// writing to it would recreate a run folder with no workflow.started.
// harness run saves the folder it started in, which can be a linked worktree or a multi-layout
// sub-repo, so a run belongs to the root its own folder resolves to.
const belongsTo = async (run: WorkflowRun, root: string): Promise<boolean> => {
  if (run.cwd === root) return true;
  const runRoot = await findRoot(run.cwd);
  return runRoot.ok && runRoot.value === root;
};

export const resolveRun = async ({ registry, root, name }: RunLookup): Promise<Result<RunRef>> => {
  const named = await registry.findRunsByName(name);
  const owned = await Promise.all(named.map((candidate) => belongsTo(candidate, root)));
  const run = named.find((_, index) => owned[index]);
  if (run === undefined) {
    return {
      ok: false,
      error: `no run named "${name}" in ${root}; start one with orchestrate init`,
    };
  }
  const dir = runDirOf(run.cwd, name);
  if (!existsSync(dir)) return { ok: false, error: `${dir} no longer exists` };
  return { ok: true, value: { id: run.id, cwd: run.cwd, name } };
};
