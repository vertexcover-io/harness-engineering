#!/usr/bin/env node
// Stop / SubagentStop hook: block if an active feature under .harness/ has no
// verification/proof-report.html.
// Bypass: HARNESS_SKIP_VERIFY_GATE=1.

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot, gitAvailable } from "../../hooks/_lib/git.mjs";

if (process.env.HARNESS_SKIP_VERIFY_GATE === "1") process.exit(0);

const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const root = (gitAvailable() && repoRoot(cwd)) || cwd;
// Flat layout, with the pre-migration roots as fallbacks.
const specRoots = [
  join(root, ".harness"),
  join(root, ".harness", "features"),
  join(root, "docs", "spec"),
].filter(existsSync);

if (specRoots.length === 0) process.exit(0);

const ACTIVE_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const missing = [];

// Not feature directories: the shared lesson store, pipeline scratch, and the
// pre-migration root now enumerated as a sibling.
const RESERVED = new Set(["knowledge", "runtime", "features"]);

const specDirs = specRoots.flatMap((specRoot) => {
  try {
    return readdirSync(specRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !RESERVED.has(d.name))
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

// A feature directory is one planning or brainstorm actually wrote into. There is
// no spec.md stage any more — plan.md is the artifact every run produces.
const isFeatureDir = (dir) =>
  existsSync(join(dir, "plan.md")) || existsSync(join(dir, "design.md"));

for (const { name, dir } of specDirs) {
  if (!isFeatureDir(dir)) continue;
  if (!isRecent(dir)) continue;
  if (!hasImplementationEvidence(name)) continue;
  if (!existsSync(join(dir, "verification", "proof-report.html"))) {
    missing.push(name);
  }
}

if (missing.length === 0) process.exit(0);

const list = missing.map((n) => `  - ${n}`).join("\n");
process.stderr.write(
  `Verification gate: the following active feature(s) have no proof-report.html:\n\n${list}\n\n` +
    `Passing unit/e2e tests are NOT verification. Invoke the functional-verify skill\n` +
    `before ending this session — it must produce .harness/<name>/verification/proof-report.html\n` +
    `for each active feature. If verification genuinely does not apply to this session,\n` +
    `re-run with HARNESS_SKIP_VERIFY_GATE=1 in env (and say so in the PR).\n`,
);
process.exit(2);
