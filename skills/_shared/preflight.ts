#!/usr/bin/env node --experimental-strip-types
// Checks every tool, file and credential the pipeline needs before orchestrate runs.
// Usage: preflight.ts [--json]
// Exits 1 when any check fails, 0 when all pass.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Status = "ok" | "missing";

type Result = {
  readonly name: string;
  readonly status: Status;
  readonly detail: string;
  readonly unblocks: string;
  readonly fix: readonly string[];
};

type Check = {
  readonly name: string;
  readonly unblocks: string;
  readonly fix: readonly string[];
  readonly run: () => { readonly status: Status; readonly detail: string };
};

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 6;

const run = (command: string, args: readonly string[]): string | null => {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

const repoRoot = (): string => run("git", ["rev-parse", "--show-toplevel"]) ?? process.cwd();

const readDotenvKeys = (path: string): ReadonlySet<string> => {
  if (!existsSync(path)) return new Set();
  const keys = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && line.includes("="))
    .filter((line) => line.slice(line.indexOf("=") + 1).trim() !== "")
    .map((line) => line.slice(0, line.indexOf("=")).trim());
  return new Set(keys);
};

const checkBinary = (binary: string, versionArgs: readonly string[] = ["--version"]) => {
  return (): { readonly status: Status; readonly detail: string } => {
    const version = run(binary, versionArgs);
    if (version === null) return { status: "missing", detail: "not on PATH" };
    return { status: "ok", detail: version.split("\n")[0] ?? "" };
  };
};

const checkNodeVersion = (): { readonly status: Status; readonly detail: string } => {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const supportsStripTypes =
    major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  if (!supportsStripTypes) {
    return {
      status: "missing",
      detail: `v${process.versions.node} cannot run --experimental-strip-types`,
    };
  }
  return { status: "ok", detail: `v${process.versions.node}` };
};

const checkGitRepo = (): { readonly status: Status; readonly detail: string } => {
  const root = run("git", ["rev-parse", "--show-toplevel"]);
  if (root === null) return { status: "missing", detail: "not inside a git repository" };
  return { status: "ok", detail: root };
};

const checkHarnessIgnored = (): { readonly status: Status; readonly detail: string } => {
  const ignored = run("git", ["check-ignore", join(repoRoot(), ".harness", "probe")]);
  if (ignored === null) return { status: "missing", detail: ".harness/ is not gitignored" };
  return { status: "ok", detail: ".harness/ is gitignored" };
};

const checkOrchestrateConfig = (): { readonly status: Status; readonly detail: string } => {
  const path = join(repoRoot(), "orchestrate.config.json");
  if (!existsSync(path)) return { status: "missing", detail: "orchestrate.config.json not found" };
  try {
    JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { status: "missing", detail: "orchestrate.config.json is not valid JSON" };
  }
  return { status: "ok", detail: path };
};

const checkGhAuth = (): { readonly status: Status; readonly detail: string } => {
  if (run("gh", ["--version"]) === null) return { status: "missing", detail: "not on PATH" };
  if (run("gh", ["auth", "status"]) === null) {
    return { status: "missing", detail: "installed but not authenticated" };
  }
  return { status: "ok", detail: "authenticated" };
};

const checkSamskara = (): { readonly status: Status; readonly detail: string } => {
  const version = run("samskara", ["--version"]);
  if (version === null) return { status: "missing", detail: "not on PATH" };

  const status = run("samskara", ["status"]);
  if (status === null || !status.includes("paired as")) {
    return { status: "missing", detail: `v${version} installed but not paired` };
  }
  return { status: "ok", detail: `v${version} paired` };
};

const checkWorktrunk = (): { readonly status: Status; readonly detail: string } => {
  const version = run("wt", ["--version"]) ?? run("git-wt", ["--version"]);
  if (version === null) return { status: "missing", detail: "neither wt nor git-wt on PATH" };
  return { status: "ok", detail: version.split("\n")[0] ?? "" };
};

const checkNotifierSecrets = (): { readonly status: Status; readonly detail: string } => {
  const configPath = join(repoRoot(), "orchestrate.config.json");
  if (!existsSync(configPath)) return { status: "ok", detail: "no config, notifier off" };

  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  const notifier =
    typeof parsed === "object" && parsed !== null && "notifier" in parsed
      ? (parsed as { readonly notifier?: { enabled?: boolean; provider?: string } }).notifier
      : undefined;

  if (notifier?.enabled !== true) return { status: "ok", detail: "notifier disabled" };
  if (notifier.provider !== "slack") {
    return { status: "ok", detail: `provider ${notifier.provider ?? "unset"}, nothing to check` };
  }

  const available = new Set([
    ...readDotenvKeys(join(repoRoot(), ".env")),
    ...Object.keys(process.env).filter((key) => process.env[key] !== ""),
  ]);
  const required = ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID", "SLACK_MEMBER_ID"];
  const absent = required.filter((key) => !available.has(key));

  if (absent.length > 0) return { status: "missing", detail: `unset: ${absent.join(", ")}` };
  return { status: "ok", detail: "slack credentials present" };
};

