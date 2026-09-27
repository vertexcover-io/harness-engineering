import { existsSync, realpathSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createGit, type ILogger, noopLogger, type SpawnEnv, spawn } from "@harness/sdk";
import { type Config, ConfigSchema, loadConfig } from "./config.ts";
import type { Result } from "./contracts.ts";

type Worktree = NonNullable<Config["worktree"]>;
type Layout = Worktree["layout"];
type Package = Config["packages"][string];

export type OutputLine = Readonly<{ repo: string; text: string }>;

export type WorktreeOptions = Readonly<{
  root: string;
  branch: string;
  repos?: readonly string[] | undefined;
  base?: string | undefined;
  force?: boolean | undefined;
  onOutput?: ((line: OutputLine) => void) | undefined;
  log?: ILogger | undefined;
}>;

export type RepoOutcome = Readonly<{
  name: string;
  path: string;
  status: "ready" | "removed" | "failed";
  failedAt?: "add" | "setup" | "teardown" | "remove";
  error?: string;
}>;

export type WorktreeReport = Readonly<{
  layout: Layout;
  branch: string;
  workspace: string;
  repos: readonly RepoOutcome[];
}>;

type RepoPlan = Readonly<{
  name: string;
  source: string;
  path: string;
  setup: string | undefined;
  teardown: string | undefined;
}>;

type Plan = Omit<WorktreeReport, "repos"> & Readonly<{ repos: readonly RepoPlan[] }>;

type Run = Readonly<{ code: number; stdout: string; stderr: string }>;

const DEFAULT_PATHS: Readonly<Record<Layout, string>> = {
  mono: ".worktrees/{{ branch }}",
  multi: ".workspaces/{{ branch }}",
};

const exec = (
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env?: SpawnEnv; onLine?: (text: string) => void }>,
): Promise<Run> =>
  spawn(command, args, {
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.onLine === undefined ? {} : { onStdout: options.onLine, onStderr: options.onLine }),
  });

const git = createGit();

// A repo with no config file still gets plain worktrees; any other config problem stops the command.
const readConfig = async (root: string): Promise<Result<Config>> => {
  const loaded = await loadConfig(root);
  if (loaded.ok) return loaded;
  if (loaded.error.code === "CONFIG_MISSING") {
    return { ok: true, value: ConfigSchema.parse({ version: 2 }) };
  }
  return { ok: false, error: loaded.error.message };
};

const worktreeOf = (config: Config): Worktree => config.worktree ?? { layout: "mono" };

// A package's own command wins over the shared one, and null opts the package out of it.
const packageCommand = (
  pkg: Package,
  key: "worktreeSetup" | "worktreeTeardown",
  shared: string | undefined,
): string | undefined =>
  Object.hasOwn(pkg.commands, key) ? (pkg.commands[key] ?? undefined) : shared;

