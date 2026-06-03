#!/usr/bin/env node
// SubagentStop hook. Port of coder-e2e-gate.sh.
// Activation: no-ops unless .harness/current-phase exists.
// Exit 0 = OK, exit 2 = block (with CODER_E2E_GATE:BLOCK token on stdout).

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { diffNamesSince, gitAvailable } from "./_lib/git.mjs";

// Set HARNESS_CURRENT_PHASE_FILE to an absolute path to make the gate cwd-independent.
// Default is cwd-relative, which is correct when the hook runs in the worktree.
const BREADCRUMB = process.env.HARNESS_CURRENT_PHASE_FILE || ".harness/current-phase";

const emitBlock = (msg) => {
  process.stdout.write(`CODER_E2E_GATE:BLOCK ${msg}\n`);
  process.exit(2);
};
const emitInfo = (msg) => process.stdout.write(`CODER_E2E_GATE:INFO ${msg}\n`);

if (!existsSync(BREADCRUMB)) process.exit(0);

// Parse breadcrumb (shell-sourceable KEY=VALUE lines)
const breadcrumb = Object.fromEntries(
  readFileSync(BREADCRUMB, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return i < 0 ? null : [l.slice(0, i), l.slice(i + 1)];
    })
    .filter(Boolean),
);

const SPEC_NAME = breadcrumb.SPEC_NAME;
const PHASE_N = breadcrumb.PHASE_N;
const START_SHA = breadcrumb.START_SHA;
if (!SPEC_NAME) emitBlock("breadcrumb missing SPEC_NAME");
if (!PHASE_N) emitBlock("breadcrumb missing PHASE_N");
if (!START_SHA) emitBlock("breadcrumb missing START_SHA");

// Co-locate claims with the active-phase breadcrumb so they resolve from the same
// .harness tree regardless of cwd; honor an explicit HARNESS_DIR override if set.
const HARNESS_DIR = process.env.HARNESS_DIR || join(dirname(BREADCRUMB), SPEC_NAME);
const CLAIMS_FILE = join(HARNESS_DIR, `phase-${PHASE_N}-claims.json`);

if (!existsSync(CLAIMS_FILE)) emitBlock(`MISSING_PHASE_CLAIMS expected ${CLAIMS_FILE}`);

let claims;
try {
  claims = JSON.parse(readFileSync(CLAIMS_FILE, "utf8"));
} catch {
  emitBlock(`PHASE_CLAIMS_UNPARSEABLE ${CLAIMS_FILE} is not valid JSON`);
}

if (claims.not_applicable === true) {
  emitInfo(`phase ${PHASE_N} flagged not_applicable — skipping e2e gate`);
  process.exit(0);
}

const reportPath = claims.e2e_run?.report_path;
if (!reportPath) emitBlock(`MISSING_E2E_REPORT_PATH .e2e_run.report_path missing in ${CLAIMS_FILE}`);
if (!existsSync(reportPath)) emitBlock(`MISSING_E2E_REPORT file ${reportPath} does not exist on disk`);

const runner = claims.e2e_run?.runner;
if (!runner) emitBlock(`MISSING_E2E_RUNNER .e2e_run.runner missing in ${CLAIMS_FILE}`);

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch {
  emitBlock(`E2E_REPORT_UNPARSEABLE ${reportPath} is not valid JSON`);
}

const countPlaywright = (r) => {
  const results = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.tests)) {
      for (const t of node.tests) {
        if (Array.isArray(t.results)) results.push(...t.results);
      }
    }
    if (Array.isArray(node.suites)) node.suites.forEach(walk);
    if (Array.isArray(node.specs)) node.specs.forEach(walk);
  };
  walk(r);
  const executed = results.filter((x) => x.status !== "skipped").length;
  const failed = results.filter(
    (x) => x.status === "failed" || x.status === "timedOut" || x.status === "interrupted",
  ).length;
  return { executed, failed, passed: executed - failed };
};

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

let reExecuted, rePassed, reFailed;
if (runner === "playwright") {
  ({ executed: reExecuted, passed: rePassed, failed: reFailed } = countPlaywright(report));
} else if (runner === "vitest" || runner === "jest") {
  reExecuted = toInt(report.numTotalTests);
  rePassed = toInt(report.numPassedTests);
  reFailed = toInt(report.numFailedTests);
} else {
  reExecuted = toInt(report.executed);
  rePassed = toInt(report.passed);
  reFailed = toInt(report.failed);
}

if (reExecuted === 0) emitBlock(`E2E_NOT_EXECUTED report ${reportPath} shows 0 executed tests`);
if (reFailed > 0) emitBlock(`E2E_FAILED report ${reportPath} shows ${reFailed} failed test(s)`);

const claimedExecuted = toInt(claims.executed);
const claimedFailed = toInt(claims.failed);
if (claimedExecuted !== reExecuted || claimedFailed !== reFailed) {
  emitBlock(
    `E2E_COUNTS_TAMPERED claims.json says executed=${claimedExecuted} failed=${claimedFailed} but ${reportPath} says executed=${reExecuted} failed=${reFailed}`,
  );
}

// ── Coverage: every touched code file must appear in some proven_by ─────────
if (!gitAvailable()) emitBlock("git not available — cannot determine touched files");

const touched = diffNamesSince(START_SHA, process.cwd());

const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs",
  ".java", ".kt", ".scala",
  ".swift", ".m", ".mm",
  ".rb",
  ".c", ".cc", ".cpp", ".h", ".hpp",
  ".vue", ".svelte",
]);

const isCodeFile = (f) => {
  const dot = f.lastIndexOf(".");
  return dot >= 0 && CODE_EXTS.has(f.slice(dot));
};

const isTestFile = (f) => {
  if (/\.(spec|test)\./.test(f)) return true;
  if (/_test\.(go|py)$/.test(f)) return true;
  if (/(^|\/)(tests?|e2e)\//.test(f)) return true;
  return false;
};

const fileStillExists = (f) => {
  try { statSync(f); return true; } catch { return false; }
};

const codeTouched = touched.filter(
  (f) => fileStillExists(f) && isCodeFile(f) && !isTestFile(f),
);

if (codeTouched.length === 0) {
  emitInfo(`no production code files touched since ${START_SHA} — coverage check skipped`);
  emitInfo(`phase ${PHASE_N} e2e gate OK (executed=${reExecuted} passed=${rePassed} failed=${reFailed})`);
  process.exit(0);
}

const provenList = (claims.claims || [])
  .map((c) => c?.proven_by)
  .filter((s) => typeof s === "string" && s.length > 0);

if (provenList.length === 0) {
  emitBlock(
    `NO_PROVEN_BY claims.json has no proven_by references but ${codeTouched.length} code file(s) were touched`,
  );
}

const provenBlob = provenList.join("\n");
const uncovered = codeTouched.filter((f) => {
  const base = basename(f);
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  return !provenBlob.includes(base) && !provenBlob.includes(stem);
});

if (uncovered.length > 0) {
  emitBlock(`UNCOVERED_FILES no e2e proven_by reference found for: ${uncovered.join(" ")}`);
}

emitInfo(
  `phase ${PHASE_N} e2e gate OK (executed=${reExecuted} passed=${rePassed} failed=${reFailed}, code files covered: ${codeTouched.length})`,
);
process.exit(0);
