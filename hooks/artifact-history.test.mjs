// Test harness for artifact-history.mjs.
// Each test builds an isolated tmp project with a .harness tree, runs the hook
// in-process, and asserts on which history snapshots landed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./artifact-history.mjs";

const NOW = new Date("2026-08-27T14:32:00Z");

const sandbox = () => mkdtempSync(join(tmpdir(), "artifact-history-"));

const writeArtifact = (dir, spec, rel, body) => {
  const p = join(dir, ".harness", spec, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};

const historyOf = (dir, spec) => {
  const h = join(dir, ".harness", spec, "history");
  return existsSync(h) ? readdirSync(h).filter((f) => !f.startsWith(".")).sort() : [];
};

const go = (dir) => run([], dir, NOW);

const COMPLETE_PLAN = "<html><body><h1>Plan</h1></body></html>";
const BUILDING_PLAN = "<html><body><h1>Plan</h1><!-- SLOT:content --></body></html>";
const UNFILLED_PROOF = '<script type="application/json" id="report-data">\n{ "title": "<feature name>" }\n</script>';
const FILLED_PROOF = '<script type="application/json" id="report-data">\n{ "title": "Checkout flow" }\n</script>';

test("no .harness directory is a clean no-op", () => {
  const dir = sandbox();
  const { exitCode, stdout } = go(dir);
  assert.equal(exitCode, 0);
  assert.equal(stdout, "");
  rmSync(dir, { recursive: true, force: true });
});

test("a half-built plan.html is not archived", () => {
  const dir = sandbox();
  writeArtifact(dir, "add-search", "plan.html", BUILDING_PLAN);
  go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), []);
  rmSync(dir, { recursive: true, force: true });
});

test("a complete plan.html is archived as v1", () => {
  const dir = sandbox();
  writeArtifact(dir, "add-search", "plan.html", COMPLETE_PLAN);
  const { exitCode, stdout } = go(dir);
  assert.equal(exitCode, 0);
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "plan-v1.html"]);
  assert.equal(readFileSync(join(dir, ".harness/add-search/history/plan-v1.html"), "utf8"), COMPLETE_PLAN);
  assert.match(stdout, /plan-v1\.html/);
  rmSync(dir, { recursive: true, force: true });
});

test("an unchanged artifact is not archived twice", () => {
  const dir = sandbox();
  writeArtifact(dir, "add-search", "plan.html", COMPLETE_PLAN);
  go(dir);
  const { stdout } = go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "plan-v1.html"]);
  assert.equal(stdout, "");
  rmSync(dir, { recursive: true, force: true });
});

test("a changed artifact lands as the next version", () => {
  const dir = sandbox();
  writeArtifact(dir, "add-search", "plan.html", COMPLETE_PLAN);
  go(dir);
  writeArtifact(dir, "add-search", "plan.html", COMPLETE_PLAN + "<!-- round 2 -->");
  go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "plan-v1.html", "plan-v2.html"]);
  const index = readFileSync(join(dir, ".harness/add-search/history/index.md"), "utf8");
  assert.match(index, /plan-v1\.html/);
  assert.match(index, /plan-v2\.html/);
  rmSync(dir, { recursive: true, force: true });
});

test("a half-built plan does not consume a version number", () => {
  const dir = sandbox();
  writeArtifact(dir, "add-search", "plan.html", BUILDING_PLAN);
  go(dir);
  writeArtifact(dir, "add-search", "plan.html", COMPLETE_PLAN);
  go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "plan-v1.html"]);
  rmSync(dir, { recursive: true, force: true });
});

test("review.md is archived once it has content", () => {
  const dir = sandbox();
  writeArtifact(dir, "add-search", "review/review.md", "");
  go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), []);
  writeArtifact(dir, "add-search", "review/review.md", "# Review\n\nAPPROVE\n");
  go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "review-v1.md"]);
  rmSync(dir, { recursive: true, force: true });
});

test("an unfilled proof-report template is not archived", () => {
  const dir = sandbox();
  writeArtifact(dir, "add-search", "verification/proof-report.html", UNFILLED_PROOF);
  go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), []);
  writeArtifact(dir, "add-search", "verification/proof-report.html", FILLED_PROOF);
  go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "proof-report-v1.html"]);
  rmSync(dir, { recursive: true, force: true });
});

test("each spec directory versions independently", () => {
  const dir = sandbox();
  writeArtifact(dir, "add-search", "plan.html", COMPLETE_PLAN);
  writeArtifact(dir, "fix-auth", "plan.html", COMPLETE_PLAN + "<!-- other -->");
  go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "plan-v1.html"]);
  assert.deepEqual(historyOf(dir, "fix-auth"), ["index.md", "plan-v1.html"]);
  rmSync(dir, { recursive: true, force: true });
});

test("non-spec directories under .harness are ignored", () => {
  const dir = sandbox();
  mkdirSync(join(dir, ".harness/knowledge/lessons"), { recursive: true });
  writeFileSync(join(dir, ".harness/knowledge/lessons/a.md"), "note");
  const { exitCode, stdout } = go(dir);
  assert.equal(exitCode, 0);
  assert.equal(stdout, "");
  rmSync(dir, { recursive: true, force: true });
});

test("an unreadable spec directory never fails the turn", () => {
  const dir = sandbox();
  writeFileSync(join(dir, ".harness"), "not a directory");
  const { exitCode } = go(dir);
  assert.equal(exitCode, 0);
  rmSync(dir, { recursive: true, force: true });
});
