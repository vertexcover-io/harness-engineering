import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const store = require("./comment-store.cjs");
const CLI = join(import.meta.dirname, "comment-store.cjs");
const execFileAsync = promisify(execFile);

// Own directory per test, so a leaked write cannot make the next one pass.
const inSandbox = (fn) => async () => {
  const dir = mkdtempSync(join(tmpdir(), "comment-store-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const comment = (over = {}) => ({
  id: "c1",
  body: "why sqlite here?",
  anchor: { id: "D3", label: "Design › D3", quote: "SQLite for the queue" },
  ...over,
});

const cli = (dir, ...args) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });

test("read returns an empty store when no file exists", inSandbox((dir) => {
  assert.deepEqual(store.read(dir), { version: 1, comments: [] });
}));

test("read refuses to fabricate an empty store from an unreadable file", inSandbox((dir) => {
  writeFileSync(join(dir, "comments.json"), "{ not json");
  assert.throws(() => store.read(dir), store.CorruptStoreError);
}));

test("a corrupt store survives a submit instead of being overwritten", inSandbox((dir) => {
  store.submit(dir, [comment()], 1000);
  const intact = readFileSync(join(dir, "comments.json"), "utf8");
  writeFileSync(join(dir, "comments.json"), intact.slice(0, 40));

  assert.throws(() => store.submit(dir, [comment({ id: "c2" })], 2000), store.CorruptStoreError);
  assert.equal(readFileSync(join(dir, "comments.json"), "utf8"), intact.slice(0, 40));
}));

test("readOrEmpty degrades for display surfaces that never write back", inSandbox((dir) => {
  writeFileSync(join(dir, "comments.json"), "{ not json");
  assert.deepEqual(store.readOrEmpty(dir), { version: 1, comments: [] });
}));

test("submit stores comments as sent and stamps them", inSandbox((dir) => {
  const saved = store.submit(dir, [comment()], 1000);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].status, "sent");
  assert.equal(saved[0].sentAt, 1000);
  assert.deepEqual(saved[0].replies, []);
  assert.equal(store.read(dir).comments[0].body, "why sqlite here?");
}));

test("submit drops a comment with an empty body", inSandbox((dir) => {
  const saved = store.submit(dir, [comment({ body: "   " }), comment({ id: "c2" })], 1000);
  assert.deepEqual(saved.map((c) => c.id), ["c2"]);
}));

test("submit assigns an id when the browser sent none", inSandbox((dir) => {
  const saved = store.submit(dir, [comment({ id: undefined })], 1000);
  assert.match(saved[0].id, /\S/);
}));

// All four statuses: `sent` is the reply-and-ask-back one, and the one a
// status-based guard lets through.
for (const status of ["sent", "answered", "changed", "declined"]) {
  test(`re-submitting an id already replied to with status "${status}" changes nothing`, inSandbox((dir) => {
    store.submit(dir, [comment()], 1000);
    store.reply(dir, "c1", { text: "noted", status }, 1500);

    assert.deepEqual(store.submit(dir, [comment({ body: "REWRITTEN" })], 2000), []);
    const [c] = store.read(dir).comments;
    assert.equal(c.body, "why sqlite here?");
    assert.equal(c.replies.length, 1);
  }));
}

test("re-submitting an id that has no reply yet still changes nothing", inSandbox((dir) => {
  store.submit(dir, [comment()], 1000);
  assert.deepEqual(store.submit(dir, [comment({ body: "edited" })], 2000), []);
  const { comments } = store.read(dir);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, "why sqlite here?");
}));

test("pending returns only comments still awaiting a response", inSandbox((dir) => {
  store.submit(dir, [comment(), comment({ id: "c2", body: "use postgres" })], 1000);
  store.reply(dir, "c1", { text: "answered", status: "answered" }, 1500);
  assert.deepEqual(store.pending(dir).map((c) => c.id), ["c2"]);
}));

