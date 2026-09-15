#!/usr/bin/env node --experimental-strip-types
// Checks every tool, file and credential the pipeline needs, runs the project's own
// doctor from orchestrate.config.json, and parses orchestrate's argument so the caller
// never re-derives it.
// Usage: doctor.ts [--json] ["<raw orchestrate argument>"]
// Exits 1 when any required check fails, 0 otherwise.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Status = "ok" | "warn" | "fail";

export type Outcome = {
  readonly status: Status;
  readonly detail: string;
  readonly fix?: readonly string[];
};

export type Check = {
  readonly name: string;
  // Optional checks report but never fail the run; the stage they unblock degrades instead.
  readonly optional?: boolean;
  readonly fix: readonly string[];
  readonly run: (root: string) => Outcome;
};

// The JSON contract a project's doctor emits under --json: `{ "results": Result[] }`.
// Extra fields are ignored; `optional` and `fix` default when absent.
export type Result = {
  readonly name: string;
  readonly optional: boolean;
  readonly status: Status;
  readonly detail: string;
  readonly fix: readonly string[];
};

export type Report = {
  readonly results: readonly Result[];
  readonly failed: readonly string[];
  readonly warned: readonly string[];
};

export type Input = {
  readonly autoMode: boolean;
  readonly preRelease: boolean;
  readonly inputKind: "prompt" | "ticket" | "file" | "findings";
  readonly inputRef: string;
};

const CONFIG_FILE = "orchestrate.config.json";
const PLUGIN_MANIFEST = join(".claude-plugin", "plugin.json");
const RAW_MAIN = "https://raw.githubusercontent.com/vertexcover-io/harness-engineering/main";
const UPDATE_SCRIPT = join(import.meta.dirname, "..", "orchestrate", "scripts", "harness-update.ts");
const VERSION = /^\d+(\.\d+)*(-[0-9A-Za-z.-]+)?$/;
// Covers a cold DNS and TLS handshake on a slow link, and caps what a hung network
// costs a caller that only wanted a version comparison.
const FETCH_TIMEOUT_SECONDS = 10;

const ok = (detail: string): Outcome => ({ status: "ok", detail });
const warn = (detail: string, fix?: readonly string[]): Outcome => ({ status: "warn", detail, fix });
const fail = (detail: string, fix?: readonly string[]): Outcome => ({ status: "fail", detail, fix });

// ── shell ────────────────────────────────────────────────────────────────────

