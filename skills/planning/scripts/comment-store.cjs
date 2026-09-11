#!/usr/bin/env node
// The review-comment store behind plan.html's comment dock, at
// <state-dir>/comments.json. Two processes write it — the server when the page
// submits, the agent when it replies — which is why the writes below lock.

const fs = require('fs');
const path = require('path');

const STORE_NAME = 'comments.json';
const OPEN_STATUSES = ['sent'];
const REPLY_STATUSES = ['answered', 'changed', 'declined', 'sent'];
const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 30000;

const storePath = (stateDir) => path.join(stateDir, STORE_NAME);
const lockPath = (stateDir) => storePath(stateDir) + '.lock';

// Fresh object per call: a shared one lets a caller's push leak into the next
// read, and the server holds this module open for hours.
const empty = () => ({ version: 1, comments: [] });

class CorruptStoreError extends Error {
  constructor(file, cause) {
    super(`comment store at ${file} is unreadable: ${cause}`);
    this.name = 'CorruptStoreError';
    this.file = file;
  }
}

// An absent store is empty; an unparseable one throws. Returning empty for a
// corrupt file would let the next write replace real comments with nothing.
function read(stateDir) {
  let raw;
  try {
    raw = fs.readFileSync(storePath(stateDir), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return empty();
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new CorruptStoreError(storePath(stateDir), e.message);
  }
  if (!parsed || !Array.isArray(parsed.comments)) {
    throw new CorruptStoreError(storePath(stateDir), 'no comments array');
  }
  return { version: parsed.version || 1, comments: parsed.comments };
}

// For the display-only callers — `list --all` and the server's two socket
// pushes. No write follows, so an empty result cannot overwrite anything.
function readOrEmpty(stateDir) {
  try {
    return read(stateDir);
  } catch (e) {
    if (e instanceof CorruptStoreError) return empty();
    throw e;
  }
}

function write(stateDir, data) {
  fs.mkdirSync(stateDir, { recursive: true });
  // Pid-scoped: a shared temp name lets two writers truncate each other and
  // publish a torn store.
  const tmp = `${storePath(stateDir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, storePath(stateDir));
}

function acquireLock(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = lockPath(stateDir);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(file);
      } catch (staleErr) { /* another writer got there first */ }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${file}`);
      // Sync spin: callers are a CLI and one socket handler, and going async
      // would spread through every caller for a wait this short.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
    }
  }
}

const releaseLock = (file) => {
  try { fs.unlinkSync(file); } catch (e) { /* already gone */ }
};

function withLock(stateDir, fn) {
  const file = acquireLock(stateDir);
  try {
    return fn();
  } finally {
    releaseLock(file);
  }
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

const anchorOf = (raw) => {
  const a = (raw && raw.anchor) || {};
  return {
    id: nonEmpty(a.id) ? a.id : '',
    label: nonEmpty(a.label) ? a.label : '',
    quote: nonEmpty(a.quote) ? a.quote : '',
  };
};

const normalize = (raw, now, index) => ({
  id: nonEmpty(raw.id) ? raw.id : `c${now}-${index}`,
  body: raw.body.trim(),
  anchor: anchorOf(raw),
  status: 'sent',
  sentAt: now,
  replies: [],
});

// An existing id is never rewritten: the agent may be reading that comment, and
// a body that changes under a standing reply misrepresents what was asked.
function submit(stateDir, incoming, now = Date.now()) {
  return withLock(stateDir, () => {
    const data = read(stateDir);
    const seen = new Set(data.comments.map((c) => c.id));
    const saved = [];

    (Array.isArray(incoming) ? incoming : []).forEach((raw, i) => {
      if (!raw || !nonEmpty(raw.body)) return;
      const next = normalize(raw, now, i);
      if (seen.has(next.id)) return;
      data.comments.push(next);
      seen.add(next.id);
      saved.push(next);
    });

    if (saved.length) write(stateDir, data);
    return saved;
  });
}

const pending = (stateDir) => read(stateDir).comments.filter((c) => OPEN_STATUSES.includes(c.status));

function reply(stateDir, id, { text, status = 'answered' }, now = Date.now()) {
  if (!REPLY_STATUSES.includes(status)) {
    throw new Error(`unknown status "${status}" — use one of ${REPLY_STATUSES.join(', ')}`);
  }
  return withLock(stateDir, () => {
    const data = read(stateDir);
    const target = data.comments.find((c) => c.id === id);
    if (!target) throw new Error(`no comment with id "${id}"`);

    if (nonEmpty(text)) target.replies.push({ at: now, by: 'claude', text: text.trim() });
    target.status = status;
    write(stateDir, data);
    return target;
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wait(stateDir, { timeoutMs = 4 * 60 * 60 * 1000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const comments = pending(stateDir);
    if (comments.length) return { timedOut: false, comments };
    if (Date.now() >= deadline) return { timedOut: true, comments: [] };
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

// ========== CLI ==========

// A `--name` followed by another flag, or by nothing, is boolean `true`.
function parseArgs(argv) {
  const [command, stateDir, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) continue;
    const next = rest[i + 1];
    const isBoolean = next === undefined || next.startsWith('--');
    flags[rest[i].slice(2)] = isBoolean ? true : next;
    if (!isBoolean) i++;
  }
  return { command, stateDir, flags };
}

const USAGE = `Usage:
  comment-store.cjs list  <state-dir> [--all]
  comment-store.cjs wait  <state-dir> [--timeout-ms N] [--poll-ms N]
  comment-store.cjs reply <state-dir> --id ID --text TEXT [--status answered|changed|declined|sent]
`;

async function main(argv) {
  const { command, stateDir, flags } = parseArgs(argv);
  if (!command || !stateDir) {
    process.stderr.write(USAGE);
    return 2;
  }

  if (command === 'list') {
    const out = flags.all ? readOrEmpty(stateDir).comments : pending(stateDir);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return 0;
  }

  if (command === 'wait') {
    const result = await wait(stateDir, {
      timeoutMs: Number(flags['timeout-ms']) || undefined,
      pollMs: Number(flags['poll-ms']) || undefined,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }

  if (command === 'reply') {
    if (typeof flags.id !== 'string') {
      process.stderr.write(USAGE);
      return 2;
    }
    const updated = reply(stateDir, flags.id, {
      text: typeof flags.text === 'string' ? flags.text : '',
      status: typeof flags.status === 'string' ? flags.status : 'answered',
    });
    process.stdout.write(JSON.stringify(updated, null, 2) + '\n');
    return 0;
  }

  process.stderr.write(USAGE);
  return 2;
}

module.exports = {
  read, readOrEmpty, write, submit, pending, reply, wait, parseArgs,
  CorruptStoreError, STORE_NAME,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(String(err.message || err) + '\n');
      process.exit(1);
    },
  );
}
