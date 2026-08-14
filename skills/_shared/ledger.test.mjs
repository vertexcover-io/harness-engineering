import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold, gate, add, rebuild, run } from "./ledger.mjs";

const T = (mmss) => `2026-08-14T09:${mmss}Z`;
const tmp = () => mkdtempSync(join(tmpdir(), "ledger-"));
const lines = (p) => readFileSync(p, "utf8").split("\n").filter(Boolean);
const state = (d) => JSON.parse(readFileSync(join(d, "state.json"), "utf8"));

const PHASE_OK = [
  { ts: T("42:01"), stage: "coder", phase: 3, type: "start", token: "7f3a9c" },
  { ts: T("51:33"), stage: "coder", phase: 3, type: "check", kind: "tests", total: 12, passed: 12, failed: 0, proof: "p.json" },
  { ts: T("52:12"), stage: "coder", phase: 3, type: "end", result: "ok" },
];

// ───────────────────────── fold: run level ─────────────────────────

test("an empty log folds to an empty state", () => {
  const s = fold([]);
  assert.equal(s.event_count, 0);
  assert.deepEqual(s.stages, {});
  assert.equal(s.problems.found, 0);
});

test("event_count counts every event, including ones with no handler", () => {
  assert.equal(fold([{ ts: T("00:01"), type: "start" }, { ts: T("00:02"), type: "invented" }]).event_count, 2);
});

test("an unknown event type is counted but changes nothing else", () => {
  const s = fold([{ ts: T("00:01"), type: "from-a-newer-version", stage: "coder" }]);
  assert.deepEqual(s.stages.coder, { you_waited: 0 });
});

test("a run-level start records the run fields", () => {
  const s = fold([{ ts: T("02:04"), type: "start", spec: "add-auth", branch: "feat/add-auth", base: "3a74439", auto: false, harness: "1.25.0" }]);
  assert.equal(s.spec, "add-auth");
  assert.equal(s.branch, "feat/add-auth");
  assert.equal(s.base, "3a74439");
  assert.equal(s.auto, false);
  assert.equal(s.harness, "1.25.0");
  assert.equal(s.started, T("02:04"));
});

test("a run-level end gives the run a duration", () => {
  const s = fold([
    { ts: T("02:04"), type: "start", spec: "x" },
    { ts: T("52:04"), type: "end", result: "ok" },
  ]);
  assert.equal(s.result, "ok");
  assert.equal(s.totals.seconds, 3000);
});

// ───────────────────────── fold: the envelope ─────────────────────────

test("no stage means the event applies to the whole run", () => {
  const s = fold([{ ts: T("02:04"), type: "artifact", kind: "readme", path: "README.md" }]);
  assert.equal(s.artifacts.readme, "README.md");
  assert.deepEqual(s.stages, {});
});

test("a stage means the event applies to that stage", () => {
  const s = fold([{ ts: T("21:15"), stage: "planning", type: "artifact", kind: "design", path: "design.md" }]);
  assert.equal(s.stages.planning.artifacts.design, "design.md");
});

test("a stage and a phase mean the event applies to that phase only", () => {
  const s = fold([{ ts: T("51:33"), stage: "coder", phase: 3, type: "check", kind: "tests", total: 12, passed: 12, failed: 0 }]);
  assert.deepEqual(s.stages.coder.phases["3"].checks.tests, { total: 12, passed: 12, failed: 0 });
  assert.equal(s.stages.coder.checks, undefined);
});

// ───────────────────────── fold: check ─────────────────────────

test("two test runs in one phase add up", () => {
  const s = fold([
    { ts: T("50:00"), stage: "coder", phase: 3, type: "check", kind: "tests", total: 8, passed: 8, failed: 0 },
    { ts: T("51:00"), stage: "coder", phase: 3, type: "check", kind: "tests", total: 12, passed: 11, failed: 1 },
  ]);
  assert.deepEqual(s.stages.coder.phases["3"].checks.tests, { total: 20, passed: 19, failed: 1 });
});