const run = (command: string, args: readonly string[], cwd?: string): string | null => {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

type ExecFailure = { readonly status: number | null; readonly stdout: unknown };
const isExecFailure = (err: unknown): err is ExecFailure =>
  typeof err === "object" && err !== null && "status" in err && "stdout" in err;

const shell = (command: string, cwd: string): { readonly code: number; readonly stdout: string } => {
  try {
    const stdout = execFileSync("sh", ["-c", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { code: 0, stdout };
  } catch (err) {
    if (!isExecFailure(err)) return { code: 1, stdout: "" };
    return { code: err.status ?? 1, stdout: typeof err.stdout === "string" ? err.stdout : "" };
  }
};

const repoRoot = (cwd: string): string => run("git", ["rev-parse", "--show-toplevel"], cwd) ?? cwd;

// ── harness checks ───────────────────────────────────────────────────────────

const checkBinary =
  (binary: string, versionArgs: readonly string[] = ["--version"]) =>
  (): Outcome => {
    const version = run(binary, versionArgs);
    return version === null ? fail("not on PATH") : ok(version.split("\n")[0] ?? "");
  };

const checkGitRepo = (root: string): Outcome =>
  run("git", ["rev-parse", "--show-toplevel"], root) === null ? fail("not inside a git repository") : ok(root);

const checkHarnessIgnored = (root: string): Outcome =>
  run("git", ["check-ignore", join(root, ".harness", "probe")], root) === null
    ? fail(".harness/ is not gitignored")
    : ok(".harness/ is gitignored");

const checkOrchestrateConfig = (root: string): Outcome => {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return fail(`${CONFIG_FILE} not found`);
  try {
    JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fail(`${CONFIG_FILE} is not valid JSON`);
  }
  return ok(path);
};

const checkGhAuth = (): Outcome => {
  if (run("gh", ["--version"]) === null) return fail("not on PATH");
  if (run("gh", ["auth", "status"]) === null) return warn("installed but not authenticated", ["gh auth login"]);
  return ok("authenticated");
};

const checkSamskara = (): Outcome => {
  const version = run("samskara", ["--version"]);
  if (version === null) return fail("not on PATH");
  const status = run("samskara", ["status"]);
  if (status === null || !status.includes("paired as")) return warn(`v${version} installed but not paired`);
  return ok(`v${version} paired`);
};

const readVersion = (json: string | null): string | null => {
  try {
    const parsed: unknown = JSON.parse(json ?? "");
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return null;
    return typeof parsed.version === "string" && VERSION.test(parsed.version) ? parsed.version : null;
  } catch {
    return null;
  }
};

const localManifest = (): string | null => {
  const root = process.env["CODEX_PLUGIN_ROOT"] ?? process.env["CLAUDE_PLUGIN_ROOT"];
  if (root !== undefined && root !== "") return join(root, PLUGIN_MANIFEST);
  for (let dir = import.meta.dirname; dir !== "/"; dir = dirname(dir)) {
    const candidate = join(dir, PLUGIN_MANIFEST);
    if (existsSync(candidate)) return candidate;
  }
  return null;
};

const splitVersion = (version: string): { readonly core: readonly number[]; readonly pre: readonly string[] } => {
  const [core = "", ...rest] = version.split("-");
  const pre = rest.join("-");
  return { core: core.split(".").map(Number), pre: pre === "" ? [] : pre.split(".") };
};

// Semver identifier order: numbers numerically and below words, and a shorter list below a longer one.
const compareIdentifiers = (a: string | undefined, b: string | undefined): number => {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
  const numeric = /^\d+$/;
  if (numeric.test(a) && numeric.test(b)) return Number(a) - Number(b);
  if (numeric.test(a) !== numeric.test(b)) return numeric.test(a) ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};

// Negative when a is older. A pre-release sorts below the version it is a candidate for.
export const compareVersions = (a: string, b: string): number => {
  const x = splitVersion(a);
  const y = splitVersion(b);
  const coreLength = Math.max(x.core.length, y.core.length);
  const coreDiff = Array.from({ length: coreLength }, (_, i) => (x.core[i] ?? 0) - (y.core[i] ?? 0)).find((d) => d !== 0);
  if (coreDiff !== undefined) return coreDiff;
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  const preLength = Math.max(x.pre.length, y.pre.length);
  return Array.from({ length: preLength }, (_, i) => compareIdentifiers(x.pre[i], y.pre[i])).find((d) => d !== 0) ?? 0;
};

type Channel = "stable" | "pre-release";

// Must match the names in .claude-plugin/marketplace.json and .claude-plugin/pre-release/marketplace.json.
const MARKETPLACES: Record<Channel, { readonly name: string; readonly url: string }> = {
  stable: { name: "main", url: `${RAW_MAIN}/.claude-plugin/marketplace.json` },
  "pre-release": { name: "harness-pre-release", url: `${RAW_MAIN}/.claude-plugin/pre-release/marketplace.json` },
};

// Users get the tag main's marketplace pins, not main's own manifest, so main can run ahead of any release.
export const pinnedVersion = (json: string | null): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json ?? "");
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("plugins" in parsed) || !Array.isArray(parsed.plugins)) return null;
  const harness: unknown = parsed.plugins.find(
    (plugin: unknown) => typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === "harness",
  );
  if (typeof harness !== "object" || harness === null || !("source" in harness)) return null;
  const { source } = harness;
  const hasRef = typeof source === "object" && source !== null && "ref" in source && typeof source.ref === "string";
  const version = hasRef ? String(source.ref).replace(/^v/, "") : "";
  return VERSION.test(version) ? version : null;
};

// Claude Code copies an installed plugin to plugins/cache/<marketplace>/<plugin>/<version>.
export const installedMarketplace = (manifest: string | null): string | null =>
  manifest?.match(/[\\/]plugins[\\/]cache[\\/]([^\\/]+)[\\/]harness[\\/]/)?.[1] ?? null;

const updateFix = (channel: Channel): readonly string[] => [
  `node --experimental-strip-types '${UPDATE_SCRIPT}' ${channel}`,
  "then run /reload-plugins and start orchestrate again",
];

type VersionsSeen = {
  readonly local: string | null;
  readonly remote: string | null;
  readonly installedFrom: string | null;
  readonly preRelease: boolean;
};

export const judgeHarnessVersion = ({ local, remote, installedFrom, preRelease }: VersionsSeen): Outcome => {
  const channel: Channel = preRelease ? "pre-release" : "stable";
  const seen = `current=${local ?? "?"} latest-${channel}=${remote ?? "?"}`;
  const isChannel = Object.values(MARKETPLACES).some(({ name }) => name === installedFrom);
  // A checkout or a local marketplace is its owner's to update; an install from GitHub would replace it.
  if (installedFrom === null || !isChannel) return ok(`${seen} (from ${installedFrom ?? "a local checkout"})`);
  if (installedFrom !== MARKETPLACES[channel].name) {
    return preRelease ? fail(`${seen} (on stable)`, updateFix(channel)) : warn(`${seen} (on pre-release)`, updateFix(channel));
  }
  if (local === null || remote === null) return ok(`${seen} (unknown)`);
  return compareVersions(local, remote) < 0 ? fail(`${seen} (stale)`, updateFix(channel)) : ok(seen);
};