const checkAsanaCredentials = (): { readonly status: Status; readonly detail: string } => {
  const available = new Set([
    ...readDotenvKeys(join(repoRoot(), ".env")),
    ...Object.keys(process.env).filter((key) => process.env[key] !== ""),
  ]);
  const absent = ["ASANA_PAT", "ASANA_WORKSPACE_GID"].filter((key) => !available.has(key));
  if (absent.length > 0) return { status: "missing", detail: `unset: ${absent.join(", ")}` };
  return { status: "ok", detail: "asana credentials present" };
};

const CHECKS: readonly Check[] = [
  {
    name: "git",
    unblocks: "every stage — branching, worktrees, commits",
    fix: ["brew install git", "apt install git"],
    run: checkBinary("git"),
  },
  {
    name: "git-repo",
    unblocks: "every stage — the pipeline resolves paths from the repo root",
    fix: ["git init", "cd into the repository before running orchestrate"],
    run: checkGitRepo,
  },
  {
    name: "node",
    unblocks: "notify.ts, collect-run-info.ts, upload-bundle.ts",
    fix: [
      "brew install node",
      "mise use node@22 (or nvm install 22)",
      `node must be >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} for --experimental-strip-types`,
    ],
    run: checkNodeVersion,
  },
  {
    name: "jq",
    unblocks: "orchestrate gate scripts, claims aggregation",
    fix: ["brew install jq", "apt install jq", "dnf install jq"],
    run: checkBinary("jq"),
  },
  {
    name: "curl",
    unblocks: "version-gate.sh, library-probe smoke tests",
    fix: ["brew install curl", "apt install curl"],
    run: checkBinary("curl"),
  },
  {
    name: "harness-gitignored",
    unblocks: "every stage — .harness/ artifacts must stay local",
    fix: ["echo '.harness/' >> .gitignore", "remove any narrower .harness/* exception lines"],
    run: checkHarnessIgnored,
  },
  {
    name: "orchestrate-config",
    unblocks: "pipeline-setup, quality-gate, every stage that reads project commands",
    fix: [
      "run /setup-harness to generate it",
      "copy skills/orchestrate/references/orchestrate.config.example.json and edit the commands",
    ],
    run: checkOrchestrateConfig,
  },
  {
    name: "gh",
    unblocks: "code-review on a PR, orchestrate's commit-pr stage",
    fix: ["brew install gh", "apt install gh", "gh auth login"],
    run: checkGhAuth,
  },
  {
    name: "agent-browser",
    unblocks: "functional-verify UI proofs — halts on BLOCKED:no-agent-browser",
    fix: ["npm i -g agent-browser", "agent-browser install"],
    run: checkBinary("agent-browser"),
  },
  {
    name: "just",
    unblocks: "repo task commands declared in orchestrate.config.json",
    fix: ["brew install just", "cargo install just"],
    run: checkBinary("just"),
  },
  {
    name: "mani",
    unblocks: "multi-repo stack commands",
    fix: ["brew tap alajmo/mani && brew install mani"],
    run: checkBinary("mani"),
  },
  {
    name: "worktrunk",
    unblocks: "using-git-worktrees, pipeline-setup worktree creation",
    fix: ["brew install worktrunk", "wt config shell install"],
    run: checkWorktrunk,
  },
  {
    name: "samskara",
    unblocks: "session capture, functional-verify publish step",
    fix: [
      "npm i -g samskara",
      "samskara init — picks a server, pairs the CLI, installs the hook, starts the watcher",
      "samskara enable — turn on capture for this repo",
    ],
    run: checkSamskara,
  },
  {
    name: "notifier-secrets",
    unblocks: "orchestrate run-started and stage notifications",
    fix: [
      "add SLACK_BOT_TOKEN, SLACK_CHANNEL_ID and SLACK_MEMBER_ID to .env at the repo root",
      "or set notifier.enabled to false in orchestrate.config.json",
    ],
    run: checkNotifierSecrets,
  },
  {
    name: "asana-credentials",
    unblocks: "functional-verify publish step, ticket linking",
    fix: [
      "add ASANA_PAT and ASANA_WORKSPACE_GID to .env at the repo root",
      "the workspace GID is in the Asana URL",
    ],
    run: checkAsanaCredentials,
  },
];

const evaluate = (check: Check): Result => {
  const { status, detail } = check.run();
  return {
    name: check.name,
    status,
    detail,
    unblocks: check.unblocks,
    fix: check.fix,
  };
};

const printTable = (results: readonly Result[]): void => {
  const width = Math.max(...results.map((result) => result.name.length));
  for (const result of results) {
    const label = result.status === "ok" ? "OK  " : "FAIL";
    console.log(`${label}  ${result.name.padEnd(width)}  ${result.detail}`);
  }
};

const printFixes = (failures: readonly Result[]): void => {
  if (failures.length === 0) return;
  console.log("\nTo fix:\n");
  for (const failure of failures) {
    console.log(`${failure.name} — ${failure.unblocks}`);
    for (const step of failure.fix) console.log(`  ${step}`);
    console.log("");
  }
};

const results = CHECKS.map(evaluate);
const failures = results.filter((result) => result.status === "missing");

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ results, failed: failures.length }, null, 2));
} else {
  printTable(results);
  printFixes(failures);
  console.log(
    failures.length === 0
      ? "\nAll checks passed. Run /orchestrate \"<task>\"."
      : `\n${failures.length} of ${results.length} checks failed.`,
  );
}

process.exit(failures.length === 0 ? 0 : 1);
