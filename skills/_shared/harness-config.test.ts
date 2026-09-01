import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadProjectConfig } from "./harness-config.ts";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "harness-config-"));
const gitDir = (): string => {
  const dir = tempDir();
  execFileSync("git", ["init", "-q", dir]);
  return dir;
};

test("a non-git directory is an error", () => {
  const dir = tempDir();
  assert.throws(() => loadProjectConfig(dir), /Not a git repository/);
  rmSync(dir, { recursive: true, force: true });
});

test("a repo without orchestrate.config.json says to run setup-harness", () => {
  const dir = gitDir();
  assert.throws(() => loadProjectConfig(dir), /Run setup-harness/);
  rmSync(dir, { recursive: true, force: true });
});

test("reads the config and merges .env secrets under process.env", () => {
  const dir = gitDir();
  writeFileSync(join(dir, "orchestrate.config.json"), JSON.stringify({ notifier: { enabled: true } }));
  writeFileSync(join(dir, ".env"), "FROM_DOTENV=yes\nPATH=overridden-by-dotenv\n");
  const got = loadProjectConfig(dir);
  assert.deepEqual(got.raw["notifier"], { enabled: true });
  assert.equal(got.secrets["FROM_DOTENV"], "yes");
  assert.equal(got.secrets["PATH"], process.env["PATH"]);
  rmSync(dir, { recursive: true, force: true });
});
