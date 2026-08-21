#!/usr/bin/env node --experimental-strip-types
// Reports what produced one pipeline run: harness version, andromeda version, session id.
// Usage: collect-run-info.ts [--json]
// Prints "harness <v> · andromeda <branch@sha> · session <uuid>", or that object as JSON.
// A value that cannot be read is dropped from the line and null in JSON. Always exits 0 —
// run info is a record of a run, never a gate on one.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type RunInfo = {
  readonly harness: string | null;
  readonly andromeda: string | null;
  readonly session: string | null;
};

const ANDROMEDA_REPO = "refrens/andromeda";

const git = (...args: readonly string[]): string | null => {
  try {
    const out = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() || null;
  } catch {
    return null;
  }
};

function readHarnessVersion(): string | null {
  const pluginRoot = process.env["CODEX_PLUGIN_ROOT"] ?? process.env["CLAUDE_PLUGIN_ROOT"];
  // A plugin runtime exports a root; a standalone checkout exports neither, hence the walk-up.
  for (let dir = pluginRoot ?? import.meta.dirname; dir !== dirname(dir); dir = dirname(dir)) {
    const manifest = join(dir, ".claude-plugin", "plugin.json");
    if (!existsSync(manifest)) continue;
    const version = readVersionField(manifest);
    if (version) return version;
  }
  return null;
}

function readVersionField(manifestPath: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return null;
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

function readAndromedaVersion(): string | null {
  const origin = git("remote", "get-url", "origin");
  if (!origin?.replace(/\.git$/, "").endsWith(ANDROMEDA_REPO)) return null;
  const sha = git("rev-parse", "--short", "HEAD");
  if (!sha) return null;
  const branch = git("branch", "--show-current");
  return branch ? `${branch}@${sha}` : sha;
}

function readSessionId(): string | null {
  const injected = process.env["SESSION_ID"];
  if (injected) return injected;
  // Derive from the main repo, never the worktree: a worktree path encodes to a different
  // transcript directory, so deriving there resolves an unrelated session.
  const commonDir = git("rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!commonDir) return null;
  const encoded = dirname(commonDir).replaceAll("/", "-");
  return newestTranscriptId(join(homedir(), ".claude", "projects", encoded));
}

function newestTranscriptId(projectDir: string): string | null {
  try {
    const newest = readdirSync(projectDir)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, modified: statSync(join(projectDir, name)).mtimeMs }))
      .toSorted((a, b) => b.modified - a.modified)[0];
    return newest ? newest.name.replace(/\.jsonl$/, "") : null;
  } catch {
    return null;
  }
}

const info: RunInfo = {
  harness: readHarnessVersion(),
  andromeda: readAndromedaVersion(),
  session: readSessionId(),
};

if (process.argv[2] === "--json") {
  console.log(JSON.stringify(info));
} else {
  console.log(
    [
      info.harness && `harness ${info.harness}`,
      info.andromeda && `andromeda ${info.andromeda}`,
      info.session && `session ${info.session}`,
    ]
      .filter((segment): segment is string => segment !== null)
      .join(" · "),
  );
}
