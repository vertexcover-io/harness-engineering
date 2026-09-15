#!/usr/bin/env node --experimental-strip-types
// Stage 0 of the orchestrate pipeline, as a script.
//   spec-setup.ts init <SPEC_NAME> [--custom-fields '{"worktree":"…","branch":"…","assignee":"…"}']
//                                                        → .harness/<SPEC_NAME>/ tree + manifest.json
//   spec-setup.ts baseline <SPEC_NAME> [--packages a,b]  → .harness/<SPEC_NAME>/baseline.json
// .harness and the config live at the git top level; baseline runs package commands under the manifest's
// worktree when init was given one. Exit 0 on success, 2 on a halt (config missing/stale, unknown package,
// invalid custom fields, missing worktree). A red suite is a result, not a halt: the baseline records it.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Commands = Readonly<Record<string, string | null | undefined>>;
type Package = { readonly path?: string; readonly commands?: Commands };
type Config = { readonly commands?: Commands; readonly packages?: Readonly<Record<string, Package>> };
type Counts = { readonly passed: number | null; readonly failed: number | null; readonly skipped: number | null };
type Metrics = {
  readonly type_check: { readonly exit: number; readonly errors: number | null } | null;
  readonly lint: { readonly exit: number; readonly warnings: number | null } | null;
  readonly test: ({ readonly exit: number } & Counts) | null;
};
type Outcome = { readonly exit: number; readonly stdout: string; readonly stderr: string };

const CONFIG_FILE = "orchestrate.config.json";
// The caller derives this from a task prompt, so it is only a slug by convention. Every artifact
// path is built from it, and init deletes a baseline.json under it.
const SPEC_NAME = /^[a-z0-9][a-z0-9-]*$/;
const ARTIFACT_SUBDIRS = [
  "verification/screenshots",
  "verification/traces",
  "verify-staging",
  "review",
  "phases",
  "design",
  "reports",
] as const;

const halt = (code: string, detail: string): never => {
  console.error(`${code}: ${detail}`);
  process.exit(2);
};

const git = (cwd: string, ...args: readonly string[]): string | null => {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const readConfig = (root: string): Config => {
  const path = join(root, CONFIG_FILE);
  if (!existsSync(path)) return halt("CONFIG_MISSING", `${CONFIG_FILE} not found at ${root} — run setup-harness, which writes it`);
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isRecord(parsed) ? (parsed as Config) : halt("CONFIG_INVALID", `${path} is not a JSON object`);
};

const firstNumber = (text: string, patterns: readonly RegExp[]): number | null => {
  for (const pattern of patterns) {
    const hit = pattern.exec(text)?.[1];
    if (hit !== undefined) return Number(hit);
  }
  return null;
};

export const parseTypecheck = (out: string): number | null =>
  firstNumber(out, [/Found (\d+) errors?/, /(\d+) errors?\b/i]);

export const parseLint = (out: string): number | null => firstNumber(out, [/(\d+) warnings?\b/i]);

const text = (out: Outcome): string => `${out.stdout}\n${out.stderr}`;

// node --test prints one count per line; every other runner puts them all on one summary line.
const nodeTestCounts = (out: string): Counts | null => {
  const count = (label: string): number | null =>
    firstNumber(out, [new RegExp(String.raw`^\s*[\u2139#]\s*${label}\s+(\d+)\s*$`, "m")]);
  const passed = count("pass");
  return passed === null ? null : { passed, failed: count("fail"), skipped: count("skipped") };
};

// "Test Files" (vitest) and "Test Suites" (jest) carry *file* counts and print above the line
// that carries test counts, so searching the whole output finds the wrong numbers first.
const testSummaryLine = (out: string): string | null =>
  out.split("\n").find((line) => /^\s*Tests[: ]/.test(line)) ?? null;

export const parseTests = (out: string): Counts => {
  const perLine = nodeTestCounts(out);
  if (perLine !== null) return perLine;
  const summary = testSummaryLine(out) ?? out;
  return {
    passed: firstNumber(summary, [/(\d+) passed\b/]),
    failed: firstNumber(summary, [/(\d+) failed\b/]),
    skipped: firstNumber(summary, [/(\d+) skipped\b/]),
  };
};

const runInfo = (): unknown => {
  const script = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "_shared", "collect-run-info.ts");
  const r = spawnSync(process.execPath, ["--experimental-strip-types", script, "--json"], { encoding: "utf8" });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { harness: null, andromeda: null, session: null };
  }
};

const init = (root: string, specName: string, customFields: Readonly<Record<string, string>>): void => {
  readConfig(root);
  const specDir = join(root, ".harness", specName);

  const manifest = {
    spec_name: specName,
    started_at: new Date().toISOString(),
    run_info: runInfo(),
    thread: null,
    pr_number: null,
    stages: {},
  };
  // Reserved names come from the manifest itself, so a field added above is protected without a second list.
  const clash = Object.keys(customFields).find((key) => key in manifest);
  if (clash !== undefined) halt("CUSTOM_FIELDS_INVALID", `"${clash}" is a manifest field`);

  for (const sub of ARTIFACT_SUBDIRS) mkdirSync(join(specDir, sub), { recursive: true });
  rmSync(join(specDir, "baseline.json"), { force: true });
  writeFileSync(join(specDir, "manifest.json"), `${JSON.stringify({ ...customFields, ...manifest }, null, 2)}\n`);

  console.log(`SPEC_NAME=${specName}`);
  console.log(`SPEC_DIR=${specDir}`);
  console.log(`BASELINE_PATH=${join(specDir, "baseline.json")}`);
  console.log(`MANIFEST_PATH=${join(specDir, "manifest.json")}`);
};

