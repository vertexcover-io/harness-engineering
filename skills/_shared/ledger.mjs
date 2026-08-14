// @ts-check
import {
  appendFileSync, readFileSync, writeFileSync, renameSync,
  mkdirSync, rmdirSync, statSync, existsSync,
} from "node:fs";
import { join } from "node:path";

/** @typedef {{ts?:string,type:string,stage?:string,phase?:number,[k:string]:any}} Event */
/** @typedef {{ok:boolean,reason?:string,detail?:string}} Verdict */

// ───────────────────────────── pure core ─────────────────────────────

const empty = () => ({
  event_count: 0,
  bad_lines: 0,
  stages: /** @type {Record<string,any>} */ ({}),
  packages: /** @type {Record<string,any>} */ ({}),
  problems: {
    found: 0, open: 0,
    open_ids: /** @type {string[]} */ ([]),
    by_level: { high: 0, medium: 0, low: 0 },
    items: /** @type {Record<string,any>} */ ({}),
    unknown_resolutions: /** @type {string[]} */ ([]),
  },
});

// The envelope decides what the event applies to: run, stage, or one phase.
const nodeFor = (s, e) => {
  if (!e.stage) return s;
  const stage = (s.stages[e.stage] ??= {});
  if (e.phase == null) return stage;
  return ((stage.phases ??= {})[String(e.phase)] ??= {});
};

const RUN_FIELDS = ["spec", "branch", "base", "auto", "harness", "node", "claude_code", "config_at"];

const handlers = {
  start: (s, node, e) => {
    if (!e.stage) {
      for (const f of RUN_FIELDS) if (e[f] !== undefined) s[f] = e[f];
      s.started = e.ts;
      return;
    }
    node.started ??= e.ts;              // first attempt sets the clock
    if (e.token) node.token = e.token;  // latest token wins — refresh needs the newest transcript
    node.attempts = (node.attempts ?? 0) + 1;
  },

  end: (s, node, e) => {
    node.result = e.result;
    node.finished = e.ts;
    if (e.why) node.why = e.why;
    if (e.phase_count != null) node.phase_count = e.phase_count;
  },

  check: (s, node, e) => {
    const c = ((node.checks ??= {})[e.kind] ??= {});
    for (const f of ["total", "passed", "failed", "errors", "warnings"]) {
      if (typeof e[f] === "number") c[f] = (c[f] ?? 0) + e[f];   // counts accumulate
    }
    if (typeof e.value === "number") c.value = e.value;          // a rate replaces, never sums
    if (e.package) c.package = e.package;
    if (e.proof) (c.proofs ??= []).push(e.proof);
  },

  artifact: (s, node, e) => {
    ((node.artifacts ??= {})[e.kind] = e.path ?? e.sha ?? e.url ?? true);
  },

  problem: (s, node, e) => {
    const p = s.problems;
    p.found++;
    p.open++;
    p.open_ids.push(e.id);
    if (e.level in p.by_level) p.by_level[e.level]++;
    p.items[e.id] = { level: e.level, where: e.where, detail: e.detail, stage: e.stage, kind: e.kind };
  },

  resolution: (s, node, e) => {
    const p = s.problems;
    const i = p.open_ids.indexOf(e.id);
    if (i < 0) { p.unknown_resolutions.push(e.id); return; }
    p.open_ids.splice(i, 1);
    p.open--;
    if (p.items[e.id]) p.items[e.id].how = e.how;
  },

  decision: (s, node, e) => {
    (node.decisions ??= []).push({ kind: e.kind, picked: e.picked, over: e.over, why: e.why });
  },

  question: (s, node, e) => {
    (node.waits ??= []).push({ from: e.ts, topic: e.topic });
    node.questions = (node.questions ?? 0) + 1;
  },

  answer: (s, node, e) => {
    const open = (node.waits ?? []).findLast((w) => !w.to);
    if (open) open.to = e.ts;
  },

  package: (s, node, e) => {
    s.packages[e.name] = { ...e };
    delete s.packages[e.name].type;
    delete s.packages[e.name].ts;
  },

  bad: (s) => { s.bad_lines++; },
};

