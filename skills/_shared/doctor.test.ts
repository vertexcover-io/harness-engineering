import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  evaluate,
  parseInput,
  parseReport,
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
    inputKind: "ticket",
    inputRef: "https://app.asana.com/0/1/2",
  });
  assert.deepEqual(parseInput("add dark mode"), { autoMode: false, inputKind: "prompt", inputRef: "" });
});

test("parseInput tells a findings manifest from a plain file by shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  const manifest = join(dir, "findings.json");
  const plain = join(dir, "brief.md");
  writeFileSync(manifest, JSON.stringify({ findings: [{ auto_fixable: true }] }));
  writeFileSync(plain, "# brief");
  assert.equal(parseInput(manifest).inputKind, "findings");
  assert.equal(parseInput(plain).inputKind, "file");
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
