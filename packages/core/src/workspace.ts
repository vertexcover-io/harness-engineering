import { existsSync, realpathSync } from "node:fs";
import { rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { createGit, type ILogger, noopLogger, spawn } from "@harness/sdk";
import * as z from "zod";
import { type Config, LayoutSchema, loadConfigOrDefault, NameSchema } from "./config.ts";
import { type JsonValue, NonEmptyStringSchema, type Result, SlugSchema } from "./contracts.ts";
import { type EventError, eventError, type RunRef, stackOf } from "./events.ts";
import { emitRunEvent, toRepoId } from "./state.ts";

type Layout = Config["workspace"]["layout"];
type Package = Config["packages"][string];

// request is the run's prompt or ticket text; only the select-repos reference reads it.
export const CreateWorkspaceInputSchema = z.strictObject({
  specName: SlugSchema,
  request: NonEmptyStringSchema.optional(),
  baseBranch: NonEmptyStringSchema.optional(),
  repos: z.array(NameSchema).min(1).optional(),
});

export const CreateWorkspaceOutputSchema = z.strictObject({
  layout: LayoutSchema,
  branch: NonEmptyStringSchema,
  workspaceDir: NonEmptyStringSchema,
  repos: z.array(z.strictObject({ name: NonEmptyStringSchema, worktreeDir: NonEmptyStringSchema })),
});

export type OutputLine = Readonly<{ repo: string; text: string }>;

// With a run, the command records its events in that run's log; without one, it records none.
export type WorkspaceOptions = Readonly<{
  run?: RunRef | undefined;
  root: string;
  branch: string;
  repos?: readonly string[] | undefined;
  base?: string | undefined;
  force?: boolean | undefined;
  onOutput?: ((line: OutputLine) => void) | undefined;
  log?: ILogger | undefined;
}>;

type RepoDirs = Readonly<{ name: string; worktreeDir: string; checkoutDir: string }>;
type ReadyRepo = RepoDirs & Readonly<{ status: "ready"; baseBranch: string; startSha: string }>;
type RemovedRepo = RepoDirs & Readonly<{ status: "removed" }>;
type FailedRepo = RepoDirs & Readonly<{ status: "failed"; error: EventError }>;
export type RepoOutcome = ReadyRepo | RemovedRepo | FailedRepo;

// eventError is set when the work was done but its event could not be recorded in the run.
export type WorkspaceReport = Readonly<{
  layout: Layout;
  branch: string;
  workspaceDir: string;
  repos: readonly RepoOutcome[];
  eventError?: string;
}>;

type RepoPlan = Readonly<{
  name: string;
  checkoutDir: string;
  worktreeDir: string;
  setup: string | undefined;
  teardown: string | undefined;
}>;

type Plan = Omit<WorkspaceReport, "repos"> & Readonly<{ repos: readonly RepoPlan[] }>;

const STDERR_TAIL = 300;
const EVENT_SOURCE = "orchestrate";

const DEFAULT_PATHS: Readonly<Record<Layout, string>> = {
  mono: ".worktrees/{{ branch }}",
  multi: ".workspaces/{{ branch }}",
};

const git = createGit();

// A package's own command wins over the shared one, and null opts the package out of it.
const packageCommand = (
  pkg: Package,
  key: "workspaceSetup" | "workspaceTeardown",
  shared: string | undefined,
): string | undefined =>
  Object.hasOwn(pkg.commands, key) ? (pkg.commands[key] ?? undefined) : shared;

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

const fillPath = (template: string, branch: string): Result<string> => {
  const filled = template.replace(/\{\{\s*branch\s*\}\}/g, branch.replaceAll("/", "-"));
  const unknown = filled.match(/\{\{.*?\}\}/)?.[0];
  if (unknown === undefined) return { ok: true, value: filled };
  return {
    ok: false,
    error: `workspace.path: unknown placeholder ${unknown}; only {{ branch }} is supported`,
  };
};

type Location = Readonly<{
  config: Config;
  layout: Layout;
  branch: string;
  workspaceDir: string;
}>;

const planMono = (location: Location, options: WorkspaceOptions): Result<Plan> => {
  if (options.repos !== undefined) {
    return { ok: false, error: "--repos needs workspace.layout multi; this repo is mono" };
  }
  const misplaced = Object.entries(location.config.packages).find(
    ([, pkg]) =>
      Object.hasOwn(pkg.commands, "workspaceSetup") ||
      Object.hasOwn(pkg.commands, "workspaceTeardown"),
  );
  if (misplaced !== undefined) {
    return {
      ok: false,
      error: `packages.${misplaced[0]}: commands.workspaceSetup and commands.workspaceTeardown need workspace.layout multi; use workspace.setup and workspace.teardown`,
    };
  }
  const { setup, teardown } = location.config.workspace;
  const { branch, workspaceDir } = location;
  const repo = {
    name: basename(options.root),
    checkoutDir: options.root,
    worktreeDir: workspaceDir,
    setup,
    teardown,
  };
  return { ok: true, value: { layout: "mono", branch, workspaceDir, repos: [repo] } };
};

type Command = "create" | "add" | "remove";

const planMulti = (
  location: Location,
  options: WorkspaceOptions,
  command: Command,
): Result<Plan> => {
  const { config, branch, workspaceDir } = location;
  const known = Object.keys(config.packages);
  const names = options.repos ?? (command === "remove" ? known : []);
  if (names.length === 0) {
    return { ok: false, error: "workspace.layout multi needs --repos to name the repos to branch" };
  }
  const unknown = names.find((name) => !known.includes(name));
  if (unknown !== undefined) {
    return { ok: false, error: `unknown repo "${unknown}"; packages are: ${known.join(", ")}` };
  }
  const repos = Object.entries(config.packages)
    .filter(([name]) => names.includes(name))
    .map(([name, pkg]) => ({
      name,
      checkoutDir: resolve(options.root, pkg.path),
      worktreeDir: resolve(workspaceDir, pkg.path),
      setup: packageCommand(pkg, "workspaceSetup", config.workspace.setup),
      teardown: packageCommand(pkg, "workspaceTeardown", config.workspace.teardown),
    }));
  return { ok: true, value: { layout: "multi", branch, workspaceDir, repos } };
};

const planRepos = (location: Location, options: WorkspaceOptions, command: Command) =>
  location.layout === "mono" ? planMono(location, options) : planMulti(location, options, command);

const locateWorkspace = async (options: WorkspaceOptions): Promise<Result<Location>> => {
  if (!(await git.isValidBranchName(options.root, options.branch))) {
    return { ok: false, error: `invalid branch name "${options.branch}"` };
  }
  if (options.base !== undefined && !(await git.isValidBranchName(options.root, options.base))) {
    return { ok: false, error: `invalid base "${options.base}"` };
  }
  const config = await loadConfigOrDefault(options.root);
  if (!config.ok) return config;
  const { layout, path } = config.value.workspace;
  const filled = fillPath(path ?? DEFAULT_PATHS[layout], options.branch);
  if (!filled.ok) return filled;
  const workspaceDir = resolve(options.root, filled.value);
  return {
    ok: true,
    value: { config: config.value, layout, branch: options.branch, workspaceDir },
  };
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
  if (!(await isRepoRoot(repo.checkoutDir))) {
    return `${repo.name}: ${repo.checkoutDir} is not the root of a git repo`;
  }
  if (existsSync(repo.worktreeDir)) return `${repo.worktreeDir} already exists`;
  const owners = [...new Set([...gitRoots, repo.checkoutDir])];
  const problems = await Promise.all(owners.map((owner) => checkIgnored(repo.worktreeDir, owner)));
  return problems.find((problem) => problem !== undefined);
};

const checkRepos = async (plan: Plan, root: string): Promise<string | undefined> => {
  const gitRoots = (await isRepoRoot(root)) ? [root] : [];
  const problems = await Promise.all(plan.repos.map((repo) => checkRepo(repo, gitRoots)));
  return problems.find((problem) => problem !== undefined);
};

const refused = (error: string): Result<never> => ({ ok: false, error });

const precheckAdd = async (
  location: Location,
  options: WorkspaceOptions,
): Promise<Result<Plan>> => {
  if (location.layout === "mono") {
    return refused("workspace add needs workspace.layout multi; a mono workspace is its one repo");
  }
  if (!existsSync(location.workspaceDir)) {
    return refused(
      `no workspace at ${location.workspaceDir}; create it with orchestrate workspace create`,
    );
  }
  const planned = planMulti(location, options, "add");
  if (!planned.ok) return planned;
  const problem = await checkRepos(planned.value, options.root);
  return problem === undefined ? planned : refused(problem);
};

const precheckCreate = async (
  location: Location,
  options: WorkspaceOptions,
): Promise<Result<Plan>> => {
  if (existsSync(location.workspaceDir)) return refused(`${location.workspaceDir} already exists`);
  const planned = planRepos(location, options, "create");
  if (!planned.ok) return planned;
  const problem = await checkRepos(planned.value, options.root);
  return problem === undefined ? planned : refused(problem);
};

const runHook = async (
  hook: "setup" | "teardown",
  repo: RepoPlan,
  plan: Plan,
  onOutput: WorkspaceOptions["onOutput"],
): Promise<string | Error | undefined> => {
  const command = repo[hook];
  if (command === undefined) return undefined;
  const env = {
    WORKTREE_PATH: repo.worktreeDir,
    PRIMARY_WORKTREE_PATH: repo.checkoutDir,
    BRANCH_NAME: plan.branch,
    REPO_NAME: repo.name,
    WORKSPACE_PATH: plan.workspaceDir,
  };
  const onLine = (text: string): void => onOutput?.({ repo: repo.name, text });
  const run = await spawn("sh", ["-c", command], {
    cwd: repo.worktreeDir,
    env,
    onStdout: onLine,
    onStderr: onLine,
  }).catch((error: unknown) => new Error(`${hook} "${command}" could not start`, { cause: error }));
  if (run instanceof Error) return run;
  if (run.code === 0) return undefined;
  return `${hook} "${command}" failed with exit code ${run.code}\n${run.stderr.trim().slice(-STDERR_TAIL)}`.trim();
};

const dirsOf = (repo: RepoPlan): RepoDirs => ({
  name: repo.name,
  worktreeDir: repo.worktreeDir,
  checkoutDir: repo.checkoutDir,
});

const failed = (repo: RepoPlan, kind: string, problem: string | Error): FailedRepo => ({
  ...dirsOf(repo),
  status: "failed",
  error:
    typeof problem === "string"
      ? eventError(kind, problem, undefined)
      : eventError(kind, problem.message, stackOf(problem)),
});

// With no origin/HEAD (no origin, or a CI clone that never set it), the checkout's own branch is the base.
const defaultBase = async (checkoutDir: string): Promise<Result<string>> => {
  const origin = await git.defaultBranch(checkoutDir);
  return origin === null ? git.currentBranch(checkoutDir) : { ok: true, value: origin };
};

// Fetch, never pull: a pull merges into the checkout's working files, a fetch only moves origin/BASE.
// A base origin doesn't have (a local branch, a commit id) is used as it is.
const startPoint = async (checkoutDir: string, base: string): Promise<Result<string>> => {
  if (!(await git.hasRemote(checkoutDir, "origin"))) return { ok: true, value: base };
  const onOrigin = await git.remoteHasBranch(checkoutDir, "origin", base);
  if (!onOrigin.ok) return onOrigin;
  if (!onOrigin.value) return { ok: true, value: base };
  const fetched = await git.fetch(checkoutDir, { remote: "origin", ref: base });
  return fetched.ok ? { ok: true, value: `origin/${base}` } : fetched;
};

// A rerun checks out its existing branch as is: resetting it would discard the earlier attempt's commits.
const addWorktree = async (
  repo: RepoPlan,
  branch: string,
  base: string,
): Promise<FailedRepo | undefined> => {
  const { checkoutDir, worktreeDir } = repo;
  if (await git.branchExists(checkoutDir, branch)) {
    const added = await git.addWorktree(checkoutDir, { path: worktreeDir, branch });
    return added.ok ? undefined : failed(repo, "add", added.error);
  }
  const start = await startPoint(checkoutDir, base);
  if (!start.ok) return failed(repo, "fetch", start.error);
  const added = await git.addWorktree(checkoutDir, {
    path: worktreeDir,
    branch,
    base: start.value,
  });
  return added.ok ? undefined : failed(repo, "add", added.error);
};

const createOne = async (
  repo: RepoPlan,
  plan: Plan,
  options: WorkspaceOptions,
  log: ILogger,
): Promise<ReadyRepo | FailedRepo> => {
  const baseBranch =
    options.base === undefined
      ? await defaultBase(repo.checkoutDir)
      : { ok: true as const, value: options.base };
  if (!baseBranch.ok) return failed(repo, "add", baseBranch.error);
  const addFailure = await addWorktree(repo, plan.branch, baseBranch.value);
  if (addFailure !== undefined) {
    log.error(
      { repo: repo.name, err: addFailure.error },
      `workspace ${addFailure.error.kind} failed`,
    );
    return addFailure;
  }
  log.debug({ repo: repo.name, worktreeDir: repo.worktreeDir }, "worktree added");
  const startSha = await git.headSha(repo.worktreeDir);
  if (!startSha.ok) return failed(repo, "add", startSha.error);
  const setup = await runHook("setup", repo, plan, options.onOutput);
  if (setup !== undefined) {
    log.error({ repo: repo.name, err: setup }, "worktree added, but its setup command failed");
    return failed(repo, "setup", setup);
  }
  log.info({ repo: repo.name, worktreeDir: repo.worktreeDir }, "worktree ready");
  return {
    ...dirsOf(repo),
    status: "ready",
    baseBranch: baseBranch.value,
    startSha: startSha.value,
  };
};

const logFor = (options: WorkspaceOptions): ILogger =>
  (options.log ?? noopLogger).child({ component: "workspace", branch: options.branch });

// Records one event in the run; resolves to why it was not recorded, or undefined when it was
// or when there is no run to record into.
const emit = async (
  run: RunRef | undefined,
  type: string,
  payload: JsonValue,
): Promise<string | undefined> => {
  if (run === undefined) return undefined;
  const stored = await emitRunEvent(run, { type, payload, source: EVENT_SOURCE });
  return stored.ok ? undefined : stored.error;
};

const reported = (
  report: WorkspaceReport,
  eventErrors: readonly (string | undefined)[],
): Result<WorkspaceReport> => {
  const errors = [...new Set(eventErrors.filter((error) => error !== undefined))];
  return {
    ok: true,
    value: errors.length === 0 ? report : { ...report, eventError: errors.join("; ") },
  };
};

const repositoryEntry = (repo: ReadyRepo) => ({
  name: repo.name,
  worktreeDir: repo.worktreeDir,
  checkoutDir: repo.checkoutDir,
  baseBranch: repo.baseBranch,
  startSha: repo.startSha,
});

const errorsOf = (repos: readonly RepoOutcome[]) =>
  repos.flatMap((repo) =>
    repo.status === "failed" ? [{ repoId: toRepoId(repo.name), ...repo.error }] : [],
  );

// A create where any repo failed is a failure; the repos that came up stay on disk.
const emitCreated = (
  run: RunRef | undefined,
  plan: Plan,
  repos: readonly (ReadyRepo | FailedRepo)[],
): Promise<string | undefined> => {
  const { layout, branch, workspaceDir } = plan;
  const errors = errorsOf(repos);
  if (errors.length > 0) {
    return emit(run, "workspace.create-failed", { workspaceDir, branch, errors });
  }
  const repositories = Object.fromEntries(
    repos.flatMap((repo) =>
      repo.status === "ready" ? [[toRepoId(repo.name), repositoryEntry(repo)]] : [],
    ),
  );
  return emit(run, "workspace.created", { layout, branch, workspaceDir, repositories });
};

export const createWorkspace = async (
  options: WorkspaceOptions,
): Promise<Result<WorkspaceReport>> => {
  const log = logFor(options);
  const located = await locateWorkspace(options);
  if (!located.ok) return located;
  const planned = await precheckCreate(located.value, options);
  if (!planned.ok) return planned;
  const plan = planned.value;
  const repos = await Promise.all(plan.repos.map((repo) => createOne(repo, plan, options, log)));
  const eventError = await emitCreated(options.run, plan, repos);
  return reported({ ...plan, repos }, [eventError]);
};

const addOne = async (repo: RepoPlan, plan: Plan, options: WorkspaceOptions, log: ILogger) => {
  const outcome = await createOne(repo, plan, options, log);
  const { workspaceDir, branch } = plan;
  const repoId = toRepoId(repo.name);
  const eventError =
    outcome.status === "ready"
      ? await emit(options.run, "workspace.repository.added", {
          workspaceDir,
          branch,
          repoId,
          repository: repositoryEntry(outcome),
        })
      : await emit(options.run, "workspace.repository.add-failed", {
          workspaceDir,
          branch,
          repoId,
          ...dirsOf(repo),
          error: outcome.error,
        });
  return { outcome, eventError };
};

export const addRepositories = async (
  options: WorkspaceOptions,
): Promise<Result<WorkspaceReport>> => {
  const log = logFor(options);
  const located = await locateWorkspace(options);
  if (!located.ok) return located;
  const planned = await precheckAdd(located.value, options);
  if (!planned.ok) return planned;
  const plan = planned.value;
  const added = await Promise.all(plan.repos.map((repo) => addOne(repo, plan, options, log)));
  const repos = added.map((result) => result.outcome);
  return reported(
    { ...plan, repos },
    added.map((result) => result.eventError),
  );
};

// Branch names map to paths lossily (feat/a and feat-a share one), so trust git's own record.
const linkedBranches = async (source: string): Promise<ReadonlyMap<string, string>> => {
  const list = await git.listWorktrees(source);
  if (!list.ok) return new Map();
  const [, ...linked] = list.value;
  return new Map(linked.map((entry) => [entry.path, entry.branch ?? ""] as const));
};

const checkRemovable = async (repo: RepoPlan, branch: string): Promise<string | undefined> => {
  if (!existsSync(repo.worktreeDir)) return `no worktree at ${repo.worktreeDir}`;
  const found = (await linkedBranches(repo.checkoutDir)).get(realpathSync(repo.worktreeDir));
  if (found === undefined)
    return `${repo.worktreeDir} is not a linked worktree of ${repo.checkoutDir}`;
  if (found !== branch) return `${repo.worktreeDir} is on branch "${found}", not "${branch}"`;
  return undefined;
};

const removeOne = async (
  repo: RepoPlan,
  plan: Plan,
  options: WorkspaceOptions,
  log: ILogger,
): Promise<RemovedRepo | FailedRepo> => {
  const torn = await runHook("teardown", repo, plan, options.onOutput);
  if (torn !== undefined) {
    log.error({ repo: repo.name, err: torn }, "teardown command failed; worktree left in place");
    return failed(repo, "teardown", torn);
  }
  const removed = await git.removeWorktree(repo.checkoutDir, repo.worktreeDir, {
    force: options.force === true,
  });
  if (!removed.ok) {
    log.error({ repo: repo.name, err: removed.error }, "git worktree remove failed");
    return failed(repo, "remove", removed.error);
  }
  log.info({ repo: repo.name, worktreeDir: repo.worktreeDir }, "worktree removed");
  return { ...dirsOf(repo), status: "removed" };
};

const removeNamedOne = async (
  repo: RepoPlan,
  plan: Plan,
  options: WorkspaceOptions,
  log: ILogger,
) => {
  const outcome = await removeOne(repo, plan, options, log);
  const { workspaceDir, branch } = plan;
  const payload = {
    workspaceDir,
    branch,
    repoId: toRepoId(repo.name),
    name: repo.name,
    worktreeDir: repo.worktreeDir,
  };
  const eventError =
    outcome.status === "removed"
      ? await emit(options.run, "workspace.repository.removed", payload)
      : await emit(options.run, "workspace.repository.remove-failed", {
          ...payload,
          error: outcome.error,
        });
  return { outcome, eventError };
};

const emitRemoved = (
  run: RunRef | undefined,
  plan: Plan,
  repos: readonly (RemovedRepo | FailedRepo)[],
): Promise<string | undefined> => {
  const { workspaceDir, branch } = plan;
  const errors = errorsOf(repos);
  if (errors.length > 0)
    return emit(run, "workspace.remove-failed", { workspaceDir, branch, errors });
  const repositories = repos.map((repo) => toRepoId(repo.name));
  return emit(run, "workspace.removed", { workspaceDir, branch, repositories });
};

export const removeWorkspace = async (
  options: WorkspaceOptions,
): Promise<Result<WorkspaceReport>> => {
  const log = logFor(options);
  const located = await locateWorkspace(options);
  if (!located.ok) return located;
  const planned = planRepos(located.value, options, "remove");
  if (!planned.ok) return planned;
  const plan = planned.value;
  const targets =
    options.repos === undefined
      ? plan.repos.filter((repo) => existsSync(repo.worktreeDir))
      : plan.repos;
  if (targets.length === 0) {
    return { ok: false, error: `no workspace for branch "${plan.branch}" at ${plan.workspaceDir}` };
  }
  // Every target is checked before any teardown, so a refused remove touches nothing and records nothing.
  const problems = await Promise.all(targets.map((repo) => checkRemovable(repo, plan.branch)));
  const problem = problems.find((found) => found !== undefined);
  if (problem !== undefined) return { ok: false, error: problem };
  // Naming repos removes those repos; naming none removes the workspace, even if some fail.
  if (options.repos !== undefined) {
    const removed = await Promise.all(
      targets.map((repo) => removeNamedOne(repo, plan, options, log)),
    );
    return reported(
      { ...plan, repos: removed.map((result) => result.outcome) },
      removed.map((result) => result.eventError),
    );
  }
  const repos = await Promise.all(targets.map((repo) => removeOne(repo, plan, options, log)));
  // rmdir only succeeds on an empty folder, so a workspace with repos left in it stays.
  if (plan.layout === "multi") await rmdir(plan.workspaceDir).catch(() => undefined);
  return reported({ ...plan, repos }, [await emitRemoved(options.run, plan, repos)]);
};

export type WorkspaceInfo = Readonly<{
  layout: Layout;
  packages: readonly Readonly<{ name: string; path: string; description?: string }>[];
}>;

export const workspaceInfo = async (root: string): Promise<Result<WorkspaceInfo>> => {
  const config = await loadConfigOrDefault(root);
  if (!config.ok) return config;
  const packages = Object.entries(config.value.packages).map(([name, pkg]) => ({
    name,
    path: pkg.path,
    ...(pkg.description === undefined ? {} : { description: pkg.description }),
  }));
  return { ok: true, value: { layout: config.value.workspace.layout, packages } };
};