const resolveCommand = (config: Config, pkg: Package, key: string): string | null =>
  pkg.commands?.[key] ?? config.commands?.[key] ?? null;

const LAUNCH_FAILURE = /command not found|Missing script|is not recognized/i;

// A command that never launched writes a line or two to stderr and nothing to stdout. A suite
// that merely failed writes plenty, and its own output can quote these phrases.
const isUnresolvable = (out: Outcome): boolean => {
  if (out.exit === 127) return true;
  if (out.stdout.trim() !== "") return false;
  return LAUNCH_FAILURE.test(out.stderr.split("\n").slice(0, 3).join("\n"));
};

const runCommand = (cwd: string, command: string, packageName: string): Outcome => {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", env: { ...process.env, CI: "1" } });
  const where = `'${command}' (package ${packageName})`;
  if (r.error !== undefined) return halt("CONFIG_STALE", `${where} could not start: ${r.error.message}`);
  const out = { exit: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  if (isUnresolvable(out)) return halt("CONFIG_STALE", `${where} does not resolve — ${CONFIG_FILE} needs updating`);
  return out;
};

const measure = (config: Config, root: string, name: string, pkg: Package): Metrics => {
  const cwd = resolve(root, pkg.path ?? ".");
  const run = (key: string): Outcome | null => {
    const command = resolveCommand(config, pkg, key);
    return command === null ? null : runCommand(cwd, command, name);
  };

  run("bootstrap");
  const typecheck = run("typecheck");
  const lint = run("lint");
  const test = run("test_all") ?? run("coverage_all");

  return {
    type_check: typecheck && { exit: typecheck.exit, errors: parseTypecheck(text(typecheck)) },
    lint: lint && { exit: lint.exit, warnings: parseLint(text(lint)) },
    test: test && { exit: test.exit, ...parseTests(text(test)) },
  };
};

const selectPackages = (config: Config, names: readonly string[]): ReadonlyArray<readonly [string, Package]> => {
  const configured = Object.entries(config.packages ?? {});
  // Naming none means all of them. Falling back to a synthetic "root" entry while packages exist
  // would measure none of them, and a package with no baseline entry blocks the gate later.
  if (names.length === 0) return configured.length > 0 ? configured : [["root", {}]];
  return names.map((name) => {
    const pkg = config.packages?.[name];
    return pkg === undefined ? halt("PACKAGE_UNKNOWN", `'${name}' is not in ${CONFIG_FILE}.packages — run setup-harness, which adds it`) : [name, pkg];
  });
};

// A multi-repo workspace sits in a gitignored folder under the root, so only the caller knows it.
const worktreeFor = (root: string, specName: string): string => {
  const path = join(root, ".harness", specName, "manifest.json");
  const parsed: unknown = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  const recorded = isRecord(parsed) && typeof parsed["worktree"] === "string" ? parsed["worktree"] : null;
  if (recorded === null) return root;
  const worktree = resolve(root, recorded);
  return existsSync(worktree) ? worktree : halt("WORKTREE_MISSING", `manifest worktree ${worktree} does not exist`);
};

const baseline = (root: string, specName: string, packageNames: readonly string[]): void => {
  const config = readConfig(root);
  const worktree = worktreeFor(root, specName);
  const entries = selectPackages(config, packageNames).map(([name, pkg]) => [name, measure(config, worktree, name, pkg)] as const);
  const result = { ...Object.fromEntries(entries), timestamp: new Date().toISOString() };
  const path = join(root, ".harness", specName, "baseline.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`BASELINE_PATH=${path}`);
};

const readFlag = (argv: readonly string[], name: string): string | null => {
  const at = argv.indexOf(name);
  return at === -1 ? null : (argv[at + 1] ?? "");
};

const readPackagesFlag = (argv: readonly string[]): readonly string[] =>
  (readFlag(argv, "--packages") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

// title, body and url are the task itself: setup consumes them, and the manifest never stores them.
const TASK_KEYS: ReadonlySet<string> = new Set(["title", "body", "url"]);
const FIELD_KEY = /^[a-z][a-z0-9_]*$/;

const readCustomFields = (argv: readonly string[]): Readonly<Record<string, string>> => {
  const raw = readFlag(argv, "--custom-fields");
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return halt("CUSTOM_FIELDS_INVALID", "--custom-fields is not JSON");
  }
  if (!isRecord(parsed)) return halt("CUSTOM_FIELDS_INVALID", "--custom-fields must be a JSON object");
  for (const [key, value] of Object.entries(parsed)) {
    if (TASK_KEYS.has(key)) halt("CUSTOM_FIELDS_INVALID", `"${key}" is task text, not a custom field — drop title, body and url before passing the rest`);
    if (!FIELD_KEY.test(key)) halt("CUSTOM_FIELDS_INVALID", `"${key}" must be snake_case`);
    if (typeof value !== "string") halt("CUSTOM_FIELDS_INVALID", `"${key}" must be a string`);
  }
  return parsed as Record<string, string>;
};

const main = (argv: readonly string[]): void => {
  const [command, specName] = argv;
  if (!specName || (command !== "init" && command !== "baseline")) {
    console.error("usage: spec-setup.ts <init|baseline> <SPEC_NAME> [--custom-fields <json>] [--packages a,b]");
    process.exit(1);
  }
  if (!SPEC_NAME.test(specName)) {
    console.error(`invalid spec name '${specName}': expected a slug of lowercase letters, digits and hyphens`);
    process.exit(1);
  }
  const root = git(process.cwd(), "rev-parse", "--show-toplevel") ?? process.cwd();
  if (command === "init") return init(root, specName, readCustomFields(argv));
  baseline(root, specName, readPackagesFlag(argv));
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
