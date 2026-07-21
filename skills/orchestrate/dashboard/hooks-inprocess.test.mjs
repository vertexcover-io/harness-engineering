import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run as dagRun } from "./dag-update.mjs";
import { run as askRun } from "./ask-user-hook.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAG_CLI = join(HERE, "dag-update.mjs");
const BREADCRUMB = join(tmpdir(), ".claude-harness-active");

const makeHarnessDir = (outcome, nodes) => {
  const dir = mkdtempSync(join(tmpdir(), "dag-inproc-"));
  writeFileSync(
    join(dir, "dag.json"),
    JSON.stringify({ meta: { outcome }, nodes }, null, 2),
  );
  return dir;
};

const readOutcome = (dir) => JSON.parse(readFileSync(join(dir, "dag.json"), "utf8")).meta.outcome;
const readStatus = (dir, id) => JSON.parse(readFileSync(join(dir, "dag.json"), "utf8")).nodes[id].status;

const withHarnessDir = async (dir, fn) => {
  const prev = process.env.HARNESS_DIR;
  process.env.HARNESS_DIR = dir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.HARNESS_DIR;
    else process.env.HARNESS_DIR = prev;
  }
};

test("S6: dagRun(['finalize','done']) in-process flips a running dag to done - returns exitCode 0", async () => {
  const dir = makeHarnessDir("running", { n1: { status: "running", label: "P1" } });
  try {
    const { exitCode } = await withHarnessDir(dir, () => dagRun(["finalize", "done"]));
    assert.equal(exitCode, 0);
    assert.equal(readOutcome(dir), "done");
    assert.equal(readStatus(dir, "n1"), "done");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S6: dagRun(['finalize']) is a no-op returning 0 when the dag is not running", async () => {
  const dir = makeHarnessDir("done", { n1: { status: "done" } });
  try {
    const { exitCode } = await withHarnessDir(dir, () => dagRun(["finalize", "interrupted"]));
    assert.equal(exitCode, 0);
    assert.equal(readOutcome(dir), "done");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S6: dagRun with an unknown subcommand returns exitCode 1 + usage - never calls process.exit", async () => {
  const { exitCode, stderr } = await dagRun(["bogus"]);
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes("Usage:"), `expected usage, got:\n${stderr}`);
});

test("S6: dagRun(['set-status',...]) in-process updates a node status", async () => {
  const dir = makeHarnessDir("running", { n1: { status: "running" } });
  try {
    const { exitCode } = await withHarnessDir(dir, () => dagRun(["set-status", "n1", "waiting"]));
    assert.equal(exitCode, 0);
    assert.equal(readStatus(dir, "n1"), "waiting");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("S6: askRun('pre') flips the last running node to waiting via in-process dag call", async () => {
  const dir = makeHarnessDir("running", { n1: { status: "running", label: "P1" } });
  writeFileSync(BREADCRUMB, dir);
  try {
    const { exitCode } = await askRun(["pre"]);
    assert.equal(exitCode, 0);
    assert.equal(readStatus(dir, "n1"), "waiting");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(BREADCRUMB, { force: true });
  }
});

test("S6: askRun('post') flips the last waiting node back to running", async () => {
  const dir = makeHarnessDir("running", { n1: { status: "waiting", label: "P1" } });
  writeFileSync(BREADCRUMB, dir);
  try {
    const { exitCode } = await askRun(["post"]);
    assert.equal(exitCode, 0);
    assert.equal(readStatus(dir, "n1"), "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(BREADCRUMB, { force: true });
  }
});

test("S6: askRun is a no-op returning 0 when the breadcrumb is absent", async () => {
  rmSync(BREADCRUMB, { force: true });
  const { exitCode } = await askRun(["pre"]);
  assert.equal(exitCode, 0);
});

test("S7: dag-update.mjs CLI still exits 1 with usage on an unknown subcommand", () => {
  const r = spawnSync(process.execPath, [DAG_CLI, "bogus"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.ok((r.stderr || "").includes("Usage:"), `expected usage on stderr, got:\n${r.stderr}`);
});
