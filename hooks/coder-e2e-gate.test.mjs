// Test harness for coder-e2e-gate.mjs.
// Each test sets up an isolated tmp git repo with a fake worktree and breadcrumb,
// runs the hook in a child process, and asserts on exit code and stdout token.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "coder-e2e-gate.mjs");

const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
};

const makeSandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "coder-e2e-gate-"));
  sh("git", ["init", "-q"], dir);
  sh("git", ["config", "user.email", "t@t"], dir);
  sh("git", ["config", "user.name", "t"], dir);
  sh("git", ["commit", "--allow-empty", "-q", "-m", "initial"], dir);
  return dir;
};

const writeBreadcrumb = (dir, spec, phase, sha) => {
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(
    join(dir, ".harness", "current-phase"),
    `SPEC_NAME=${spec}\nPHASE_N=${phase}\nSTART_SHA=${sha}\n`,
  );
};

const writeClaims = (dir, spec, phase, body) => {
  mkdirSync(join(dir, ".harness", spec), { recursive: true });
  writeFileSync(join(dir, ".harness", spec, `phase-${phase}-claims.json`), body);
};

const runHook = (cwd) => {
  const r = spawnSync(process.execPath, [HOOK], { cwd, encoding: "utf8" });
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
};

const headSha = (dir) => sh("git", ["rev-parse", "HEAD"], dir).trim();

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

const expect = (out, code, expectedCode, expectedToken) => {
  assert.equal(code, expectedCode, `expected exit ${expectedCode}, got ${code}. out:\n${out}`);
  if (expectedToken) {
    assert.ok(out.includes(expectedToken), `expected token "${expectedToken}" in output:\n${out}`);
  }
};

test("no breadcrumb is no-op", () => {
  const dir = makeSandbox();
  try {
    const { code, out } = runHook(dir);
    expect(out, code, 0, "");
  } finally { cleanup(dir); }
});

test("missing claims file blocks", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    const { code, out } = runHook(dir);
    expect(out, code, 2, "MISSING_PHASE_CLAIMS");
  } finally { cleanup(dir); }
});

test("unparseable claims blocks", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    writeClaims(dir, "myspec", 1, "this is not json");
    const { code, out } = runHook(dir);
    expect(out, code, 2, "PHASE_CLAIMS_UNPARSEABLE");
  } finally { cleanup(dir); }
});

test("not_applicable=true skips gate", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    writeClaims(dir, "myspec", 1, '{"not_applicable": true}');
    const { code, out } = runHook(dir);
    expect(out, code, 0, "not_applicable");
  } finally { cleanup(dir); }
});

test("missing report_path blocks", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    writeClaims(dir, "myspec", 1, '{"executed":1,"passed":1,"failed":0,"claims":[]}');
    const { code, out } = runHook(dir);
    expect(out, code, 2, "MISSING_E2E_REPORT_PATH");
  } finally { cleanup(dir); }
});

test("missing report file blocks", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    writeClaims(
      dir, "myspec", 1,
      '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/missing.json"},"claims":[]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 2, "MISSING_E2E_REPORT");
  } finally { cleanup(dir); }
});

test("zero executed blocks", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    mkdirSync(join(dir, ".harness", "myspec"), { recursive: true });
    writeFileSync(join(dir, ".harness", "myspec", "run.json"), '{"executed":0,"passed":0,"failed":0}');
    writeClaims(
      dir, "myspec", 1,
      '{"executed":0,"passed":0,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 2, "E2E_NOT_EXECUTED");
  } finally { cleanup(dir); }
});

test("failures block", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    mkdirSync(join(dir, ".harness", "myspec"), { recursive: true });
    writeFileSync(join(dir, ".harness", "myspec", "run.json"), '{"executed":3,"passed":2,"failed":1}');
    writeClaims(
      dir, "myspec", 1,
      '{"executed":3,"passed":2,"failed":1,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 2, "E2E_FAILED");
  } finally { cleanup(dir); }
});

test("tampered counts block", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    mkdirSync(join(dir, ".harness", "myspec"), { recursive: true });
    writeFileSync(join(dir, ".harness", "myspec", "run.json"), '{"executed":2,"passed":2,"failed":0}');
    writeClaims(
      dir, "myspec", 1,
      '{"executed":99,"passed":99,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 2, "E2E_COUNTS_TAMPERED");
  } finally { cleanup(dir); }
});