// Never store an undefined value: JSON.stringify drops those keys, and the state
// must survive a round trip through disk unchanged.
const put = (o, k, v) => { if (v !== undefined) o[k] = v; };

const secondsBetween = (a, b) =>
  a && b ? Math.max(0, Math.round((Date.parse(b) - Date.parse(a)) / 1000)) : undefined;

const waited = (node) =>
  (node.waits ?? []).reduce((n, w) => n + (secondsBetween(w.from, w.to) ?? 0), 0);

// Worst result wins when rolling phases up into their stage.
const WORST = ["blocked", "failed", "ok", "skipped"];
const rollup = (phases) =>
  Object.values(phases)
    .map((p) => /** @type {any} */ (p).result)
    .filter(Boolean)
    .sort((a, b) => WORST.indexOf(a) - WORST.indexOf(b))[0];

const verdictOf = (items) => {
  const lv = Object.values(items).filter((p) => /** @type {any} */ (p).stage === "review");
  if (lv.some((p) => /** @type {any} */ (p).level === "high")) return "changes";
  if (lv.some((p) => /** @type {any} */ (p).level === "medium")) return "suggestions";
  return "approve";
};

// Everything computed lives here — one pass, after every event has landed.
const derive = (s) => {
  let youWaited = 0;
  for (const st of Object.values(s.stages)) {
    const phases = Object.values(st.phases ?? {});
    for (const ph of phases) put(ph, "seconds", secondsBetween(ph.started, ph.finished));

    // A stage dispatched as subagents emits no start/end of its own.
    // Its span is the first phase to open and the last one to close.
    if (phases.length) {
      if (st.started === undefined) put(st, "started", phases.map((p) => p.started).filter(Boolean).sort()[0]);
      if (st.finished === undefined) put(st, "finished", phases.map((p) => p.finished).filter(Boolean).sort().at(-1));
      if (st.result === undefined) put(st, "result", rollup(st.phases));
      // carry the reason up with the result, so a halt names the phase that caused it
      if (st.why === undefined) put(st, "why", phases.find((p) => p.result === st.result && p.why)?.why);
    }
    put(st, "seconds", secondsBetween(st.started, st.finished));
    st.you_waited = waited(st);
    youWaited += st.you_waited;
  }
  if (s.stages.review) s.stages.review.verdict = verdictOf(s.problems.items);
  s.totals = { you_waited: youWaited };
  put(s.totals, "seconds", secondsBetween(s.started, s.finished));
  return s;
};

/** @param {Event[]} events */
export const fold = (events) => {
  const s = empty();
  const ordered = [...events].sort((a, b) => (a.ts ?? "").localeCompare(b.ts ?? ""));
  for (const e of ordered) {
    s.event_count++;
    (handlers[e.type] ?? (() => {}))(s, nodeFor(s, e), e);
  }
  return derive(s);
};

// ───────────────────────────── the gate ─────────────────────────────

const no = (reason, detail) => ({ ok: false, reason, detail });

/** @returns {Verdict} */
export const gate = (state, stageName) => {
  const st = state.stages?.[stageName];
  if (!st) return no("NEVER_RAN", stageName);
  if (st.result === "skipped") return { ok: true };
  if (st.result === "failed") return no("FAILED", st.why ?? stageName);
  if (st.result === "blocked") return no("BLOCKED", st.why ?? stageName);

  for (const [n, ph] of Object.entries(st.phases ?? {})) {
    const p = /** @type {any} */ (ph);
    if (p.result === "blocked") return no("BLOCKED", `phase ${n}: ${p.why ?? "no reason given"}`);
    const t = p.checks?.tests;
    if (!t || !t.total) return no("NO_TESTS", `phase ${n}`);
    if (t.failed > 0) return no("TESTS_FAILED", `phase ${n}`);
    if (!p.checks.tests.proofs?.length) return no("NO_PROOF", `phase ${n}`);
  }

  if (stageName === "verify" && !st.artifacts?.proof) return no("NO_PROOF", "verify wrote no proof");
  if (stageName === "ship" && state.problems.open > 0)
    return no("OPEN_PROBLEMS", state.problems.open_ids.join(" "));

  return { ok: true };
};

