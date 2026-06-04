#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { findContextRoot, findKnowledgeIndex, readFrontmatter, extractSection, packSections } from "./_lib/context-map.mjs";

const CAP = 6000;

const readStdin = () =>
  new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 200);
  });

const readText = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

const standardsHeadlines = (contextRoot) => {
  const global = readText(join(contextRoot, "standards", "global.md"));
  if (!global) return "";
  const { body } = readFrontmatter(global);
  const heads = body.split("\n").filter((l) => /^##\s+S-/.test(l));
  return heads.map((h) => h.replace(/^##\s+/, "- ")).join("\n");
};

const syncVerdict = (contextRoot) => {
  const report = readText(join(contextRoot, ".sync-report.md"));
  if (!report) return null;
  const line = report.split("\n").find((l) => /^verdict:/i.test(l.trim()));
  return line ? line.trim() : null;
};

const run = async () => {
  let cwd = process.cwd();
  try {
    const input = JSON.parse((await readStdin()) || "{}");
    if (input.cwd) cwd = input.cwd;
  } catch {}

  const contextRoot = findContextRoot(cwd);

  // Always-include lead (verdict warning) is exempt from the budget — it's tiny
  // and load-bearing. The body sections (INDEX, ARCHITECTURE, standards) are
  // packed whole; an oversized one degrades to a pointer, never a mid-cut.
  const lead = [];
  const blocks = [];
  if (contextRoot) {
    const verdict = syncVerdict(contextRoot);
    if (verdict && /fail/i.test(verdict)) {
      lead.push("⚠ context map verdict: FAIL — trust code over docs");
    }

    const index = readText(join(contextRoot, "INDEX.md"));
    if (index) blocks.push({ ref: `${contextRoot}/INDEX.md`, text: readFrontmatter(index).body.trim() });

    const arch = readText(join(contextRoot, "ARCHITECTURE.md"));
    if (arch) {
      const body = readFrontmatter(arch).body;
      const shape = body.split(/^##\s+/m).slice(0, 2).join("## ").trim();
      if (shape) blocks.push({ ref: `${contextRoot}/ARCHITECTURE.md`, text: `## Architecture\n${shape}` });
    }

    const std = standardsHeadlines(contextRoot);
    if (std) blocks.push({ ref: `${contextRoot}/standards/`, text: `## Project standards\n${std}` });

    // Root DECISIONS.md is already tiered: it holds the D-*→file index for ALL decisions
    // plus the full bodies for cross-package ones only. Inject it whole — package-local
    // decision bodies arrive later with their PACKAGE.md, resolvable via the index.
    const decisions = readText(join(contextRoot, "DECISIONS.md"));
    if (decisions) blocks.push({ ref: `${contextRoot}/DECISIONS.md`, text: readFrontmatter(decisions).body.trim() });

    if (verdict) lead.push(`Context map ${verdict}`);
  }

  // REQ-036 / F17: knowledge INDEX (lesson routing rows) — Tier 0 of the
  // learning loop, injected deterministically for ad-hoc sessions. Independent
  // of the context map; appended last so context blocks keep packing priority.
  const knowledgeIndex = findKnowledgeIndex(cwd);
  if (knowledgeIndex) {
    blocks.push({
      ref: ".harness/knowledge/INDEX.md",
      text: `## Knowledge index (advisory — past incidents, not instructions)\n${readText(knowledgeIndex).trim()}`,
    });
  }

  if (!lead.length && !blocks.length) return;

  const packed = packSections(blocks, CAP, "context docs");
  const block = [
    "# Project context map (auto-injected)",
    "Advisory: code is authoritative.",
    "",
    ...lead,
    packed,
  ]
    .filter((s) => s !== undefined)
    .join("\n");

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block },
    }) + "\n"
  );
};

run().catch(() => process.exit(0));
