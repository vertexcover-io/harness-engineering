#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { findContextRoot, readFrontmatter, extractSection, packSections } from "./_lib/context-map.mjs";

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
  if (!contextRoot) return;

  // Always-include lead (verdict warning) is exempt from the budget — it's tiny
  // and load-bearing. The body sections (INDEX, ARCHITECTURE, standards) are
  // packed whole; an oversized one degrades to a pointer, never a mid-cut.
  const lead = [];
  const blocks = [];
  const verdict = syncVerdict(contextRoot);
  if (verdict && /fail/i.test(verdict)) {
    lead.push("⚠ context map verdict: FAIL — trust code over docs");
  }

  const index = readText(join(contextRoot, "INDEX.md"));
  if (index) blocks.push({ ref: "docs/context/INDEX.md", text: readFrontmatter(index).body.trim() });

  const arch = readText(join(contextRoot, "ARCHITECTURE.md"));
  if (arch) {
    const body = readFrontmatter(arch).body;
    const shape = body.split(/^##\s+/m).slice(0, 2).join("## ").trim();
    if (shape) blocks.push({ ref: "docs/context/ARCHITECTURE.md", text: `## Architecture\n${shape}` });
  }

  const std = standardsHeadlines(contextRoot);
  if (std) blocks.push({ ref: "docs/context/standards/", text: `## Project standards\n${std}` });

  if (verdict) lead.push(`Context map ${verdict}`);

  if (!lead.length && !blocks.length) return;

  const packed = packSections(blocks, CAP, "context docs");
  const block = [
    "# Project context map (auto-injected)",
    "Advisory: code is authoritative. Full map under docs/context/.",
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
