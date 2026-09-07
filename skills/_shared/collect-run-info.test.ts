import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readRunSessionId } from "./collect-run-info.ts";

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
  const link = join(mkdtempSync(join(tmpdir(), "cri-link-")), "linked");
  symlinkSync(SELF_DIR, link);

  assert.match(runScript(join(link, "collect-run-info.ts")), /harness /);
});

test("SC3: readRunSessionId prefers the session the run's manifest recorded", () => {
  const dir = mkdtempSync(join(tmpdir(), "cri-manifest-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ run_info: { session: "sess-abc" } }));
  process.env["SESSION_ID"] = "sess-detected";

  assert.equal(readRunSessionId(dir), "sess-abc");
});

test("SC4: with no manifest, readRunSessionId falls back to the detected session", () => {
  const dir = mkdtempSync(join(tmpdir(), "cri-nomanifest-"));
  process.env["SESSION_ID"] = "sess-detected";

  assert.equal(readRunSessionId(dir), "sess-detected");
  assert.equal(readRunSessionId(undefined), "sess-detected");
});

test("SC5: a manifest with no session in it falls back rather than returning empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "cri-emptysession-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ run_info: { session: "" } }));
  process.env["SESSION_ID"] = "sess-detected";

  assert.equal(readRunSessionId(dir), "sess-detected");
});
