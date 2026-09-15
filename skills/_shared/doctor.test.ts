import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  compareVersions,
  evaluate,
  installedMarketplace,
  judgeHarnessVersion,
  parseInput,
  parseReport,
  pinnedVersion,
  projectDoctor,
  renderTable,
  summarize,
  verdict,
  type Check,
  type Result,
} from "./doctor.ts";

const row = (overrides: Partial<Result>): Result => ({
  name: "x",
  optional: false,
  status: "ok",
  detail: "",
  fix: [],
  ...overrides,
});

test("evaluate caps an optional failure at warn and keeps a required one as fail", () => {
  const failing: Check = { name: "t", fix: ["install t"], run: () => ({ status: "fail", detail: "gone" }) };
  assert.equal(evaluate(failing, "/").status, "fail");
  assert.equal(evaluate({ ...failing, optional: true }, "/").status, "warn");
});

test("evaluate prefers the outcome's fix over the check's default", () => {
  const check: Check = { name: "t", fix: ["default"], run: () => ({ status: "warn", detail: "", fix: ["specific"] }) };
  assert.deepEqual(evaluate(check, "/").fix, ["specific"]);
});

test("verdict names the failed checks, then the warned ones, else READY", () => {
  assert.equal(verdict(summarize([row({ name: "a", status: "fail" }), row({ name: "b", status: "warn" })])), "BLOCKED a");
  assert.equal(verdict(summarize([row({ name: "b", status: "warn" })])), "DEGRADED b");
  assert.equal(verdict(summarize([row({})])), "READY");
});

test("parseInput strips --auto and classifies the remainder", () => {
  assert.deepEqual(parseInput("--auto https://app.asana.com/0/1/2"), {
    autoMode: true,
    preRelease: false,
    inputKind: "ticket",
    inputRef: "https://app.asana.com/0/1/2",
  });
  assert.deepEqual(parseInput("add dark mode"), { autoMode: false, preRelease: false, inputKind: "prompt", inputRef: "" });
});

test("parseInput strips --pre-release alongside --auto", () => {
  assert.deepEqual(parseInput("--pre-release https://app.asana.com/0/1/2 --auto"), {
    autoMode: true,
    preRelease: true,
    inputKind: "ticket",
    inputRef: "https://app.asana.com/0/1/2",
  });
});

test("compareVersions orders a pre-release below the version it leads to", () => {
  assert.ok(compareVersions("1.32.0-rc.1", "1.32.0") < 0);
  assert.ok(compareVersions("1.32.0-rc.1", "1.31.1") > 0);
  assert.ok(compareVersions("1.32.0-rc.2", "1.32.0-rc.10") < 0);
  assert.ok(compareVersions("1.32.0-alpha", "1.32.0-rc.1") < 0);
  assert.equal(compareVersions("1.31.1", "1.31.1"), 0);
  assert.ok(compareVersions("1.9.0", "1.10.0") < 0);
});

test("pinnedVersion reads the tag a marketplace pins harness to", () => {
  const marketplace = JSON.stringify({
    name: "main",
    plugins: [
      { name: "other", source: { source: "github", repo: "x/y", ref: "v9.9.9" } },
      { name: "harness", source: { source: "github", repo: "vertexcover-io/harness-engineering", ref: "v1.32.0-rc.2" } },
    ],
  });
  assert.equal(pinnedVersion(marketplace), "1.32.0-rc.2");
  assert.equal(pinnedVersion(JSON.stringify({ plugins: [{ name: "harness", source: "./" }] })), null);
  assert.equal(pinnedVersion("404: Not Found"), null);
});

test("installedMarketplace reads the marketplace out of the plugin cache path", () => {
  assert.equal(installedMarketplace("/Users/a/.claude/plugins/cache/main/harness/1.31.1/.claude-plugin/plugin.json"), "main");
  assert.equal(
    installedMarketplace("/Users/a/.claude/plugins/cache/harness-pre-release/harness/1.32.0-rc.1/.claude-plugin/plugin.json"),
    "harness-pre-release",
  );
  assert.equal(installedMarketplace("/src/harness-engineering/.claude-plugin/plugin.json"), null);
  assert.equal(installedMarketplace(null), null);
});

test("judgeHarnessVersion names the installed version and the latest one on the channel", () => {
  const stable = judgeHarnessVersion({ local: "1.31.0", remote: "1.31.1", installedFrom: "main", preRelease: false });
  assert.match(stable.detail, /^current=1\.31\.0 latest-stable=1\.31\.1 /);
  const preRelease = judgeHarnessVersion({
    local: "1.32.0-rc.1",
    remote: "1.32.0-rc.2",
    installedFrom: "harness-pre-release",
    preRelease: true,
  });
  assert.match(preRelease.detail, /^current=1\.32\.0-rc\.1 latest-pre-release=1\.32\.0-rc\.2 /);
});

