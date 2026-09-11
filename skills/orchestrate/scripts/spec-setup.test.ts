import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseLint, parseTests, parseTypecheck } from "./spec-setup.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "spec-setup.ts");

type Run = { readonly code: number; readonly stdout: string; readonly stderr: string };

const run = (cwd: string, ...args: readonly string[]): Run => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, SESSION_ID: "sess-test" },
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const makeRepo = (config: unknown): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "spec-setup-")));
  execFileSync("git", ["init", "-q", "-b", "feat/test"], { cwd: dir });
  if (config !== undefined) writeFileSync(join(dir, "orchestrate.config.json"), JSON.stringify(config));
  return dir;
};

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

const echoExit = (text: string, code: number): string => `sh -c 'echo "${text}"; exit ${code}'`;

test("init creates the artifact tree and manifest, and prints the paths", () => {
  const repo = makeRepo({ commands: {} });
  const r = run(repo, "init", "add-auth");

  assert.equal(r.code, 0, r.stderr);
  const specDir = join(repo, ".harness", "add-auth");
  for (const sub of ["verification/screenshots", "verification/traces", "verify-staging", "review", "phases", "design", "reports"]) {
    assert.ok(existsSync(join(specDir, sub)), `missing ${sub}`);
  }
  const manifest = readJson(join(specDir, "manifest.json"));
  assert.equal(manifest["spec_name"], "add-auth");
  assert.equal(manifest["branch"], "feat/test");
  assert.equal(manifest["worktree"], repo);
  assert.equal(manifest["pr_number"], null);
  assert.deepEqual(manifest["stages"], {});
  assert.equal((manifest["run_info"] as Record<string, unknown>)["session"], "sess-test");
  assert.match(r.stdout, /^SPEC_DIR=.*add-auth$/m);
  assert.match(r.stdout, /^BASELINE_PATH=.*baseline\.json$/m);
  assert.match(r.stdout, /^MANIFEST_PATH=.*manifest\.json$/m);
});

test("init removes a stale baseline.json from a previous run", () => {
  const repo = makeRepo({ commands: {} });
  run(repo, "init", "add-auth");
  const stale = join(repo, ".harness", "add-auth", "baseline.json");
  writeFileSync(stale, "{}");

  run(repo, "init", "add-auth");

  assert.ok(!existsSync(stale));
});

test("init rejects a spec name that could escape the artifact directory", () => {
  const repo = makeRepo({ commands: {} });

  const r = run(repo, "init", "../../tmp/escape");

  assert.equal(r.code, 1);
  assert.match(r.stderr, /spec name/i);
  assert.ok(!existsSync(join(repo, "..", "..", "tmp", "escape")));
});

test("baseline with no --packages measures every configured package", () => {
  const repo = makeRepo({
    commands: {},
    packages: {
      api: { path: ".", commands: { test_all: echoExit("1 passed", 0) } },
      web: { path: ".", commands: { test_all: echoExit("2 passed", 0) } },
    },
  });
  run(repo, "init", "add-auth");

  const r = run(repo, "baseline", "add-auth");

  assert.equal(r.code, 0, r.stderr);
  const baseline = readJson(join(repo, ".harness", "add-auth", "baseline.json"));
  assert.deepEqual(Object.keys(baseline).toSorted(), ["api", "timestamp", "web"]);
  assert.equal(baseline["root"], undefined);
});

test("init halts when orchestrate.config.json is missing", () => {
  const repo = makeRepo(undefined);
  const r = run(repo, "init", "add-auth");

  assert.equal(r.code, 2);
  assert.match(r.stderr, /CONFIG_MISSING/);
  assert.match(r.stderr, /setup-harness/);
});

