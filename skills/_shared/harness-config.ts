// Locates the committed orchestrate.config.json and the project's .env secrets for
// any harness CLI (notify.ts, tracker.ts). Root resolution is git-based so the same
// call works from the main checkout and from inside a pipeline worktree, and .env is
// read from the main checkout — the one place setup-harness tells users to put it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";

export const CONFIG_FILE = "orchestrate.config.json";

export class HarnessConfigError extends Error {}

export type ProjectConfig = {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly repoRoot: string;
};

export const loadProjectConfig = (cwd: string = process.cwd()): ProjectConfig => {
  let roots: string[] = [];
  try {
    roots = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim().split("\n");
  } catch {
    throw new HarnessConfigError(`Not a git repository: ${cwd}. The harness needs one to locate ${CONFIG_FILE}.`);
  }

  const repoRoot = roots[0] ?? "";
  const mainCheckout = dirname(roots[1] ?? "");

  const configFile = join(repoRoot, CONFIG_FILE);
  if (!existsSync(configFile)) {
    throw new HarnessConfigError(`${CONFIG_FILE} not found at ${repoRoot}. Run setup-harness to create it.`);
  }

  const raw = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;

  let fromDotenv: Record<string, string> = {};
  try {
    fromDotenv = parseEnv(readFileSync(join(mainCheckout, ".env"), "utf8")) as Record<string, string>;
  } catch {
    fromDotenv = {};
  }

  return {
    raw,
    secrets: { ...fromDotenv, ...process.env } as Record<string, string>,
    repoRoot,
  };
};