test("reply appends to the thread and moves the status", inSandbox((dir) => {
  store.submit(dir, [comment()], 1000);
  const updated = store.reply(dir, "c1", { text: "switched to postgres", status: "changed" }, 2000);
  assert.equal(updated.status, "changed");
  assert.deepEqual(updated.replies, [{ at: 2000, by: "claude", text: "switched to postgres" }]);
}));

test("reply to an unknown id throws a named error", inSandbox((dir) => {
  assert.throws(() => store.reply(dir, "nope", { text: "hi" }, 2000), /no comment with id "nope"/);
}));

test("reply rejects a status the browser cannot render", inSandbox((dir) => {
  store.submit(dir, [comment()], 1000);
  assert.throws(() => store.reply(dir, "c1", { text: "hi", status: "bogus" }, 2000), /status/);
}));

test("a comment keeps its anchor so the reply lands next to the text it is about", inSandbox((dir) => {
  store.submit(dir, [comment()], 1000);
  store.reply(dir, "c1", { text: "ok", status: "answered" }, 2000);
  assert.equal(store.read(dir).comments[0].anchor.quote, "SQLite for the queue");
}));

test("a write leaves no lock behind for the next writer", inSandbox((dir) => {
  store.submit(dir, [comment()], 1000);
  store.reply(dir, "c1", { text: "ok", status: "answered" }, 2000);
  assert.deepEqual(store.submit(dir, [comment({ id: "c2" })], 3000).map((c) => c.id), ["c2"]);
}));

// ========== CLI ==========

test("parseArgs reads a boolean flag without swallowing the next one", () => {
  const { flags } = store.parseArgs(["reply", "/d", "--all", "--id", "X"]);
  assert.deepEqual(flags, { all: true, id: "X" });
});

test("cli list prints pending comments as json", inSandbox((dir) => {
  store.submit(dir, [comment()], 1000);
  assert.deepEqual(JSON.parse(cli(dir, "list", dir)).map((c) => c.id), ["c1"]);
}));

test("cli list --all includes answered comments", inSandbox((dir) => {
  store.submit(dir, [comment()], 1000);
  store.reply(dir, "c1", { text: "ok", status: "answered" }, 1500);
  assert.deepEqual(JSON.parse(cli(dir, "list", dir)), []);
  assert.equal(JSON.parse(cli(dir, "list", dir, "--all")).length, 1);
}));

test("cli reply writes the thread back to disk", inSandbox((dir) => {
  store.submit(dir, [comment()], 1000);
  cli(dir, "reply", dir, "--id", "c1", "--text", "swapped to postgres", "--status", "changed");
  const [c] = JSON.parse(readFileSync(join(dir, "comments.json"), "utf8")).comments;
  assert.equal(c.status, "changed");
  assert.equal(c.replies[0].text, "swapped to postgres");
}));

test("cli wait returns immediately when comments are already pending", inSandbox((dir) => {
  store.submit(dir, [comment()], 1000);
  const out = JSON.parse(cli(dir, "wait", dir, "--timeout-ms", "2000"));
  assert.equal(out.timedOut, false);
  assert.deepEqual(out.comments.map((c) => c.id), ["c1"]);
}));

test("cli wait times out with an empty batch rather than hanging forever", inSandbox((dir) => {
  const out = JSON.parse(cli(dir, "wait", dir, "--timeout-ms", "300", "--poll-ms", "50"));
  assert.equal(out.timedOut, true);
  assert.deepEqual(out.comments, []);
}));

// execFileSync would block this thread, so the comment could never land while
// wait runs.
test("cli wait wakes when a comment lands after it started", inSandbox(async (dir) => {
  const waiting = execFileAsync(process.execPath, [CLI, "wait", dir, "--timeout-ms", "8000", "--poll-ms", "50"]);
  await new Promise((resolve) => setTimeout(resolve, 200));
  store.submit(dir, [comment({ id: "late" })], 3000);
  const out = JSON.parse((await waiting).stdout);
  assert.equal(out.timedOut, false);
  assert.deepEqual(out.comments.map((c) => c.id), ["late"]);
}));