test("baseline writes one entry per package with every key, null where the config names no command", () => {
  const repo = makeRepo({
    commands: { typecheck: echoExit("Found 2 errors.", 1), lint: echoExit("3 warnings", 0) },
    packages: {
      api: { path: ".", commands: { test_all: echoExit("Tests  1 failed | 4 passed | 1 skipped", 1) } },
      web: { path: ".", commands: {} },
    },
  });
  run(repo, "init", "add-auth");

  const r = run(repo, "baseline", "add-auth", "--packages", "api,web");

  assert.equal(r.code, 0, r.stderr);
  const baseline = readJson(join(repo, ".harness", "add-auth", "baseline.json"));
  assert.match(String(baseline["timestamp"]), /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(baseline["api"], {
    type_check: { exit: 1, errors: 2 },
    lint: { exit: 0, warnings: 3 },
    test: { exit: 1, passed: 4, failed: 1, skipped: 1 },
  });
  assert.deepEqual(baseline["web"], {
    type_check: { exit: 1, errors: 2 },
    lint: { exit: 0, warnings: 3 },
    test: null,
  });
});

test("baseline uses the root commands when no package is named", () => {
  const repo = makeRepo({ commands: { test_all: echoExit("5 passed", 0) } });
  run(repo, "init", "add-auth");

  const r = run(repo, "baseline", "add-auth");

  assert.equal(r.code, 0, r.stderr);
  const baseline = readJson(join(repo, ".harness", "add-auth", "baseline.json"));
  assert.deepEqual(baseline["root"], {
    type_check: null,
    lint: null,
    test: { exit: 0, passed: 5, failed: null, skipped: null },
  });
});

test("baseline halts on a command that does not resolve and writes nothing", () => {
  const repo = makeRepo({ commands: { typecheck: "definitely-not-a-binary-xyz --strict" } });
  run(repo, "init", "add-auth");

  const r = run(repo, "baseline", "add-auth");

  assert.equal(r.code, 2);
  assert.match(r.stderr, /CONFIG_STALE/);
  assert.match(r.stderr, /definitely-not-a-binary-xyz/);
  assert.ok(!existsSync(join(repo, ".harness", "add-auth", "baseline.json")));
});

test("baseline halts on a package the config does not carry", () => {
  const repo = makeRepo({ commands: {}, packages: { api: { path: "." } } });
  run(repo, "init", "add-auth");

  const r = run(repo, "baseline", "add-auth", "--packages", "api,ghost");

  assert.equal(r.code, 2);
  assert.match(r.stderr, /PACKAGE_UNKNOWN/);
  assert.match(r.stderr, /ghost/);
});

test("baseline runs each package's bootstrap first", () => {
  const repo = makeRepo({
    commands: {},
    packages: { api: { path: ".", commands: { bootstrap: "touch bootstrapped", test_all: "test -f bootstrapped" } } },
  });
  run(repo, "init", "add-auth");

  const r = run(repo, "baseline", "add-auth", "--packages", "api");

  assert.equal(r.code, 0, r.stderr);
  const baseline = readJson(join(repo, ".harness", "add-auth", "baseline.json"));
  assert.equal((baseline["api"] as Record<string, Record<string, unknown>>)["test"]?.["exit"], 0);
});

const NODE_TEST_OUT = [
  "\u2139 tests 9", "\u2139 suites 0", "\u2139 pass 9", "\u2139 fail 0",
  "\u2139 cancelled 0", "\u2139 skipped 2", "\u2139 todo 0", "\u2139 duration_ms 3064",
].join("\n");

const VITEST_OUT = [
  " Test Files  1 failed | 2 passed (3)",
  "      Tests  2 failed | 40 passed | 3 skipped (45)",
  "   Start at  10:00:00",
].join("\n");

const JEST_OUT = [
  "Test Suites: 1 failed, 2 passed, 3 total",
  "Tests:       2 failed, 40 passed, 3 skipped, 45 total",
].join("\n");

test("parseTests reads node --test, whose counts sit on their own lines", () => {
  assert.deepEqual(parseTests(NODE_TEST_OUT), { passed: 9, failed: 0, skipped: 2 });
});

test("parseTests takes vitest's Tests line, not the Test Files line above it", () => {
  assert.deepEqual(parseTests(VITEST_OUT), { passed: 40, failed: 2, skipped: 3 });
});

test("parseTests takes jest's Tests line, not the Test Suites line above it", () => {
  assert.deepEqual(parseTests(JEST_OUT), { passed: 40, failed: 2, skipped: 3 });
});

test("a red suite is recorded even when its output contains a launch-failure phrase", () => {
  const repo = makeRepo({
    commands: { test_all: `sh -c 'echo "AssertionError: expected command not found"; exit 1'` },
  });
  run(repo, "init", "add-auth");

  const r = run(repo, "baseline", "add-auth");

  assert.equal(r.code, 0, r.stderr);
  const baseline = readJson(join(repo, ".harness", "add-auth", "baseline.json"));
  assert.equal((baseline["root"] as Record<string, Record<string, unknown>>)["test"]?.["exit"], 1);
});

test("baseline halts when a package path does not exist", () => {
  const repo = makeRepo({
    commands: {},
    packages: { api: { path: "nowhere", commands: { test_all: "true" } } },
  });
  run(repo, "init", "add-auth");

  const r = run(repo, "baseline", "add-auth", "--packages", "api");

  assert.equal(r.code, 2);
  assert.match(r.stderr, /CONFIG_STALE/);
});

test("parsers read the common runner summaries", () => {
  assert.equal(parseTypecheck("Found 12 errors in 3 files."), 12);
  assert.equal(parseTypecheck("error: 1 error"), 1);
  assert.equal(parseTypecheck("all good"), null);
  assert.equal(parseLint("✖ 7 problems (2 errors, 5 warnings)"), 5);
  assert.equal(parseLint("clean"), null);
  assert.deepEqual(parseTests("Tests  2 failed | 40 passed | 3 skipped (45)"), { passed: 40, failed: 2, skipped: 3 });
  assert.deepEqual(parseTests("=== 10 passed, 1 skipped in 2.1s ==="), { passed: 10, failed: null, skipped: 1 });
  assert.deepEqual(parseTests("# tests 4\n# pass 3\n# fail 1\n# skipped 0"), { passed: 3, failed: 1, skipped: 0 });
});
