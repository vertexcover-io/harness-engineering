import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import registerHarnessHooks from "./harness-hooks.ts";

const BREADCRUMB = join(tmpdir(), ".claude-harness-active");

const makeFakePi = () => {
  const handlers = {};
  return { pi: { on(event, handler) { handlers[event] = handler; } }, handlers };
};

const makeFakeCtx = (cwd) => {
  const notifications = [];
  return {
    ctx: { cwd: cwd ?? process.cwd(), ui: { notify: (message, type) => notifications.push({ message, type }) } },
    notifications,
  };
};

const makeDagDir = (nodes) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-ext-dag-"));
  writeFileSync(join(dir, "dag.json"), JSON.stringify({ meta: { outcome: "running" }, nodes }, null, 2));
  return dir;
};
const status = (dir, id) => JSON.parse(readFileSync(join(dir, "dag.json"), "utf8")).nodes[id].status;

test("S8: registers handlers for agent_end, input, session_shutdown", () => {
  const { pi, handlers } = makeFakePi();
  registerHarnessHooks(pi);
  assert.deepEqual(Object.keys(handlers).sort(), ["agent_end", "input", "session_shutdown"]);
});

test("S8: agent_end flips the running node to waiting (ask-user pre) via in-process dag call", async () => {
  const dir = makeDagDir({ n1: { status: "running", label: "P1" } });
  writeFileSync(BREADCRUMB, dir);
  const { pi, handlers } = makeFakePi();
  registerHarnessHooks(pi);
  const { ctx } = makeFakeCtx(dir);
  try {
    await handlers.agent_end({ type: "agent_end" }, ctx);
    assert.equal(status(dir, "n1"), "waiting");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(BREADCRUMB, { force: true });
  }
});

test("S8: input flips the waiting node back to running (ask-user post)", async () => {
  const dir = makeDagDir({ n1: { status: "waiting", label: "P1" } });
  writeFileSync(BREADCRUMB, dir);
  const { pi, handlers } = makeFakePi();
  registerHarnessHooks(pi);
  const { ctx } = makeFakeCtx(dir);
  try {
    await handlers.input({ type: "input" }, ctx);
    assert.equal(status(dir, "n1"), "running");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(BREADCRUMB, { force: true });
  }
});

test("S8: session_shutdown finalize does not throw when no run is active", async () => {
  const { pi, handlers } = makeFakePi();
  registerHarnessHooks(pi);
  const dir = mkdtempSync(join(tmpdir(), "pi-ext-shutdown-"));
  const { ctx } = makeFakeCtx(dir);
  try {
    await handlers.session_shutdown({ type: "session_shutdown" }, ctx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
