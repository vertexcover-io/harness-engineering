import { access, constants } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Check,
  type CheckContext,
  type CheckStatus,
  CheckStatusSchema,
  checkBinary,
  createGit,
  type Exec,
  execWithTimeout,
  fail,
  findConfigRoot,
  type ILogger,
  type LoadedConfig,
  loadConfigAt,
  loadConfigFile,
  NOT_FOUND,
  NonEmptyStringSchema,
  type Notifier,
  noopLogger,
  type Outcome,
  ok,
  type Result,
  warn,
} from "@harness/sdk";
import * as z from "zod";
import { findMissingNotifierKeys } from "./notifier.ts";
import { pickNotifier } from "./notifier-hooks.ts";
import type { DoctorDeclaration } from "./workflow/types.ts";

export const DoctorRowSchema = z.object({
  name: NonEmptyStringSchema,
  status: CheckStatusSchema,
  optional: z.boolean(),
  detail: z.string(),
  fix: z.array(z.string()),
});

export const DoctorReportSchema = z.strictObject({
  results: z.array(DoctorRowSchema),
  failed: z.array(z.string()),
  warned: z.array(z.string()),
});

// What `harness doctor --json` prints: the report plus its verdict line.
export const DoctorJsonSchema = DoctorReportSchema.extend({ verdict: z.string() });

export type DoctorRow = z.infer<typeof DoctorRowSchema>;
export type DoctorReport = z.infer<typeof DoctorReportSchema>;
export type DoctorJson = z.infer<typeof DoctorJsonSchema>;

// A project doctor's rows are untrusted output: a wrongly typed field falls back as in v1.
const ProjectRowSchema = z.object({
  name: NonEmptyStringSchema,
  status: CheckStatusSchema,
  optional: z.boolean().catch(false),
  detail: z.string().catch(""),
  fix: z.array(z.string()).catch([]),
});
const ProjectReportSchema = z.object({ results: z.array(ProjectRowSchema) });

export const DOCTOR_TIMEOUT_MS = 30_000;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const parseJson = (text: string): Result<unknown> => {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
};

const checkGitRepo = async ({ root, exec }: CheckContext): Promise<Outcome> =>
  (await createGit(exec).repoRoot(root)) === null ? fail("not inside a git repository") : ok(root);

const checkHarnessIgnored = async ({ root, exec }: CheckContext): Promise<Outcome> => {
  const ignored = await createGit(exec).isIgnored(root, join(root, ".harness", "probe"));
  return ignored ? ok(".harness/ is gitignored") : fail(".harness/ is not gitignored");
};

// Unlike a run, the doctor reports a missing config instead of using the default one.
const readFoundConfig = async (root: string): Promise<Result<LoadedConfig>> => {
  const folder = await findConfigRoot(root);
  const loaded = await loadConfigFile(folder.ok ? folder.value : root);
  return loaded.ok ? loaded : { ok: false, error: loaded.error.message };
};

// A config that cannot be read at all (a directory in its place) throws; it is a broken config like any other.
const readConfig = async ({ root, config }: CheckContext): Promise<Result<LoadedConfig>> => {
  try {
    return await (config === undefined ? readFoundConfig(root) : loadConfigAt(config));
  } catch (error) {
    return { ok: false, error: `orchestrate config cannot be read: ${errorMessage(error)}` };
  }
};

const checkOrchestrateConfig = async (context: CheckContext): Promise<Outcome> => {
  const config = await readConfig(context);
  return config.ok ? ok(config.value.path) : fail(config.error);
};

const checkGhAuth = async (context: CheckContext): Promise<Outcome> => {
  const { root, exec } = context;
  const installed = await checkBinary("gh")(context);
  if (installed.status !== "ok") return installed;
  if ((await exec("gh", ["auth", "status"], root)).code !== 0) {
    return warn("installed but not authenticated", ["gh auth login"]);
  }
  return ok("authenticated");
};

const checkSamskara = async (context: CheckContext): Promise<Outcome> => {
  const { root, exec } = context;
  const installed = await checkBinary("samskara")(context);
  if (installed.status !== "ok") return installed;
  const status = await exec("samskara", ["status"], root);
  return status.code === 0 && status.stdout.includes("paired as")
    ? ok(`v${installed.detail} paired`)
    : warn(`v${installed.detail} installed but not paired`);
};

