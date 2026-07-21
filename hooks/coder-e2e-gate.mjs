#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffNamesSince, gitAvailable } from "./_lib/git.mjs";

class GateExit {
  constructor(exitCode, stdout) {
    this.exitCode = exitCode;
    this.stdout = stdout;
  }
}

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

const runnerCounts = (runner, report) => {
  if (runner === "playwright") return countPlaywright(report);
  if (runner === "vitest" || runner === "jest") {
    return {
      executed: toInt(report.numTotalTests),
      passed: toInt(report.numPassedTests),
      failed: toInt(report.numFailedTests),
    };
  }
  return { executed: toInt(report.executed), passed: toInt(report.passed), failed: toInt(report.failed) };
};

const gate = (cwd, emit) => {
  const breadcrumbPath = process.env.HARNESS_CURRENT_PHASE_FILE || ".harness/runtime/current-phase";
  const block = (msg) => {
    throw new GateExit(2, `CODER_E2E_GATE:BLOCK ${msg}\n`);
  };
  const info = (msg) => emit(`CODER_E2E_GATE:INFO ${msg}\n`);
  const ok = () => {
    throw new GateExit(0, "");
  };

  if (!existsSync(breadcrumbPath)) return ok();

  const breadcrumb = Object.fromEntries(
    readFileSync(breadcrumbPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return i < 0 ? null : [l.slice(0, i), l.slice(i + 1)];
      })
      .filter(Boolean),
  );

  const { SPEC_NAME, PHASE_N, START_SHA } = breadcrumb;
  if (!SPEC_NAME) block("breadcrumb missing SPEC_NAME");
  if (!PHASE_N) block("breadcrumb missing PHASE_N");
  if (!START_SHA) block("breadcrumb missing START_SHA");

  const harnessDir = process.env.HARNESS_DIR || join(dirname(breadcrumbPath), SPEC_NAME);
  const claimsFile = join(harnessDir, `phase-${PHASE_N}-claims.json`);

  if (!existsSync(claimsFile)) block(`MISSING_PHASE_CLAIMS expected ${claimsFile}`);

  let claims;
  try {
    claims = JSON.parse(readFileSync(claimsFile, "utf8"));
  } catch {
    block(`PHASE_CLAIMS_UNPARSEABLE ${claimsFile} is not valid JSON`);
  }

  if (claims.not_applicable === true) {
    info(`phase ${PHASE_N} flagged not_applicable — skipping e2e gate`);
    return ok();
  }

  const reportPath = claims.e2e_run?.report_path;
  if (!reportPath) block(`MISSING_E2E_REPORT_PATH .e2e_run.report_path missing in ${claimsFile}`);
  if (!existsSync(reportPath)) block(`MISSING_E2E_REPORT file ${reportPath} does not exist on disk`);

  const runner = claims.e2e_run?.runner;
  if (!runner) block(`MISSING_E2E_RUNNER .e2e_run.runner missing in ${claimsFile}`);

  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    block(`E2E_REPORT_UNPARSEABLE ${reportPath} is not valid JSON`);
  }

  const { executed: reExecuted, passed: rePassed, failed: reFailed } = runnerCounts(runner, report);

  if (reExecuted === 0) block(`E2E_NOT_EXECUTED report ${reportPath} shows 0 executed tests`);
  if (reFailed > 0) block(`E2E_FAILED report ${reportPath} shows ${reFailed} failed test(s)`);

  const claimedExecuted = toInt(claims.executed);
  const claimedFailed = toInt(claims.failed);
  if (claimedExecuted !== reExecuted || claimedFailed !== reFailed) {
    block(
      `E2E_COUNTS_TAMPERED claims.json says executed=${claimedExecuted} failed=${claimedFailed} but ${reportPath} says executed=${reExecuted} failed=${reFailed}`,
    );
  }

  if (!gitAvailable()) block("git not available — cannot determine touched files");

  const touched = diffNamesSince(START_SHA, cwd);
  const codeTouched = touched.filter((f) => fileStillExists(f) && isCodeFile(f) && !isTestFile(f));

  if (codeTouched.length === 0) {
    info(`no production code files touched since ${START_SHA} — coverage check skipped`);
    info(`phase ${PHASE_N} e2e gate OK (executed=${reExecuted} passed=${rePassed} failed=${reFailed})`);
    return ok();
  }

  const provenList = (claims.claims || [])
    .map((c) => c?.proven_by)
    .filter((s) => typeof s === "string" && s.length > 0);

  if (provenList.length === 0) {
    block(
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
    block(`UNCOVERED_FILES no e2e proven_by reference found for: ${uncovered.join(" ")}`);
  }

  info(
    `phase ${PHASE_N} e2e gate OK (executed=${reExecuted} passed=${rePassed} failed=${reFailed}, code files covered: ${codeTouched.length})`,
  );
  return ok();
};

export const run = (argv = [], cwd = process.cwd()) => {
  let stdout = "";
  const emit = (s) => {
    stdout += s;
  };
  try {
    gate(cwd, emit);
    return { exitCode: 0, stdout };
  } catch (e) {
    if (e instanceof GateExit) return { exitCode: e.exitCode, stdout: stdout + e.stdout };
    throw e;
  }
};

const isMain = () => import.meta.url === `file://${process.argv[1]}`;

if (isMain()) {
  const { exitCode, stdout } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  process.exit(exitCode);
}