test("a rate replaces, it never adds up", () => {
  const s = fold([
    { ts: T("50:00"), stage: "verify", type: "check", kind: "coverage", value: 79.2 },
    { ts: T("51:00"), stage: "verify", type: "check", kind: "coverage", value: 81.4 },
  ]);
  assert.equal(s.stages.verify.checks.coverage.value, 81.4);
});

test("every proof path is kept", () => {
  const s = fold([
    { ts: T("50:00"), stage: "coder", phase: 3, type: "check", kind: "tests", total: 4, proof: "a.json" },
    { ts: T("51:00"), stage: "coder", phase: 3, type: "check", kind: "tests", total: 4, proof: "b.json" },
  ]);
  assert.deepEqual(s.stages.coder.phases["3"].checks.tests.proofs, ["a.json", "b.json"]);
});

test("different check kinds stay apart", () => {
  const s = fold([
    { ts: T("02:51"), stage: "setup", type: "check", kind: "tests", package: "web", total: 412, failed: 0 },
    { ts: T("02:58"), stage: "setup", type: "check", kind: "lint", package: "web", errors: 3 },
  ]);
  assert.equal(s.stages.setup.checks.tests.total, 412);
  assert.equal(s.stages.setup.checks.lint.errors, 3);
});

// ───────────────────────── fold: phases ─────────────────────────

test("the worst phase result becomes the stage result", () => {
  const s = fold([
    ...PHASE_OK,
    { ts: T("49:08"), stage: "coder", phase: 4, type: "start", token: "b2e110" },
    { ts: T("49:10"), stage: "coder", phase: 4, type: "end", result: "blocked", why: "stack will not start" },
  ]);
  assert.equal(s.stages.coder.phases["3"].result, "ok");
  assert.equal(s.stages.coder.phases["4"].result, "blocked");
  assert.equal(s.stages.coder.result, "blocked");
});

test("the blocking reason travels up to the stage", () => {
  const s = fold([
    { ts: T("49:08"), stage: "coder", phase: 4, type: "start" },
    { ts: T("49:10"), stage: "coder", phase: 4, type: "end", result: "blocked", why: "stack will not start" },
  ]);
  assert.equal(s.stages.coder.why, "stack will not start");
});

test("a stage of subagents takes its span from its phases", () => {
  const s = fold([
    { ts: T("42:01"), stage: "coder", phase: 3, type: "start" },
    { ts: T("52:12"), stage: "coder", phase: 3, type: "end", result: "ok" },
    { ts: T("43:00"), stage: "coder", phase: 4, type: "start" },
    { ts: T("58:00"), stage: "coder", phase: 4, type: "end", result: "ok" },
  ]);
  assert.equal(s.stages.coder.started, T("42:01"));
  assert.equal(s.stages.coder.finished, T("58:00"));
  assert.equal(s.stages.coder.seconds, 959);
});

test("a retried phase keeps the newest token and counts the attempts", () => {
  const s = fold([
    { ts: T("42:01"), stage: "coder", phase: 3, type: "start", token: "old111" },
    { ts: T("43:00"), stage: "coder", phase: 3, type: "end", result: "failed" },
    { ts: T("50:00"), stage: "coder", phase: 3, type: "start", token: "new222" },
    { ts: T("55:00"), stage: "coder", phase: 3, type: "end", result: "ok" },
  ]);
  const p = s.stages.coder.phases["3"];
  assert.equal(p.result, "ok");
  assert.equal(p.token, "new222");
  assert.equal(p.attempts, 2);
  assert.equal(p.started, T("42:01"), "the clock starts at the first attempt");
});

test("events out of time order fold the same as events in order", () => {
  const forward = fold(PHASE_OK);
  const shuffled = fold([PHASE_OK[2], PHASE_OK[0], PHASE_OK[1]]);
  assert.deepEqual(shuffled, forward);
});

// ───────────────────────── fold: problems ─────────────────────────