// What the run's session will start with; the process environment fills the rest.
type RunEnv = Result<Readonly<Record<string, string>>>;

const checkNotifier = async (
  context: CheckContext,
  workflowNotifier: Notifier | undefined,
  env: RunEnv,
): Promise<Outcome> => {
  const config = await readConfig(context);
  const configNotifier = config.ok ? config.value.config.notifier : undefined;
  const notifier = pickNotifier(workflowNotifier, configNotifier);
  if (notifier?.enabled !== true) return ok("off");
  if (!env.ok) return fail(env.error);
  const missing = findMissingNotifierKeys({ ...process.env, ...env.value });
  if (missing.length === 0) return ok(`${notifier.type} on`);
  return fail(`${notifier.type} on, but ${missing.join(" and ")} not set`);
};

// The notifier a run would use: the workflow's block, else the config's.
export const buildNotifierCheck = (workflowNotifier: Notifier | undefined, env: RunEnv): Check => ({
  name: "notifier",
  fix: [
    "set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID in .env or in the workflow's or config's env",
    "or turn it off in the workflow or the config: notifier: { enabled: false }",
  ],
  run: (context) => checkNotifier(context, workflowNotifier, env),
});

export const CHECKS: readonly Check[] = [
  { name: "git", fix: ["brew install git", "apt install git"], run: checkBinary("git") },
  { name: "git-repo", fix: ["git init", "cd into the repository first"], run: checkGitRepo },
  {
    name: "jq",
    fix: ["brew install jq", "apt install jq", "dnf install jq"],
    run: checkBinary("jq"),
  },
  { name: "curl", fix: ["brew install curl", "apt install curl"], run: checkBinary("curl") },
  {
    name: "harness-gitignored",
    fix: ["echo '.harness/' >> .gitignore", "remove any narrower .harness/* exception"],
    run: checkHarnessIgnored,
  },
  {
    name: "orchestrate-config",
    fix: [
      "keep exactly one v2 config file, orchestrate.config.yaml (version: 2), at the repository root",
    ],
    run: checkOrchestrateConfig,
  },
  {
    name: "gh",
    optional: true,
    fix: ["brew install gh", "apt install gh", "gh auth login"],
    run: checkGhAuth,
  },
  {
    name: "agent-browser",
    fix: ["npm i -g agent-browser", "agent-browser install"],
    run: checkBinary("agent-browser"),
  },
  {
    name: "ffmpeg",
    fix: ["brew install ffmpeg", "apt install ffmpeg", "dnf install ffmpeg"],
    run: checkBinary("ffmpeg", ["-version"]),
  },
  {
    name: "samskara",
    optional: true,
    fix: [
      "npm i -g samskara",
      "samskara init (pairs the CLI, installs the hook, starts the watcher)",
      "samskara enable (turns on capture for this repo)",
    ],
    run: checkSamskara,
  },
];

// Applied in summarize, which every row passes through, so an optional row can never block.
const cap = (status: CheckStatus, optional: boolean): CheckStatus =>
  optional && status === "fail" ? "warn" : status;

const runCheck = async (check: Check, context: CheckContext, log: ILogger): Promise<Outcome> => {
  try {
    return await check.run(context);
  } catch (error) {
    log.error({ check: check.name, err: error }, "doctor check crashed; reported as FAIL");
    return fail(errorMessage(error));
  }
};

export const evaluate = async (
  check: Check,
  context: CheckContext,
  log: ILogger = noopLogger,
): Promise<DoctorRow> => {
  const start = Date.now();
  const { status, detail, fix } = await runCheck(check, context, log);
  log.debug({ check: check.name, status, durationMs: Date.now() - start }, "doctor check finished");
  return {
    name: check.name,
    optional: check.optional === true,
    status,
    detail,
    fix: [...(fix ?? check.fix)],
  };
};

export const summarize = (rows: readonly DoctorRow[]): DoctorReport => {
  const results = rows.map((row) => ({ ...row, status: cap(row.status, row.optional) }));
  return {
    results,
    failed: results.filter((row) => row.status === "fail").map((row) => row.name),
    warned: results.filter((row) => row.status === "warn").map((row) => row.name),
  };
};

export const verdict = (report: DoctorReport): string => {
  if (report.failed.length > 0) return `BLOCKED ${report.failed.join(" ")}`;
  if (report.warned.length > 0) return `DEGRADED ${report.warned.join(" ")}`;
  return "READY";
};

