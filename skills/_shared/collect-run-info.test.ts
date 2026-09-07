import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

const runScript = (scriptPath: string): string => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", scriptPath], {
    encoding: "utf8",
  });
  return (r.stdout ?? "").trim();
};

test("collect-run-info prints its line when run directly", () => {
  assert.match(runScript(join(SELF_DIR, "collect-run-info.ts")), /harness /);
});

test("collect-run-info prints its line when reached through a symlink", () => {
  // Plugin installs are commonly symlinked, and this file is documented as a hand-run
  // diagnostic. import.meta.url is already realpath'd, so comparing it against a raw argv[1]
  // silently makes the whole script a no-op.
  const link = join(mkdtempSync(join(tmpdir(), "cri-link-")), "linked");
  symlinkSync(SELF_DIR, link);

  assert.match(runScript(join(link, "collect-run-info.ts")), /harness /);
});
