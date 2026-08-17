import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addUsage, costOf, emptyTotals, readTranscript,
  agentTranscripts, findByToken, attachCosts, projectSlug,
} from "./cost.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "cost-"));

const usage = (o) => ({
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0, ...o,
});

const line = (model, u) => JSON.stringify({ message: { model, usage: u } });

// ───────────────────────── totals ─────────────────────────

test("addUsage sums every field", () => {
  const t = addUsage(addUsage(emptyTotals(), usage({ input_tokens: 10, output_tokens: 2 })),
                     usage({ input_tokens: 5, output_tokens: 3 }));
  assert.equal(t.in, 15);
  assert.equal(t.out, 5);
});

test("addUsage splits the cache write by time to live", () => {
  const t = addUsage(emptyTotals(), usage({
    cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 },
  }));
  assert.equal(t.cache_write_5m, 600);
  assert.equal(t.cache_write_1h, 400);
});

test("a transcript with no time-to-live split counts as the 5 minute rate", () => {
  const t = addUsage(emptyTotals(), usage({ cache_creation_input_tokens: 800 }));
  assert.equal(t.cache_write_5m, 800);
  assert.equal(t.cache_write_1h, 0);
});

// ───────────────────────── price ─────────────────────────

test("costOf prices input, output, cache reads and both cache writes", () => {
  // opus-4-8 is $5 in / $25 out per 1M.
  const t = { in: 1e6, out: 1e6, cache_read: 1e6, cache_write_5m: 1e6, cache_write_1h: 1e6 };
  // 5 + 25 + 0.5 + 6.25 + 10
  assert.equal(costOf("claude-opus-4-8", t), 46.75);
});

test("a cache read costs a tenth of the input rate", () => {
  assert.equal(costOf("claude-opus-4-8", { ...emptyTotals(), cache_read: 1e6 }), 0.5);
});

test("a one hour cache write costs more than a five minute one", () => {
  const h = costOf("claude-opus-4-8", { ...emptyTotals(), cache_write_1h: 1e6 });
  const m = costOf("claude-opus-4-8", { ...emptyTotals(), cache_write_5m: 1e6 });
  assert.equal(h, 10);
  assert.equal(m, 6.25);
});

test("an unpriced model reports no cost rather than a wrong one", () => {
  assert.equal(costOf("claude-opus-4-1", { ...emptyTotals(), in: 1e6 }), null);
  assert.equal(costOf(null, emptyTotals()), null);
});

// ───────────────────────── reading a transcript ─────────────────────────

test("readTranscript sums a file and names the model", () => {
  const d = tmp();
  const p = join(d, "agent-a1.jsonl");
  writeFileSync(p, [
    line("claude-opus-4-8", usage({ input_tokens: 100, output_tokens: 10 })),
    line("claude-opus-4-8", usage({ input_tokens: 50, output_tokens: 5 })),
  ].join("\n"));
  const r = readTranscript(p);
  assert.equal(r.model, "claude-opus-4-8");
  assert.equal(r.totals.in, 150);
  assert.equal(r.totals.out, 15);
  assert.ok(r.cost_usd > 0);
});

test("a transcript with no usage block reads as null, not as zero", () => {
  const d = tmp();
  const p = join(d, "agent-empty.jsonl");
  writeFileSync(p, JSON.stringify({ type: "user", message: { content: "hi" } }));
  assert.equal(readTranscript(p), null);
});

test("a corrupt line does not stop the read", () => {
  const d = tmp();
  const p = join(d, "agent-a2.jsonl");
  writeFileSync(p, ["not json", line("claude-opus-4-8", usage({ input_tokens: 7 }))].join("\n"));
  assert.equal(readTranscript(p).totals.in, 7);
});

test("a synthetic model name is ignored", () => {
  const d = tmp();
  const p = join(d, "agent-a3.jsonl");
  writeFileSync(p, [
    line("claude-opus-4-8", usage({ input_tokens: 5 })),
    line("<synthetic>", usage({ input_tokens: 5 })),
  ].join("\n"));
  assert.equal(readTranscript(p).model, "claude-opus-4-8");
});

// ───────────────────────── attribution ─────────────────────────

test("agentTranscripts finds subagent files at any depth", () => {
  const d = tmp();
  mkdirSync(join(d, "subagents", "workflows", "wf_1"), { recursive: true });
  writeFileSync(join(d, "subagents", "agent-a.jsonl"), "");
  writeFileSync(join(d, "subagents", "workflows", "wf_1", "agent-b.jsonl"), "");
  assert.equal(agentTranscripts(d).length, 2);
});

test("findByToken picks the one file that witnessed the token", () => {
  const d = tmp();
  mkdirSync(join(d, "subagents"), { recursive: true });
  const a = join(d, "subagents", "agent-a.jsonl");
  const b = join(d, "subagents", "agent-b.jsonl");
  writeFileSync(a, "ledger add --token aaa111\n");
  writeFileSync(b, "ledger add --token bbb222\n");
  assert.equal(findByToken(agentTranscripts(d), "bbb222"), b);
  assert.equal(findByToken(agentTranscripts(d), "ccc333"), null);
});

// ───────────────────────── attaching to state ─────────────────────────

const stateWithPhases = () => ({
  stages: {
    coder: { phases: { 3: { token: "aaa111" }, 4: { token: "bbb222" } } },
    review: {},
  },
  totals: { you_waited: 0 },
});

test("attachCosts fills each phase from its own transcript and totals them", () => {
  const readings = {
    aaa111: { model: "claude-opus-4-8", totals: { ...emptyTotals(), in: 1e6 }, cost_usd: 5 },
    bbb222: { model: "claude-opus-4-8", totals: { ...emptyTotals(), in: 2e6 }, cost_usd: 10 },
  };
  const s = attachCosts(stateWithPhases(), (t) => readings[t] ?? null);
  assert.equal(s.stages.coder.phases[3].cost_usd, 5);
  assert.equal(s.stages.coder.phases[4].cost_usd, 10);
  assert.equal(s.stages.coder.cost_usd, 15);
  assert.equal(s.totals.cost_usd, 15);
});

test("a phase whose transcript is missing is left alone, not zeroed", () => {
  const s = attachCosts(stateWithPhases(), () => null);
  assert.equal(s.stages.coder.phases[3].cost_usd, undefined);
  assert.equal(s.totals.cost_usd, undefined);
});

test("a phase with no token is skipped", () => {
  const s = attachCosts(
    { stages: { coder: { phases: { 3: {} } } }, totals: {} },
    () => { throw new Error("lookup must not be called"); },
  );
  assert.equal(s.stages.coder.phases[3].cost_usd, undefined);
});

test("an unpriced model still records its tokens", () => {
  const s = attachCosts(stateWithPhases(), (t) =>
    t === "aaa111" ? { model: "claude-opus-4-1", totals: { ...emptyTotals(), in: 99 }, cost_usd: null } : null);
  assert.equal(s.stages.coder.phases[3].tokens.in, 99);
  assert.equal(s.stages.coder.phases[3].cost_usd, undefined);
});

test("projectSlug encodes a working directory the way Claude Code does", () => {
  assert.equal(projectSlug("/Users/me/Projects/thing"), "-Users-me-Projects-thing");
});