const readDoctorCommand = async (context: CheckContext): Promise<string | null> => {
  const config = await readConfig(context);
  return config.ok ? (config.value.config.doctor ?? null) : null;
};

const parseReport = (stdout: string): readonly DoctorRow[] | null => {
  const json = parseJson(stdout);
  if (!json.ok) return null;
  const parsed = ProjectReportSchema.safeParse(json.value);
  return parsed.success ? parsed.data.results : null;
};

const lastLine = (text: string): string => text.trim().split("\n").at(-1) ?? "";

const projectRow = (status: CheckStatus, detail: string, fix: string): DoctorRow => ({
  name: "project-doctor",
  optional: false,
  status,
  detail,
  fix: [fix],
});

// A doctor that speaks the contract contributes its rows; one that does not is a single row.
export const projectDoctor = async (context: CheckContext): Promise<readonly DoctorRow[]> => {
  const { root, exec } = context;
  const command = await readDoctorCommand(context);
  if (command === null) return [];
  try {
    const { code, stdout } = await exec("sh", ["-c", `${command} --json`], root);
    if (code === NOT_FOUND) {
      return [
        projectRow(
          "fail",
          `command not found: ${command}`,
          `fix the "doctor" entry in the orchestrate config`,
        ),
      ];
    }
    const rows = parseReport(stdout);
    if (rows !== null) return rows;
    return [
      code === 0
        ? projectRow("ok", command, command)
        : projectRow("fail", `exit ${code}: ${lastLine(stdout)}`, command),
    ];
  } catch (error) {
    return [projectRow("fail", errorMessage(error), command)];
  }
};

export type DoctorOptions = {
  readonly cwd: string;
  readonly exec?: Exec;
  // Checks a caller adds, such as a plugin's own tools; their rows follow the built-in ones.
  readonly extraChecks?: readonly Check[];
  readonly log?: ILogger;
  // the config file harness run --config named
  readonly config?: string | undefined;
};

export const runDoctor = async ({
  cwd,
  exec = execWithTimeout(DOCTOR_TIMEOUT_MS),
  extraChecks = [],
  log: parentLog = noopLogger,
  config,
}: DoctorOptions): Promise<DoctorReport> => {
  const log = parentLog.child({ component: "doctor" });
  // Outside a repository the checks still run, against cwd; git-repo reports the problem.
  const root = (await createGit(exec).repoRoot(cwd)) ?? cwd;
  const checks = [...CHECKS, ...extraChecks];
  const context = { root, exec, config };
  const [rows, projectRows] = await Promise.all([
    Promise.all(checks.map((check) => evaluate(check, context, log))),
    projectDoctor(context),
  ]);
  return summarize([...rows, ...projectRows]);
};

const isReadable = (path: string): Promise<boolean> =>
  access(path, constants.R_OK).then(
    () => true,
    () => false,
  );

const isResolvable = (id: string, from: string): boolean => {
  try {
    Bun.resolveSync(id, from);
    return true;
  } catch {
    return false;
  }
};

// env is what the run's session will start with; the process environment fills the rest.
const runDeclared = async (
  { check, key }: DoctorDeclaration,
  root: string,
  env: Result<Readonly<Record<string, string>>>,
): Promise<Outcome> => {
  if (check === "env") {
    if (!env.ok) return fail(env.error);
    return (env.value[key] ?? process.env[key]) ? ok("set") : fail("missing");
  }
  if (check === "binary") {
    const path = Bun.which(key);
    return path === null ? fail("not on PATH") : ok(path);
  }
  if (check === "package") {
    // From the repo root: a run's scripts and modules load their packages from the repo.
    return isResolvable(key, root) ? ok("resolvable") : fail("cannot be resolved");
  }
  const path = resolve(root, key);
  return (await isReadable(path)) ? ok(path) : fail("missing or unreadable");
};

// The workflow's own required checks. Their fix is the workflow author's advice for the user.
export const workflowChecks = (
  declarations: readonly DoctorDeclaration[],
  env: Result<Readonly<Record<string, string>>>,
): readonly Check[] =>
  declarations.map((declaration) => ({
    name: `${declaration.check}:${declaration.key}`,
    fix: [declaration.fix],
    run: ({ root }) => runDeclared(declaration, root, env),
  }));
