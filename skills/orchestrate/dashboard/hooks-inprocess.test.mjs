import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
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

const firstLine = (child) =>
  new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl !== -1) resolve(buf.slice(0, nl));
    });
    child.once("exit", (code) => reject(new Error(`exited ${code} before printing a URL`)));
  });

test("CLI 'serve' keeps serving after printing its URL - it must not exit 0 immediately", async () => {
  const dir = makeHarnessDir("running", { n1: { status: "running" } });
  const child = spawn(process.execPath, [DAG_CLI, "serve"], {
    env: { ...process.env, HARNESS_DIR: dir, BROWSER: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const url = await firstLine(child);
    assert.match(url, /^http:\/\/localhost:\d+$/);
    assert.equal(child.exitCode, null, "serve process died instead of staying up");

    const res = await fetch(`${url}/`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<html/i);
    assert.equal((await fetch(`${url}/dag.json`)).status, 200);
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI 'set-status' still exits 0 promptly - keeping serve alive must not hang the other commands", () => {
  const dir = makeHarnessDir("running", { n1: { status: "running" } });
  try {
    const r = spawnSync(process.execPath, [DAG_CLI, "set-status", "n1", "done"], {
      env: { ...process.env, HARNESS_DIR: dir },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(r.status, 0);
    assert.equal(r.signal, null, "command did not exit on its own");
    assert.equal(readStatus(dir, "n1"), "done");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── serve-start: detached, idempotent, reaping ────────────────────────────────

const readPid = (dir) => {
  const p = join(dir, "server.pid");
  return existsSync(p) ? parseInt(readFileSync(p, "utf8").trim(), 10) : null;
};

const alive = (pid) => {
  if (!Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const killPid = (pid) => { try { process.kill(pid); } catch {} };

const serveStart = (dir, cwd) =>
  spawnSync(process.execPath, [DAG_CLI, "serve-start"], {
    env: { ...process.env, HARNESS_DIR: dir, BROWSER: "true" },
    cwd: cwd || dir,
    encoding: "utf8",
    timeout: 15000,
  });

test("serve-start returns promptly and its server outlives the process that started it", async () => {
  const dir = makeHarnessDir("running", { n1: { status: "running" } });
  let pid = null;
  try {
    const r = serveStart(dir);
    assert.equal(r.status, 0, `serve-start failed: ${r.stderr}`);
    const url = (r.stdout || "").trim();
    assert.match(url, /^http:\/\/localhost:\d+$/);

    // spawnSync has already reaped the starter process — anything still listening is detached.
    pid = readPid(dir);
    assert.ok(alive(pid), "detached server is not running after its starter exited");
    assert.equal((await fetch(`${url}/dag.json`)).status, 200);
  } finally {
    killPid(pid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve-start twice starts one server and prints the same URL", async () => {
  const dir = makeHarnessDir("running", { n1: { status: "running" } });
  let pid = null;
  try {
    const first = serveStart(dir);
    const firstPid = readPid(dir);
    const second = serveStart(dir);
    pid = readPid(dir);

    assert.equal(second.status, 0, `second serve-start failed: ${second.stderr}`);
    assert.equal((second.stdout || "").trim(), (first.stdout || "").trim());
    assert.equal(pid, firstPid, "second serve-start replaced the running server");
  } finally {
    killPid(pid);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serve-start reaps a finished run's server and leaves a running one alone", async () => {
  const root = mkdtempSync(join(tmpdir(), "dag-reap-"));
  const done = join(root, ".harness", "spec-done");
  const running = join(root, ".harness", "spec-running");
  const mine = join(root, ".harness", "spec-mine");
  let minePid = null;
  const strays = [];
  try {
    for (const [dir, outcome] of [[done, "done"], [running, "running"], [mine, "running"]]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "dag.json"), JSON.stringify({ meta: { outcome }, nodes: {} }));
    }
    // Two stand-in servers: one belonging to a finished run, one to a live run.
    for (const dir of [done, running]) {
      const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      strays.push(c);
      writeFileSync(join(dir, "server.pid"), String(c.pid));
      writeFileSync(join(dir, "server.port"), "1");
    }
    const [strayDone, strayRunning] = strays;

    const r = serveStart(mine, root);
    assert.equal(r.status, 0, `serve-start failed: ${r.stderr}`);
    minePid = readPid(mine);

    // Await the exit event: a signalled child lingers as a zombie until its parent reaps it,
    // so kill(pid, 0) would still report it alive.
    const exited = await Promise.race([
      once(strayDone, "exit").then(() => true),
      sleep(5000).then(() => false),
    ]);
    assert.equal(exited, true, "finished run's server was not reaped");
    assert.equal(existsSync(join(done, "server.pid")), false, "reaped pid file was not removed");
    assert.equal(strayRunning.exitCode, null, "reaped a server belonging to a still-running dag");
  } finally {
    killPid(minePid);
    for (const c of strays) c.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

// ── ordering + staleness guards ──────────────────────────────────────────────

test("askRun('pre') is a no-op when the breadcrumb points at a finished run", async () => {
  const dir = makeHarnessDir("done", { n1: { status: "running", label: "P1" } });
  writeFileSync(BREADCRUMB, dir);
  try {
    const { exitCode } = await askRun(["pre"]);
    assert.equal(exitCode, 0);
    assert.equal(readStatus(dir, "n1"), "running", "a finished run's node was mutated");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(BREADCRUMB, { force: true });
  }
});

test("set-status before init fails loudly with DAG_NOT_INITIALIZED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-noinit-"));
  try {
    const { exitCode, stderr } = await withHarnessDir(dir, () => dagRun(["set-status", "n1", "running"]));
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("DAG_NOT_INITIALIZED"), `expected DAG_NOT_INITIALIZED, got:\n${stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("write-report before init fails loudly with DAG_NOT_INITIALIZED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dag-noinit-"));
  try {
    const { exitCode, stderr } = await withHarnessDir(dir, () => dagRun(["write-report", "n1", "body"]));
    assert.equal(exitCode, 1);
    assert.ok(stderr.includes("DAG_NOT_INITIALIZED"), `expected DAG_NOT_INITIALIZED, got:\n${stderr}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
