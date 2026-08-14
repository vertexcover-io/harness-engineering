// @ts-check
// Reads Claude Code transcripts and prices them. Nothing an agent writes is trusted here.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Published $ per 1M tokens, input/output. An unlisted model reports tokens and no cost. */
export const PRICES = {
  "claude-fable-5": [10, 50],
  "claude-mythos-5": [10, 50],
  "claude-opus-5": [5, 25],
  "claude-opus-4-8": [5, 25],
  "claude-opus-4-7": [5, 25],
  "claude-opus-4-6": [5, 25],
  "claude-sonnet-5": [3, 15],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

const CACHE_READ = 0.1;
const WRITE_5M = 1.25;
const WRITE_1H = 2.0;

export const emptyTotals = () => ({ in: 0, out: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 });

/** Add one transcript `usage` block to a running total. */
export const addUsage = (t, usage) => {
  const c = usage.cache_creation ?? {};
  const flat = usage.cache_creation_input_tokens ?? 0;
  return {
    in: t.in + (usage.input_tokens ?? 0),
    out: t.out + (usage.output_tokens ?? 0),
    cache_read: t.cache_read + (usage.cache_read_input_tokens ?? 0),
    // Older transcripts carry no time-to-live split; treat those as the 5 minute rate.
    cache_write_5m: t.cache_write_5m + (c.ephemeral_5m_input_tokens ?? flat),
    cache_write_1h: t.cache_write_1h + (c.ephemeral_1h_input_tokens ?? 0),
  };
};

/** @returns {number|null} null when the model has no published rate. */
export const costOf = (model, t) => {
  const p = PRICES[model];
  if (!p) return null;
  const [i, o] = p;
  return (
    t.in * i +
    t.cache_read * i * CACHE_READ +
    t.cache_write_5m * i * WRITE_5M +
    t.cache_write_1h * i * WRITE_1H +
    t.out * o
  ) / 1e6;
};

const readLines = (path) => {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
};

/** Sum every usage block in one transcript. Returns null when it holds none. */
export const readTranscript = (path) => {
  let totals = emptyTotals();
  let model = null;
  let seen = false;
  for (const line of readLines(path)) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const m = d.message ?? {};
    if (!m.usage) continue;
    seen = true;
    totals = addUsage(totals, m.usage);
    if (m.model && m.model !== "<synthetic>") model = m.model;
  }
  return seen ? { model, totals, cost_usd: costOf(model, totals) } : null;
};

export const projectSlug = (cwd) => cwd.replace(/\//g, "-");

export const sessionDir = (cwd, sessionId) =>
  join(homedir(), ".claude", "projects", projectSlug(cwd), sessionId);

/** Every subagent transcript under a session, at any nesting depth. */
export const agentTranscripts = (dir) => {
  const out = [];
  const walk = (d) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(join(dir, "subagents"));
  return out;
};

/**
 * A subagent records its own token in its own transcript, so exactly one file holds it.
 * This is what makes attribution work while phases run in parallel.
 */
export const findByToken = (paths, token) =>
  paths.find((p) => readFileSync(p, "utf8").includes(token)) ?? null;

/**
 * Attach model, tokens and cost to every phase that carries a token.
 * `lookup` takes a token and returns a reading, so tests need no transcripts.
 */
export const attachCosts = (state, lookup) => {
  let total = 0;
  for (const stage of Object.values(state.stages ?? {})) {
    let stageCost = 0;
    for (const phase of Object.values(stage.phases ?? {})) {
      const p = /** @type {any} */ (phase);
      if (!p.token) continue;
      const r = lookup(p.token);
      if (!r) continue;
      p.model = r.model;
      p.tokens = r.totals;
      if (r.cost_usd != null) { p.cost_usd = round4(r.cost_usd); stageCost += r.cost_usd; }
    }
    if (stageCost > 0) { stage.cost_usd = round4(stageCost); total += stageCost; }
  }
  if (total > 0) (state.totals ??= {}).cost_usd = round4(total);
  return state;
};

const round4 = (n) => Math.round(n * 1e4) / 1e4;

/** Build a token lookup backed by the real transcripts on disk. */
export const transcriptLookup = (cwd, sessionId) => {
  const paths = agentTranscripts(sessionDir(cwd, sessionId));
  const cache = new Map();
  return (token) => {
    if (cache.has(token)) return cache.get(token);
    const hit = findByToken(paths, token);
    const r = hit ? readTranscript(hit) : null;
    cache.set(token, r);
    return r;
  };
};

export const newestSession = (cwd) => {
  const dir = join(homedir(), ".claude", "projects", projectSlug(cwd));
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files[0]?.f.replace(/\.jsonl$/, "") ?? null;
};