const metaRepoOf = async (repo: string, dir: string): Promise<string | undefined> => {
  const parent = dirname(dir);
  if (parent === dir) return undefined;
  const config = await readConfig(parent);
  const claims =
    config.ok &&
    config.value.worktree?.layout === "multi" &&
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

const fillPath = (template: string, branch: string): Result<string> => {
  const filled = template.replace(/\{\{\s*branch\s*\}\}/g, branch.replaceAll("/", "-"));
  const unknown = filled.match(/\{\{.*?\}\}/)?.[0];
  if (unknown === undefined) return { ok: true, value: filled };
  return {
    ok: false,
    error: `worktree.path: unknown placeholder ${unknown}; only {{ branch }} is supported`,
  };
};

const planMono = (config: Config, options: WorktreeOptions, workspace: string): Result<Plan> => {
  if (options.repos !== undefined) {
    return { ok: false, error: "--repos needs worktree.layout multi; this repo is mono" };
  }
  const misplaced = Object.entries(config.packages).find(
    ([, pkg]) =>
      Object.hasOwn(pkg.commands, "worktreeSetup") ||
      Object.hasOwn(pkg.commands, "worktreeTeardown"),
  );
  if (misplaced !== undefined) {
    return {
      ok: false,
      error: `packages.${misplaced[0]}: commands.worktreeSetup and commands.worktreeTeardown need worktree.layout multi; use worktree.setup and worktree.teardown`,
    };
  }
  const { setup, teardown } = worktreeOf(config);
  const repo = {
    name: basename(options.root),
    source: options.root,
    path: workspace,
    setup,
    teardown,
  };
  return { ok: true, value: { layout: "mono", branch: options.branch, workspace, repos: [repo] } };
};

type Command = "create" | "remove";

const planMulti = (
  config: Config,
  options: WorktreeOptions,
  workspace: string,
  command: Command,
): Result<Plan> => {
  const known = Object.keys(config.packages);
  const names = options.repos ?? (command === "remove" ? known : []);
  if (names.length === 0) {
    return { ok: false, error: "worktree.layout multi needs --repos to name the repos to branch" };
  }
  const unknown = names.find((name) => !known.includes(name));
  if (unknown !== undefined) {
    return { ok: false, error: `unknown repo "${unknown}"; packages are: ${known.join(", ")}` };
  }
  const repos = Object.entries(config.packages)
    .filter(([name]) => names.includes(name))
    .map(([name, pkg]) => ({
      name,
      source: resolve(options.root, pkg.path),
      path: resolve(workspace, pkg.path),
      setup: packageCommand(pkg, "worktreeSetup", worktreeOf(config).setup),
      teardown: packageCommand(pkg, "worktreeTeardown", worktreeOf(config).teardown),
    }));
  return { ok: true, value: { layout: "multi", branch: options.branch, workspace, repos } };
};

const planWorktrees = async (options: WorktreeOptions, command: Command): Promise<Result<Plan>> => {
  if (!(await git.isValidBranchName(options.root, options.branch))) {
    return { ok: false, error: `invalid branch name "${options.branch}"` };
  }
  const config = await readConfig(options.root);
  if (!config.ok) return config;
  const { layout, path } = worktreeOf(config.value);
  const filled = fillPath(path ?? DEFAULT_PATHS[layout], options.branch);
  if (!filled.ok) return filled;
  const workspace = resolve(options.root, filled.value);
  return layout === "mono"
    ? planMono(config.value, options, workspace)
    : planMulti(config.value, options, workspace, command);
};

const isRepoRoot = async (dir: string): Promise<boolean> => {
  if (!existsSync(dir)) return false;
  const top = await git.repoRoot(dir);
  return top !== null && realpathSync(top) === realpathSync(dir);
};

const isInside = (path: string, dir: string): boolean => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

const checkIgnored = async (path: string, owner: string): Promise<string | undefined> => {
  if (!isInside(path, owner)) return undefined;
  if (await git.isIgnored(owner, relative(owner, path))) return undefined;
  return `${path} is inside ${owner} but not ignored by git; add it to .gitignore`;
};

const checkRepo = async (
  repo: RepoPlan,
  gitRoots: readonly string[],
): Promise<string | undefined> => {
  if (!(await isRepoRoot(repo.source))) {
    return `${repo.name}: ${repo.source} is not the root of a git repo`;
  }
  if (existsSync(repo.path)) return `${repo.path} already exists`;
  const owners = [...new Set([...gitRoots, repo.source])];
  const problems = await Promise.all(owners.map((owner) => checkIgnored(repo.path, owner)));
  return problems.find((problem) => problem !== undefined);
};

const checkCreate = async (plan: Plan, root: string): Promise<string | undefined> => {
  const gitRoots = (await isRepoRoot(root)) ? [root] : [];
  const problems = await Promise.all(plan.repos.map((repo) => checkRepo(repo, gitRoots)));
  return problems.find((problem) => problem !== undefined);
};

const runHook = async (
  hook: "setup" | "teardown",
  repo: RepoPlan,
  plan: Plan,
  onOutput: WorktreeOptions["onOutput"],
): Promise<string | undefined> => {
  const command = repo[hook];
  if (command === undefined) return undefined;
  const env = {
    WORKTREE_PATH: repo.path,
    PRIMARY_WORKTREE_PATH: repo.source,
    BRANCH_NAME: plan.branch,
    REPO_NAME: repo.name,
    WORKSPACE_PATH: plan.workspace,
  };
  const onLine = (text: string): void => onOutput?.({ repo: repo.name, text });
  const run = await exec("sh", ["-c", command], { cwd: repo.path, env, onLine });
  return run.code === 0 ? undefined : `${hook} "${command}" failed with exit code ${run.code}`;
};

const done = (repo: RepoPlan, status: "ready" | "removed"): RepoOutcome => ({
  name: repo.name,
  path: repo.path,
  status,
});

const failed = (
  repo: RepoPlan,
  failedAt: NonNullable<RepoOutcome["failedAt"]>,
  error: string,
): RepoOutcome => ({ name: repo.name, path: repo.path, status: "failed", failedAt, error });

const createOne = async (
  repo: RepoPlan,
  plan: Plan,
  options: WorktreeOptions,
  log: ILogger,
): Promise<RepoOutcome> => {
  const added = await git.addWorktree(repo.source, {
    path: repo.path,
    branch: plan.branch,
    base: options.base ?? "HEAD",
  });
  if (!added.ok) {
    log.error({ repo: repo.name, err: added.error }, "git worktree add failed");
    return failed(repo, "add", added.error);
  }
  log.debug({ repo: repo.name, path: repo.path }, "worktree added");
  const setup = await runHook("setup", repo, plan, options.onOutput);
  if (setup !== undefined) {
    log.error({ repo: repo.name, err: setup }, "worktree added, but its setup command failed");
    return failed(repo, "setup", setup);
  }
  log.info({ repo: repo.name, path: repo.path }, "worktree ready");
  return done(repo, "ready");
};

export const createWorktrees = async (
  options: WorktreeOptions,
): Promise<Result<WorktreeReport>> => {
  const log = (options.log ?? noopLogger).child({ component: "worktree", branch: options.branch });
  const planned = await planWorktrees(options, "create");
  if (!planned.ok) return planned;
  const plan = planned.value;
  const problem = await checkCreate(plan, options.root);
  if (problem !== undefined) return { ok: false, error: problem };
  const repos = await Promise.all(plan.repos.map((repo) => createOne(repo, plan, options, log)));
  return { ok: true, value: { ...plan, repos } };
};

// Branch names map to paths lossily (feat/a and feat-a share one), so trust git's own record.
const linkedBranches = async (source: string): Promise<ReadonlyMap<string, string>> => {
  const list = await git.listWorktrees(source);
  if (!list.ok) return new Map();
  const [, ...linked] = list.value;
  return new Map(linked.map((entry) => [entry.path, entry.branch ?? ""] as const));
};

const checkRemovable = async (repo: RepoPlan, branch: string): Promise<string | undefined> => {
  if (!existsSync(repo.path)) return `no worktree at ${repo.path}`;
  const found = (await linkedBranches(repo.source)).get(realpathSync(repo.path));
  if (found === undefined) return `${repo.path} is not a linked worktree of ${repo.source}`;
  if (found !== branch) return `${repo.path} is on branch "${found}", not "${branch}"`;
  return undefined;
};

const removeOne = async (
  repo: RepoPlan,
  plan: Plan,
  options: WorktreeOptions,
  log: ILogger,
): Promise<RepoOutcome> => {
  const problem = await checkRemovable(repo, plan.branch);
  if (problem !== undefined) return failed(repo, "remove", problem);
  const torn = await runHook("teardown", repo, plan, options.onOutput);
  if (torn !== undefined) {
    log.error({ repo: repo.name, err: torn }, "teardown command failed; worktree left in place");
    return failed(repo, "teardown", torn);
  }
  const removed = await git.removeWorktree(repo.source, repo.path, {
    force: options.force === true,
  });
  if (removed.ok) log.info({ repo: repo.name, path: repo.path }, "worktree removed");
  else log.error({ repo: repo.name, err: removed.error }, "git worktree remove failed");
  return removed.ok ? done(repo, "removed") : failed(repo, "remove", removed.error);
};

export const removeWorktrees = async (
  options: WorktreeOptions,
): Promise<Result<WorktreeReport>> => {
  const log = (options.log ?? noopLogger).child({ component: "worktree", branch: options.branch });
  const planned = await planWorktrees(options, "remove");
  if (!planned.ok) return planned;
  const plan = planned.value;
  const targets =
    options.repos === undefined ? plan.repos.filter((repo) => existsSync(repo.path)) : plan.repos;
  if (targets.length === 0) {
    return { ok: false, error: `no worktree for branch "${plan.branch}" at ${plan.workspace}` };
  }
  const repos = await Promise.all(targets.map((repo) => removeOne(repo, plan, options, log)));
  // rmdir only succeeds on an empty folder, so a workspace with repos left in it stays.
  if (plan.layout === "multi") await rmdir(plan.workspace).catch(() => undefined);
  return { ok: true, value: { ...plan, repos } };
};
