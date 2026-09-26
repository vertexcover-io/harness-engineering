import { join } from "node:path";
import {
  type Check,
  type CheckContext,
  type CheckStatus,
  CheckStatusSchema,
  checkBinary,
  type Exec,
  fail,
  type Outcome,
  ok,
  warn,
} from "@harness/sdk";
import * as z from "zod";
import type { Result } from "./contracts.ts";
import { execWithTimeout, findRepoRoot, NOT_FOUND } from "./exec.ts";
import { readIfExists } from "./files.ts";

export const DoctorRowSchema = z.object({
  name: z.string().min(1),
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
  name: z.string().min(1),
  status: CheckStatusSchema,
  optional: z.boolean().catch(false),
  detail: z.string().catch(""),
  fix: z.array(z.string()).catch([]),
});
const ProjectReportSchema = z.object({ results: z.array(ProjectRowSchema) });

export const DOCTOR_TIMEOUT_MS = 30_000;
const CONFIG_FILE = "orchestrate.config.json";

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
  (await findRepoRoot(root, exec)) === null ? fail("not inside a git repository") : ok(root);

const checkHarnessIgnored = async ({ root, exec }: CheckContext): Promise<Outcome> => {
  const { code } = await exec("git", ["check-ignore", join(root, ".harness", "probe")], root);
  return code === 0 ? ok(".harness/ is gitignored") : fail(".harness/ is not gitignored");
};

const ConfigSchema = z.object({ doctor: z.string().min(1).optional() });
type Config = z.infer<typeof ConfigSchema>;

// null when the file is absent. The config check and the project doctor both read through here,
// so they agree on what a broken config is, and neither can crash the run on one.
const readConfig = async (root: string): Promise<Result<Config> | null> => {
  try {
    const text = await readIfExists(join(root, CONFIG_FILE));
    if (text === null) return null;
    const json = parseJson(text);
    if (!json.ok) return { ok: false, error: `${CONFIG_FILE} is not valid JSON` };
    const parsed = ConfigSchema.safeParse(json.value);
    if (!parsed.success)
      return { ok: false, error: `${CONFIG_FILE}: ${z.prettifyError(parsed.error)}` };
    return { ok: true, value: parsed.data };
  } catch (error) {
    return { ok: false, error: `${CONFIG_FILE} cannot be read: ${errorMessage(error)}` };
  }
};

const checkOrchestrateConfig = async ({ root }: CheckContext): Promise<Outcome> => {
  const config = await readConfig(root);
  if (config === null) return fail(`${CONFIG_FILE} not found`);
  return config.ok ? ok(join(root, CONFIG_FILE)) : fail(config.error);
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
      "run /setup-harness to generate it",
      "or copy skills/orchestrate/references/orchestrate.config.example.json",
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

const runCheck = async (check: Check, context: CheckContext): Promise<Outcome> => {
  try {
    return await check.run(context);
  } catch (error) {
    return fail(errorMessage(error));
  }
};

export const evaluate = async (check: Check, context: CheckContext): Promise<DoctorRow> => {
  const { status, detail, fix } = await runCheck(check, context);
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

const readDoctorCommand = async (root: string): Promise<string | null> => {
  const config = await readConfig(root);
  return config?.ok ? (config.value.doctor ?? null) : null;
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
export const projectDoctor = async (root: string, exec: Exec): Promise<readonly DoctorRow[]> => {
  const command = await readDoctorCommand(root);
  if (command === null) return [];
  try {
    const { code, stdout } = await exec("sh", ["-c", `${command} --json`], root);
    if (code === NOT_FOUND) {
      return [
        projectRow(
          "fail",
          `command not found: ${command}`,
          `fix the "doctor" entry in ${CONFIG_FILE}`,
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
};

export const runDoctor = async ({
  cwd,
  exec = execWithTimeout(DOCTOR_TIMEOUT_MS),
  extraChecks = [],
}: DoctorOptions): Promise<DoctorReport> => {
  // Outside a repository the checks still run, against cwd; git-repo reports the problem.
  const root = (await findRepoRoot(cwd, exec)) ?? cwd;
  const checks = [...CHECKS, ...extraChecks];
  const [rows, projectRows] = await Promise.all([
    Promise.all(checks.map((check) => evaluate(check, { root, exec }))),
    projectDoctor(root, exec),
  ]);
  return summarize([...rows, ...projectRows]);
};