test("passing with no code touched", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    mkdirSync(join(dir, ".harness", "myspec"), { recursive: true });
    writeFileSync(join(dir, ".harness", "myspec", "run.json"), '{"executed":1,"passed":1,"failed":0}');
    writeClaims(
      dir, "myspec", 1,
      '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"api","surface":"/api","behavior":"x","proven_by":"x.spec.ts::y"}]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 0, "e2e gate OK");
  } finally { cleanup(dir); }
});

test("uncovered code file blocks", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "widget.ts"), "export const foo = 1");
    sh("git", ["add", "-A"], dir);
    sh("git", ["commit", "-q", "-m", "add widget"], dir);
    mkdirSync(join(dir, ".harness", "myspec"), { recursive: true });
    writeFileSync(join(dir, ".harness", "myspec", "run.json"), '{"executed":1,"passed":1,"failed":0}');
    writeClaims(
      dir, "myspec", 1,
      '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"api","surface":"/api","behavior":"other","proven_by":"unrelated.spec.ts::x"}]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 2, "UNCOVERED_FILES");
  } finally { cleanup(dir); }
});

test("covered code file passes", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "widget.ts"), "export const widget = 1");
    sh("git", ["add", "-A"], dir);
    sh("git", ["commit", "-q", "-m", "add widget"], dir);
    mkdirSync(join(dir, ".harness", "myspec"), { recursive: true });
    writeFileSync(join(dir, ".harness", "myspec", "run.json"), '{"executed":1,"passed":1,"failed":0}');
    writeClaims(
      dir, "myspec", 1,
      '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"ui","surface":"/x","behavior":"widget works","proven_by":"widget.spec.ts::renders"}]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 0, "e2e gate OK");
  } finally { cleanup(dir); }
});

test("config file ignored", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    writeFileSync(join(dir, "settings.json"), '{"a":1}');
    sh("git", ["add", "-A"], dir);
    sh("git", ["commit", "-q", "-m", "edit config"], dir);
    mkdirSync(join(dir, ".harness", "myspec"), { recursive: true });
    writeFileSync(join(dir, ".harness", "myspec", "run.json"), '{"executed":1,"passed":1,"failed":0}');
    writeClaims(
      dir, "myspec", 1,
      '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"api","surface":"/x","behavior":"x","proven_by":"x.spec.ts::y"}]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 0, "e2e gate OK");
  } finally { cleanup(dir); }
});

test("test-only file ignored", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "widget.spec.ts"), "test");
    sh("git", ["add", "-A"], dir);
    sh("git", ["commit", "-q", "-m", "add only test"], dir);
    mkdirSync(join(dir, ".harness", "myspec"), { recursive: true });
    writeFileSync(join(dir, ".harness", "myspec", "run.json"), '{"executed":1,"passed":1,"failed":0}');
    writeClaims(
      dir, "myspec", 1,
      '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"api","surface":"/x","behavior":"x","proven_by":"unrelated.spec.ts::y"}]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 0, "e2e gate OK");
  } finally { cleanup(dir); }
});

test("vitest runner shape parsed", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    mkdirSync(join(dir, ".harness", "myspec"), { recursive: true });
    writeFileSync(
      join(dir, ".harness", "myspec", "run.json"),
      '{"numTotalTests":5,"numPassedTests":5,"numFailedTests":0}',
    );
    writeClaims(
      dir, "myspec", 1,
      '{"executed":5,"passed":5,"failed":0,"e2e_run":{"runner":"vitest","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"api","surface":"/x","behavior":"x","proven_by":"x.spec.ts::y"}]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 0, "e2e gate OK");
  } finally { cleanup(dir); }
});

test("playwright runner shape parsed", () => {
  const dir = makeSandbox();
  try {
    writeBreadcrumb(dir, "myspec", 1, headSha(dir));
    mkdirSync(join(dir, ".harness", "myspec"), { recursive: true });
    writeFileSync(
      join(dir, ".harness", "myspec", "run.json"),
      JSON.stringify({
        suites: [{
          specs: [{
            tests: [
              { results: [{ status: "passed" }] },
              { results: [{ status: "passed" }] },
            ],
          }],
        }],
      }),
    );
    writeClaims(
      dir, "myspec", 1,
      '{"executed":2,"passed":2,"failed":0,"e2e_run":{"runner":"playwright","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"ui","surface":"/x","behavior":"x","proven_by":"x.spec.ts::y"}]}',
    );
    const { code, out } = runHook(dir);
    expect(out, code, 0, "e2e gate OK");
  } finally { cleanup(dir); }
});