test("a problem is found and open", () => {
  const s = fold([{ ts: T("14:02"), stage: "review", type: "problem", id: "R1", kind: "defect", level: "high", where: "src/auth.ts:42", detail: "== allows coercion" }]);
  assert.equal(s.problems.found, 1);
  assert.equal(s.problems.open, 1);
  assert.equal(s.problems.by_level.high, 1);
  assert.deepEqual(s.problems.open_ids, ["R1"]);
  assert.equal(s.problems.items.R1.detail, "== allows coercion");
});

test("a resolution closes the problem and records how", () => {
  const s = fold([
    { ts: T("14:02"), stage: "review", type: "problem", id: "R1", level: "high", detail: "x" },
    { ts: T("31:40"), stage: "verify", type: "resolution", id: "R1", how: "fixed", commit: "b7d1e08" },
  ]);
  assert.equal(s.problems.found, 1);
  assert.equal(s.problems.open, 0);
  assert.deepEqual(s.problems.open_ids, []);
  assert.equal(s.problems.items.R1.how, "fixed");
});

test("a resolution for an id nobody raised is recorded, not silently dropped", () => {
  const s = fold([{ ts: T("31:40"), stage: "verify", type: "resolution", id: "GHOST", how: "fixed" }]);
  assert.deepEqual(s.problems.unknown_resolutions, ["GHOST"]);
  assert.equal(s.problems.open, 0);
});

test("the review verdict is computed from problem level, never recorded", () => {
  const at = (level) => fold([
    { ts: T("14:02"), stage: "review", type: "problem", id: "R1", level, detail: "x" },
    { ts: T("14:06"), stage: "review", type: "end", result: "ok" },
  ]).stages.review.verdict;
  assert.equal(at("high"), "changes");
  assert.equal(at("medium"), "suggestions");
  assert.equal(at("low"), "approve");
});

test("a problem raised by the coder does not change the review verdict", () => {
  const s = fold([
    { ts: T("49:08"), stage: "coder", phase: 4, type: "problem", id: "P4-1", kind: "library", level: "high", detail: "x" },
    { ts: T("14:06"), stage: "review", type: "end", result: "ok" },
  ]);
  assert.equal(s.stages.review.verdict, "approve");
  assert.equal(s.problems.open, 1);
});

// ───────────────────────── fold: waiting on you ─────────────────────────

test("question and answer pairs add up to your wait", () => {
  const s = fold([
    { ts: T("07:12"), stage: "planning", type: "question", topic: "redis or postgres" },
    { ts: T("12:40"), stage: "planning", type: "answer" },
    { ts: T("20:00"), stage: "planning", type: "question", topic: "cookie name" },
    { ts: T("20:30"), stage: "planning", type: "answer" },
  ]);
  assert.equal(s.stages.planning.you_waited, 358);
  assert.equal(s.stages.planning.questions, 2);
  assert.equal(s.totals.you_waited, 358);
});

test("a question with no answer adds no wait", () => {
  const s = fold([{ ts: T("07:12"), stage: "planning", type: "question", topic: "x" }]);
  assert.equal(s.stages.planning.you_waited, 0);
  assert.equal(s.stages.planning.questions, 1);
});

// ───────────────────────── fold: packages and decisions ─────────────────────────

test("a package event records the commands for one package", () => {
  const s = fold([{ ts: T("02:20"), type: "package", name: "web", path: "packages/web", runner: "vitest", test_all: "pnpm test" }]);
  assert.equal(s.packages.web.runner, "vitest");
  assert.equal(s.packages.web.test_all, "pnpm test");
  assert.equal(s.packages.web.type, undefined, "the envelope fields are stripped");
});

test("a decision records what was picked and what was rejected", () => {
  const s = fold([{ ts: T("19:03"), stage: "planning", type: "decision", kind: "library", picked: "lucia-auth", over: ["next-auth"], why: "cannot host the route handler" }]);
  assert.deepEqual(s.stages.planning.decisions, [
    { kind: "library", picked: "lucia-auth", over: ["next-auth"], why: "cannot host the route handler" },
  ]);
});

