import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SDK_TYPES from "./sdk-types.json";

const CLI = join(import.meta.dir, "index.ts");

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const makeRepo = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "yok-types-e2e-")));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
};

describe("yok types", () => {
  test("SC105: in a fresh git repo it writes .yok/types and prints the paths line and the zod command", () => {
    const repo = makeRepo();

    const run = spawnSync("bun", ["--no-env-file", CLI, "types"], { cwd: repo, encoding: "utf8" });

    expect(run.status).toBe(0);
    expect(existsSync(join(repo, ".yok", "types", "index.d.ts"))).toBe(true);
    expect(existsSync(join(repo, ".yok", "types", "VERSION"))).toBe(true);
    expect(run.stdout).toContain('"@yok/sdk": ["./.yok/types/index.d.ts"]');
    expect(run.stdout).toContain(`bun add -d zod@${SDK_TYPES.zodVersion}`);
  });
});