// ───────────────────────────── writing ─────────────────────────────

const LOCK_STALE_MS = 30_000;
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const mtimeMs = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

const withLock = (dir, fn) => {
  const lock = join(dir, ".ledger.lock.d");
  for (let i = 0; i < 200; i++) {
    try {
      mkdirSync(lock);
    } catch (err) {
      if (/** @type {any} */ (err).code !== "EEXIST") throw err;
      if (Date.now() - mtimeMs(lock) > LOCK_STALE_MS) { try { rmdirSync(lock); } catch {} }
      sleepSync(25);
      continue;
    }
    try { return fn(); } finally { try { rmdirSync(lock); } catch {} }
  }
  throw new Error("ledger: could not take the lock");
};

const logPath = (dir) => join(dir, "events.jsonl");

const readLog = (dir) => {
  if (!existsSync(logPath(dir))) return [];
  return readFileSync(logPath(dir), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return { type: "bad" }; } });
};

const writeState = (dir, state) => {
  const p = join(dir, "state.json");
  writeFileSync(`${p}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
};

const stamp = (e) => ({ ts: e.ts ?? new Date().toISOString(), ...e });

/** Append one or more events, refold, rewrite state. Never throws at the caller. */
export const add = (dir, events) => {
  try {
    const list = (Array.isArray(events) ? events : [events]).map(stamp);
    if (list.some((e) => !e || typeof e.type !== "string")) throw new Error("event needs a type");
    return withLock(dir, () => {
      appendFileSync(logPath(dir), list.map((e) => `${JSON.stringify(e)}\n`).join(""));
      writeState(dir, fold(readLog(dir)));
      return { ok: true, added: list.length };
    });
  } catch (err) {
    return { ok: false, error: /** @type {Error} */ (err).message };
  }
};

export const rebuild = (dir) => withLock(dir, () => {
  const s = fold(readLog(dir));
  writeState(dir, s);
  return s;
});

// ───────────────────────────── cli ─────────────────────────────

const parseStdin = (text) =>
  text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

export const run = (argv, dir, stdin = "") => {
  const [cmd, ...rest] = argv;
  if (cmd === "add") {
    const r = add(dir, parseStdin(stdin));
    return r.ok ? { exitCode: 0, stdout: "" } : { exitCode: 0, stderr: `ledger: ${r.error}\n` };
  }
  if (cmd === "state") {
    const assertAt = rest.indexOf("--assert");
    const s = rebuild(dir);
    if (assertAt < 0) return { exitCode: 0, stdout: `${JSON.stringify(s, null, 2)}\n` };
    const v = gate(s, rest[assertAt + 1]);
    return v.ok
      ? { exitCode: 0, stdout: "OK\n" }
      : { exitCode: 1, stdout: `${v.reason} ${v.detail ?? ""}\n`.trim() + "\n" };
  }
  return { exitCode: 2, stderr: "usage: ledger add | state [--assert <stage>]\n" };
};

// Only `add` consumes stdin; reading it otherwise throws EAGAIN on a bare terminal.
const readStdin = () => { try { return readFileSync(0, "utf8"); } catch { return ""; } };

const isMain = () => import.meta.url === `file://${process.argv[1]}`;
if (isMain()) {
  const argv = process.argv.slice(2);
  const { exitCode, stdout, stderr } = run(
    argv,
    process.env.LEDGER_DIR ?? ".",
    argv[0] === "add" ? readStdin() : "",
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}