// ───────────────────────── gate ─────────────────────────

test("gate blocks a stage that never ran", () => {
  assert.deepEqual(gate(fold([]), "coder"), { ok: false, reason: "NEVER_RAN", detail: "coder" });
});

test("gate passes a skipped stage", () => {
  const s = fold([{ ts: T("42:00"), stage: "coder", type: "end", result: "skipped" }]);
  assert.deepEqual(gate(s, "coder"), { ok: true });
});

test("gate blocks a coder phase that ran no tests", () => {
  const s = fold([
    { ts: T("42:01"), stage: "coder", phase: 3, type: "start" },
    { ts: T("52:12"), stage: "coder", phase: 3, type: "end", result: "ok" },
  ]);
  assert.deepEqual(gate(s, "coder"), { ok: false, reason: "NO_TESTS", detail: "phase 3" });
});

test("gate blocks a coder phase with a failing test", () => {
  const s = fold([
    { ts: T("42:01"), stage: "coder", phase: 3, type: "start" },
    { ts: T("51:33"), stage: "coder", phase: 3, type: "check", kind: "tests", total: 12, passed: 11, failed: 1, proof: "p.json" },
    { ts: T("52:12"), stage: "coder", phase: 3, type: "end", result: "ok" },
  ]);
  assert.deepEqual(gate(s, "coder"), { ok: false, reason: "TESTS_FAILED", detail: "phase 3" });
});

test("gate blocks a passing phase that produced no proof file", () => {
  const s = fold([
    { ts: T("42:01"), stage: "coder", phase: 3, type: "start" },
    { ts: T("51:33"), stage: "coder", phase: 3, type: "check", kind: "tests", total: 12, passed: 12, failed: 0 },
    { ts: T("52:12"), stage: "coder", phase: 3, type: "end", result: "ok" },
  ]);
  assert.deepEqual(gate(s, "coder"), { ok: false, reason: "NO_PROOF", detail: "phase 3" });
});

test("gate passes a proven phase", () => {
  assert.deepEqual(gate(fold(PHASE_OK), "coder"), { ok: true });
});

test("gate names the phase and the reason when one is blocked", () => {
  const s = fold([
    { ts: T("49:08"), stage: "coder", phase: 4, type: "start" },
    { ts: T("49:10"), stage: "coder", phase: 4, type: "end", result: "blocked", why: "auth stack will not start" },
  ]);
  assert.deepEqual(gate(s, "coder"), { ok: false, reason: "BLOCKED", detail: "auth stack will not start" });
});

test("gate blocks verify when no proof report was written", () => {
  const s = fold([{ ts: T("45:02"), stage: "verify", type: "end", result: "ok" }]);
  assert.deepEqual(gate(s, "verify"), { ok: false, reason: "NO_PROOF", detail: "verify wrote no proof" });
});

test("gate passes verify once the proof report exists", () => {
  const s = fold([
    { ts: T("44:50"), stage: "verify", type: "artifact", kind: "proof", path: "verification/proof-report.html" },
    { ts: T("45:02"), stage: "verify", type: "end", result: "ok" },
  ]);
  assert.deepEqual(gate(s, "verify"), { ok: true });
});

test("gate blocks ship while a problem is open", () => {
  const s = fold([
    { ts: T("14:02"), stage: "review", type: "problem", id: "R1", level: "high", detail: "x" },
    { ts: T("47:35"), stage: "ship", type: "end", result: "ok" },
  ]);
  assert.deepEqual(gate(s, "ship"), { ok: false, reason: "OPEN_PROBLEMS", detail: "R1" });
});

test("gate passes ship once every problem is closed", () => {
  const s = fold([
    { ts: T("14:02"), stage: "review", type: "problem", id: "R1", level: "high", detail: "x" },
    { ts: T("31:40"), stage: "verify", type: "resolution", id: "R1", how: "accepted", why: "pre-existing" },
    { ts: T("47:35"), stage: "ship", type: "end", result: "ok" },
  ]);
  assert.deepEqual(gate(s, "ship"), { ok: true });
});

