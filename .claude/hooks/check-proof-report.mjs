#!/usr/bin/env node
// Stop / SubagentStop hook: block if an active spec under docs/spec/ has no
// verification/proof-report.md. Port of check-proof-report.sh.
// Bypass: HARNESS_SKIP_VERIFY_GATE=1.

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, gitAvailable } from "../../hooks/_lib/git.mjs";

if (process.env.HARNESS_SKIP_VERIFY_GATE === "1") process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const root = (gitAvailable() && repoRoot(cwd)) || cwd;
// Unified layout, with the pre-migration root as fallback.
const specRoots = [join(root, ".harness", "features"), join(root, "docs", "spec")].filter(
  existsSync,
);

if (specRoots.length === 0) process.exit(0);

const ACTIVE_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const missing = [];

const specDirs = specRoots.flatMap((specRoot) => {
  try {
    return readdirSync(specRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, dir: join(specRoot, d.name) }));
  } catch {
    return [];
  }
});

const isRecent = (dir) => {
  try {
    for (const entry of readdirSync(dir)) {
      const s = statSync(join(dir, entry));
      if (now - s.mtimeMs < ACTIVE_MS) return true;
    }
    const s = statSync(dir);
    return now - s.mtimeMs < ACTIVE_MS;
  } catch {
    return false;
  }
};

// Design/planning-only specs (no coder stage ran) have nothing to verify yet.
// Implementation evidence = coder-produced claims files; planning's phase-N.md
// breakdowns are NOT evidence.
const hasImplementationEvidence = (name) => {
  // Unified layout, with the pre-migration location as fallback.
  const evidenceDirs = [join(root, ".harness", "runtime", name), join(root, ".harness", name)];
  for (const harnessDir of evidenceDirs) {
    if (!existsSync(harnessDir)) continue;
    try {
      const hit = readdirSync(harnessDir).some(
        (e) => e === "claims.json" || /^phase-.*-claims\.json$/.test(e),
      );
      if (hit) return true;
    } catch {}
  }
  return false;
};

for (const { name, dir } of specDirs) {
  const specMd = join(dir, "spec.md");
  if (!existsSync(specMd)) continue;
  if (!isRecent(dir)) continue;
  if (!hasImplementationEvidence(name)) continue;
  if (!existsSync(join(dir, "verification", "proof-report.md"))) {
    missing.push(name);
  }
}

if (missing.length === 0) process.exit(0);

const list = missing.map((n) => `  - ${n}`).join("\n");
process.stderr.write(
  `Verification gate: the following active spec(s) have no proof-report.md:\n\n${list}\n\n` +
    `Passing unit/e2e tests are NOT verification. Invoke the functional-verify skill\n` +
    `before ending this session — it must produce docs/spec/<name>/verification/proof-report.md\n` +
    `for each active spec. If verification genuinely does not apply to this session,\n` +
    `re-run with HARNESS_SKIP_VERIFY_GATE=1 in env (and say so in the PR).\n`,
);
process.exit(2);