const checkHarnessVersion = (preRelease: boolean) => (): Outcome => {
  const path = localManifest();
  const url = MARKETPLACES[preRelease ? "pre-release" : "stable"].url;
  return judgeHarnessVersion({
    local: readVersion(path !== null && existsSync(path) ? readFileSync(path, "utf8") : null),
    remote: pinnedVersion(run("curl", ["-fsSL", "--max-time", String(FETCH_TIMEOUT_SECONDS), url])),
    installedFrom: installedMarketplace(path),
    preRelease,
  });
};

export const harnessChecks = (preRelease: boolean): readonly Check[] => [
  {
    name: "harness-version",
    fix: ["update the harness plugin, then reload the session or restart Claude"],
    run: checkHarnessVersion(preRelease),
  },
  { name: "git", fix: ["brew install git", "apt install git"], run: checkBinary("git") },
  { name: "git-repo", fix: ["git init", "cd into the repository first"], run: checkGitRepo },
  { name: "jq", fix: ["brew install jq", "apt install jq", "dnf install jq"], run: checkBinary("jq") },
  { name: "curl", fix: ["brew install curl", "apt install curl"], run: checkBinary("curl") },
  {
    name: "harness-gitignored",
    fix: ["echo '.harness/' >> .gitignore", "remove any narrower .harness/* exception"],
    run: checkHarnessIgnored,
  },
  {
    name: "orchestrate-config",
    fix: ["run /setup-harness to generate it", "or copy skills/orchestrate/references/orchestrate.config.example.json"],
    run: checkOrchestrateConfig,
  },
  { name: "gh", optional: true, fix: ["brew install gh", "apt install gh", "gh auth login"], run: checkGhAuth },
  { name: "agent-browser", fix: ["npm i -g agent-browser", "agent-browser install"], run: checkBinary("agent-browser") },
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

// An optional check reports but never blocks, so its severity is capped at warn.
// Applied to harness checks and project rows alike, so a project cannot block on a row it marked optional.
const cap = (status: Status, optional: boolean): Status => (optional && status === "fail" ? "warn" : status);

export const evaluate = (check: Check, root: string): Result => {
  const { status, detail, fix } = check.run(root);
  const optional = check.optional === true;
  return { name: check.name, optional, status: cap(status, optional), detail, fix: fix ?? check.fix };
};

// ── project doctor ───────────────────────────────────────────────────────────

const readDoctorCommand = (root: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, CONFIG_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("doctor" in parsed)) return null;
    return typeof parsed.doctor === "string" && parsed.doctor !== "" ? parsed.doctor : null;
  } catch {
    return null;
  }
};

const STATUSES: readonly Status[] = ["ok", "warn", "fail"];
const isStatus = (value: unknown): value is Status => STATUSES.some((status) => status === value);
const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const toResult = (value: unknown): Result | null => {
  if (typeof value !== "object" || value === null) return null;
  const name = "name" in value && typeof value.name === "string" ? value.name : null;
  const status = "status" in value && isStatus(value.status) ? value.status : null;
  if (name === null || status === null) return null;
  const optional = "optional" in value && value.optional === true;
  return {
    name,
    status: cap(status, optional),
    optional,
    detail: "detail" in value && typeof value.detail === "string" ? value.detail : "",
    fix: "fix" in value && isStringArray(value.fix) ? value.fix : [],
  };
};

export const parseReport = (text: string): readonly Result[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("results" in parsed) || !Array.isArray(parsed.results)) {
    return null;
  }
  const results = parsed.results.map(toResult);
  return results.every((result) => result !== null) ? results : null;
};

const lastLine = (text: string): string => text.trim().split("\n").at(-1) ?? "";

// Runs `<doctor> --json` and folds its rows in. A doctor that speaks the contract
// contributes its rows; one that does not is a single row judged by its exit code.
export const projectDoctor = (root: string, exec: typeof shell = shell): readonly Result[] => {
  const command = readDoctorCommand(root);
  if (command === null) return [];
  const { code, stdout } = exec(`${command} --json`, root);
  if (code === 127) {
    return [{ name: "project-doctor", optional: false, status: "fail", detail: `command not found: ${command}`, fix: [`fix the "doctor" entry in ${CONFIG_FILE}`] }];
  }
  const results = parseReport(stdout);
  if (results !== null) return results;
  return [{
    name: "project-doctor",
    optional: false,
    status: code === 0 ? "ok" : "fail",
    detail: code === 0 ? command : `exit ${code}: ${lastLine(stdout)}`,
    fix: [command],
  }];
};