test("gate blocks any stage that finished failed, and gives the reason", () => {
  const s = fold([{ ts: T("45:02"), stage: "verify", type: "end", result: "failed", why: "login is broken" }]);
  assert.deepEqual(gate(s, "verify"), { ok: false, reason: "FAILED", detail: "login is broken" });
});

// ───────────────────────── add ─────────────────────────

test("add writes both files and stamps a time", () => {
  const d = tmp();
  add(d, { type: "start", spec: "x" });
  assert.ok(existsSync(join(d, "events.jsonl")));
  assert.ok(existsSync(join(d, "state.json")));
  assert.match(JSON.parse(lines(join(d, "events.jsonl"))[0]).ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("add keeps the state in step with the log", () => {
  const d = tmp();
  add(d, { type: "start", spec: "x" });
  add(d, { stage: "setup", type: "end", result: "ok" });
  assert.equal(lines(join(d, "events.jsonl")).length, 2);
  assert.equal(state(d).event_count, 2);
  assert.equal(state(d).stages.setup.result, "ok");
});

test("add takes a whole list in one call", () => {
  const d = tmp();
  add(d, PHASE_OK);
  assert.equal(lines(join(d, "events.jsonl")).length, 3);
  assert.equal(state(d).stages.coder.phases["3"].result, "ok");
});

test("add never throws, so it cannot fail its caller", () => {
  const d = tmp();
  const r = add(d, { spec: "no type field" });
  assert.equal(r.ok, false);
  assert.match(r.error, /type/);
  assert.equal(existsSync(join(d, "events.jsonl")), false);
});

test("add keeps every line when many writers run at once", async () => {
  const d = tmp();
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      Promise.resolve().then(() => add(d, { stage: "coder", phase: i, type: "start", token: `t${i}` }))),
  );
  assert.equal(lines(join(d, "events.jsonl")).length, 12);
  assert.equal(state(d).event_count, 12);
  assert.equal(Object.keys(state(d).stages.coder.phases).length, 12);
});

test("a corrupt line is counted, and the rest of the log still folds", () => {
  const d = tmp();
  add(d, PHASE_OK);
  appendFileSync(join(d, "events.jsonl"), "this is not json\n");
  const s = rebuild(d);
  assert.equal(s.bad_lines, 1);
  assert.equal(s.stages.coder.phases["3"].result, "ok");
});

test("rebuild reproduces the state after the state file is lost", () => {
  const d = tmp();
  add(d, PHASE_OK);
  const before = state(d);
  assert.deepEqual(rebuild(d), before);
});

// ───────────────────────── the command line ─────────────────────────

test("add reads one event per line from standard input", () => {
  const d = tmp();
  const stdin = PHASE_OK.map((e) => JSON.stringify(e)).join("\n");
  assert.equal(run(["add"], d, stdin).exitCode, 0);
  assert.equal(state(d).event_count, 3);
});

test("state --assert exits 0 and prints OK when the gate passes", () => {
  const d = tmp();
  add(d, PHASE_OK);
  assert.deepEqual(run(["state", "--assert", "coder"], d), { exitCode: 0, stdout: "OK\n" });
});

test("state --assert exits 1 and prints the reason when the gate fails", () => {
  const d = tmp();
  add(d, [{ ts: T("42:01"), stage: "coder", phase: 3, type: "start" }, { ts: T("52:12"), stage: "coder", phase: 3, type: "end", result: "ok" }]);
  const r = run(["state", "--assert", "coder"], d);
  assert.equal(r.exitCode, 1);
  assert.equal(r.stdout, "NO_TESTS phase 3\n");
});

test("an unknown command exits 2 with usage", () => {
  assert.equal(run(["wat"], tmp()).exitCode, 2);
});