test("judgeHarnessVersion updates a stale install on its own channel", () => {
  const outcome = judgeHarnessVersion({ local: "1.31.0", remote: "1.31.1", installedFrom: "main", preRelease: false });
  assert.equal(outcome.status, "fail");
  assert.match(outcome.fix?.[0] ?? "", /harness-update\.ts' stable$/);
  assert.match(outcome.fix?.[1] ?? "", /\/reload-plugins/);
  const current = judgeHarnessVersion({ local: "1.31.1", remote: "1.31.1", installedFrom: "main", preRelease: false });
  assert.equal(current.status, "ok");
});

test("judgeHarnessVersion under --pre-release moves a stable install over, even when versions match", () => {
  const outcome = judgeHarnessVersion({ local: "1.31.1", remote: "1.31.1", installedFrom: "main", preRelease: true });
  assert.equal(outcome.status, "fail");
  assert.match(outcome.fix?.[0] ?? "", /harness-update\.ts' pre-release$/);
});

test("judgeHarnessVersion offers a plain run the way back from pre-release without blocking", () => {
  const outcome = judgeHarnessVersion({
    local: "1.32.0-rc.1",
    remote: "1.31.1",
    installedFrom: "harness-pre-release",
    preRelease: false,
  });
  assert.equal(outcome.status, "warn");
  assert.match(outcome.fix?.[0] ?? "", /harness-update\.ts' stable$/);
});

test("judgeHarnessVersion leaves a harness from any other source to its owner", () => {
  const checkout = judgeHarnessVersion({ local: "1.30.0", remote: "1.31.1", installedFrom: null, preRelease: true });
  assert.equal(checkout.status, "ok");
  const localMarketplace = judgeHarnessVersion({ local: "1.30.0", remote: "1.31.1", installedFrom: "harness", preRelease: false });
  assert.equal(localMarketplace.status, "ok");
  assert.match(localMarketplace.detail, /harness/);
});

test("judgeHarnessVersion lets an install run ahead of the pinned tag and never blocks on an unreadable one", () => {
  assert.equal(judgeHarnessVersion({ local: "1.33.0", remote: "1.32.0", installedFrom: "main", preRelease: false }).status, "ok");
  assert.equal(judgeHarnessVersion({ local: null, remote: "1.31.1", installedFrom: "main", preRelease: false }).status, "ok");
  assert.equal(judgeHarnessVersion({ local: "1.31.1", remote: null, installedFrom: "main", preRelease: false }).status, "ok");
});

test("parseReport accepts the contract with defaults and rejects anything else", () => {
  const parsed = parseReport(JSON.stringify({ results: [{ name: "mongo", status: "warn", group: "infra" }] }));
  assert.deepEqual(parsed, [row({ name: "mongo", status: "warn" })]);
  const optionalFail = parseReport(JSON.stringify({ results: [{ name: "elastic", status: "fail", optional: true }] }));
  assert.equal(optionalFail?.[0]?.status, "warn");
  assert.equal(parseReport("not json"), null);
  assert.equal(parseReport(JSON.stringify({ results: [{ name: "x", status: "meh" }] })), null);
  assert.equal(parseReport(JSON.stringify({ ok: true })), null);
});

test("projectDoctor folds a contract-speaking doctor's rows in", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  writeFileSync(join(dir, "orchestrate.config.json"), JSON.stringify({ doctor: "bun bin/doctor.ts" }));
  const calls: string[] = [];
  const exec = (command: string) => {
    calls.push(command);
    return { code: 1, stdout: JSON.stringify({ results: [{ name: "nebula", status: "fail", detail: "missing" }] }) };
  };
  const results = projectDoctor(dir, exec);
  assert.deepEqual(calls, ["bun bin/doctor.ts --json"]);
  assert.deepEqual(results, [row({ name: "nebula", status: "fail", detail: "missing" })]);
});

test("projectDoctor judges a plain command by its exit code", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  writeFileSync(join(dir, "orchestrate.config.json"), JSON.stringify({ doctor: "./check.sh" }));
  const passed = projectDoctor(dir, () => ({ code: 0, stdout: "all good\n" }));
  const failed = projectDoctor(dir, () => ({ code: 2, stdout: "first\nlast line\n" }));
  const missing = projectDoctor(dir, () => ({ code: 127, stdout: "" }));
  assert.equal(passed[0]?.status, "ok");
  assert.equal(failed[0]?.status, "fail");
  assert.equal(failed[0]?.detail, "exit 2: last line");
  assert.match(missing[0]?.detail ?? "", /command not found/);
});

test("projectDoctor is silent when the config has no doctor", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  writeFileSync(join(dir, "orchestrate.config.json"), JSON.stringify({ commands: {} }));
  assert.deepEqual(projectDoctor(dir, () => ({ code: 0, stdout: "" })), []);
});

test("renderTable wraps extra fix steps under the FIX column and hides fixes for ok rows", () => {
  const table = renderTable([
    row({ name: "git", detail: "git 2.4", fix: ["never shown"] }),
    row({ name: "jq", status: "fail", detail: "not on PATH", fix: ["brew install jq", "apt install jq"] }),
  ]);
  const lines = table.split("\n");
  assert.match(lines[0] ?? "", /^CHECK\s+REQUIRED\s+STATUS\s+DETAIL\s+FIX$/);
  assert.match(lines[1] ?? "", /^git\s+yes\s+OK\s+git 2\.4\s+-$/);
  assert.match(lines[2] ?? "", /^jq\s+yes\s+FAIL\s+not on PATH\s+brew install jq$/);
  assert.match(lines[3] ?? "", /^\s+apt install jq$/);
});