// ── input ────────────────────────────────────────────────────────────────────

const isFindingsManifest = (path: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("findings" in parsed)) return false;
    const { findings } = parsed;
    return (
      Array.isArray(findings) &&
      findings.length > 0 &&
      findings.every((f) => typeof f === "object" && f !== null && "auto_fixable" in f)
    );
  } catch {
    return false;
  }
};

export const parseInput = (raw: string): Input => {
  const autoMode = /(^|\s)--auto(\s|$)/.test(raw);
  const preRelease = /(^|\s)--pre-release(\s|$)/.test(raw);
  const arg = raw.replace(/(^|\s)--(?:auto|pre-release)(?=\s|$)/g, "").trim();
  if (/^https?:\/\/\S+$/.test(arg)) return { autoMode, preRelease, inputKind: "ticket", inputRef: arg };
  if (arg === "" || !existsSync(arg)) return { autoMode, preRelease, inputKind: "prompt", inputRef: "" };
  const inputRef = resolve(arg);
  return { autoMode, preRelease, inputKind: isFindingsManifest(inputRef) ? "findings" : "file", inputRef };
};

const INPUT_ACTIONS: Partial<Record<Input["inputKind"], string>> = {
  ticket: "Fetch INPUT_REF from the tracker; its title and description are the task.",
  file: "Read INPUT_REF; its contents are the task.",
  findings: "Tech-debt mode: read INPUT_REF as a manifest, fix only auto_fixable entries.",
};

// ── report ───────────────────────────────────────────────────────────────────

export const summarize = (results: readonly Result[]): Report => ({
  results,
  failed: results.filter((r) => r.status === "fail").map((r) => r.name),
  warned: results.filter((r) => r.status === "warn").map((r) => r.name),
});

export const verdict = (report: Report): string => {
  if (report.failed.length > 0) return `BLOCKED ${report.failed.join(" ")}`;
  if (report.warned.length > 0) return `DEGRADED ${report.warned.join(" ")}`;
  return "READY";
};

const HEADERS = ["CHECK", "REQUIRED", "STATUS", "DETAIL", "FIX"] as const;
// A version banner (curl prints its whole TLS stack) would push the FIX column off-screen.
const MAX_DETAIL = 64;

const truncate = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

// One row per check. A fix with several steps wraps under the FIX column.
export const renderTable = (results: readonly Result[]): string => {
  const rows = results.map((result) => [
    result.name,
    result.optional ? "no" : "yes",
    result.status.toUpperCase(),
    truncate(result.detail, MAX_DETAIL),
    result.status === "ok" ? "-" : (result.fix[0] ?? "-"),
  ]);
  const widths = HEADERS.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  ")
      .trimEnd();
  const fixIndent = " ".repeat(widths.slice(0, -1).reduce((total, width) => total + width + 2, 0));

  const body = rows.flatMap((row, index) => {
    const result = results[index];
    const extraSteps = result === undefined || result.status === "ok" ? [] : result.fix.slice(1);
    return [line(row), ...extraSteps.map((step) => `${fixIndent}${step}`)];
  });
  return [line(HEADERS), ...body].join("\n");
};

const renderText = (report: Report, input: Input): string => {
  const action = INPUT_ACTIONS[input.inputKind];
  const advice =
    report.failed.length > 0
      ? "Fix the FAIL rows above, or run /setup-harness. Under --auto, log them and continue."
      : report.warned.length > 0
        ? "Every required check passed. Each WARN costs the one stage it unblocks."
        : "";
  return [
    "ENVIRONMENT",
    renderTable(report.results),
    "",
    "INPUT",
    `AUTO_MODE=${input.autoMode}`,
    `PRE_RELEASE=${input.preRelease}`,
    `INPUT_KIND=${input.inputKind}`,
    `INPUT_REF=${input.inputRef}`,
    ...(action === undefined ? [] : [action]),
    "",
    "VERDICT",
    verdict(report),
    ...(advice === "" ? [] : [advice]),
  ].join("\n");
};

// ── entry ────────────────────────────────────────────────────────────────────

export const main = (argv: readonly string[], cwd: string = process.cwd()): number => {
  const asJson = argv.includes("--json");
  const input = parseInput(argv.filter((arg) => arg !== "--json").join(" "));
  const root = repoRoot(cwd);
  const results = [...harnessChecks(input.preRelease).map((check) => evaluate(check, root)), ...projectDoctor(root)];
  const report = summarize(results);

  console.log(asJson ? JSON.stringify({ ...report, input }, null, 2) : renderText(report, input));
  return report.failed.length === 0 ? 0 : 1;
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  process.exitCode = main(process.argv.slice(2));
}
