// The two halves of the comment path that are not the store: the browser's
// draft reconciliation and the server's handling of a submitted batch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);

// comments-ui.js is a plain injected <script>, and this package is
// "type": "module", so require() reads it as ESM and skips its export block.
// A vm sandbox with `module` present gets the helpers out of the real file.
const uiSandbox = { module: { exports: {} } };
vm.createContext(uiSandbox);
vm.runInContext(readFileSync(join(import.meta.dirname, "comments-ui.js"), "utf8"), uiSandbox);
const ui = uiSandbox.module.exports;

const draft = (id, over = {}) => ({ id, body: "why sqlite here?", anchor: { id: "D3", label: "Design › D3", quote: "" }, ...over });

// ========== the browser half ==========

test("a draft survives until the server echoes its id back", () => {
  const drafts = [draft("c1"), draft("c2")];
  assert.deepEqual(ui.unacknowledgedDrafts(drafts, [{ id: "c1" }]).map((d) => d.id), ["c2"]);
});

test("an echo from another tab retires the draft too", () => {
  assert.deepEqual(ui.unacknowledgedDrafts([draft("c1")], [{ id: "c1" }]), []);
});

test("an empty echo retires nothing — a send that never landed stays a draft", () => {
  assert.deepEqual(ui.unacknowledgedDrafts([draft("c1")], []).map((d) => d.id), ["c1"]);
});

test("markSending flags only the batch, and does not mutate the originals", () => {
  const drafts = [draft("c1"), draft("c2")];
  const marked = ui.markSending(drafts, ["c1"]);
  assert.equal(marked[0].sending, true);
  assert.equal(marked[1].sending, undefined);
  assert.equal(drafts[0].sending, undefined);
});

// ========== the server half ==========

// server.cjs reads STATE_DIR once at module load and require caches it, so the
// env is set before the require and every test shares one cleared directory.
const sandbox = mkdtempSync(join(tmpdir(), "comments-wiring-"));
process.env.BRAINSTORM_DIR = sandbox;
const server = require("./server.cjs");
const STATE_DIR = server.STATE_DIR;

const clearState = () => {
  rmSync(join(STATE_DIR, "comments.json"), { force: true });
  rmSync(join(STATE_DIR, "events"), { force: true });
};

const onFreshState = (fn) => () => {
  clearState();
  try {
    return fn();
  } finally {
    clearState();
  }
};

test("a submitted batch reaches comments.json", onFreshState(() => {
  server.handleMessage(JSON.stringify({ type: "comments", comments: [draft("c1")] }));
  const stored = JSON.parse(readFileSync(join(STATE_DIR, "comments.json"), "utf8"));
  assert.deepEqual(stored.comments.map((c) => c.id), ["c1"]);
  assert.equal(stored.comments[0].status, "sent");
}));

// The agent reads this log when the watcher never woke it.
test("a submitted batch also leaves a line in the events log", onFreshState(() => {
  server.handleMessage(JSON.stringify({ type: "comments", comments: [draft("c1")] }));
  const lines = readFileSync(join(STATE_DIR, "events"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.filter((l) => l.type === "comments").length, 1);
}));

test("a malformed message is ignored rather than crashing the server", onFreshState(() => {
  server.handleMessage("{ not json");
  server.handleMessage(JSON.stringify({ type: "comments" }));
  assert.equal(existsSync(join(STATE_DIR, "comments.json")), false);
}));

// Asserts on the events file, not just the store: the store is right either way,
// so reading it alone lets the guard be deleted without a test noticing.
test("a comment the store rejects leaves no events line claiming it landed", onFreshState(() => {
  server.handleMessage(JSON.stringify({ type: "comments", comments: [draft("c1")] }));
  rmSync(join(STATE_DIR, "events"), { force: true });

  server.handleMessage(JSON.stringify({ type: "comments", comments: [draft("c1", { body: "REWRITTEN" })] }));

  assert.equal(existsSync(join(STATE_DIR, "events")), false);
  const stored = JSON.parse(readFileSync(join(STATE_DIR, "comments.json"), "utf8"));
  assert.equal(stored.comments.length, 1);
  assert.equal(stored.comments[0].body, "why sqlite here?");
}));

test("a submit that throws leaves neither a store write nor an events line", onFreshState(() => {
  server.handleMessage(JSON.stringify({ type: "comments", comments: [draft("c1")] }));
  rmSync(join(STATE_DIR, "events"), { force: true });
  writeFileSync(join(STATE_DIR, "comments.json"), "{ not json");

  server.handleMessage(JSON.stringify({ type: "comments", comments: [draft("c2")] }));

  assert.equal(existsSync(join(STATE_DIR, "events")), false);
  assert.equal(readFileSync(join(STATE_DIR, "comments.json"), "utf8"), "{ not json");
}));
