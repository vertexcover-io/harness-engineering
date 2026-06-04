import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";
import { repoRoot, diffNamesSince } from "./git.mjs";

const toPosix = (p) => p.split(sep).join("/");

// Unified layout first; docs/context is the pre-migration fallback.
const CONTEXT_ROOTS = [
  [".harness", "knowledge", "context"],
  ["docs", "context"],
];

export const findContextRoot = (cwd) => {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    for (const parts of CONTEXT_ROOTS) {
      const candidate = join(dir, ...parts);
      if (existsSync(candidate) && safeIsDir(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
};

const safeIsDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const readText = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

export const readFrontmatter = (mdText) => {
  if (!mdText || !mdText.startsWith("---")) return { frontmatter: {}, body: mdText ?? "" };
  const end = mdText.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: mdText };
  const block = mdText.slice(3, end).trim();
  const body = mdText.slice(end + 4).replace(/^\n/, "");
  const frontmatter = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();
    frontmatter[key] = parseScalarOrList(raw);
  }
  return { frontmatter, body };
};

const parseScalarOrList = (raw) => {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return raw.replace(/^["']|["']$/g, "");
};

export const extractSection = (mdBody, heading) => {
  if (!mdBody) return "";
  const lines = mdBody.split("\n");
  const want = heading.trim().toLowerCase();
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.*)$/);
    if (m && m[1].trim().toLowerCase().replace(/\s+/g, " ").startsWith(want)) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
};

const listPackageDocs = (contextRoot) => {
  const root = join(contextRoot, "packages");
  if (!safeIsDir(root)) return [];
  const docs = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "PACKAGE.md") docs.push(full);
    }
  };
  walk(root);
  return docs;
};

export const resolveOwningDoc = (filePath, contextRoot, repoRoot) => {
  const rel = toPosix(repoRoot ? relative(repoRoot, filePath) : filePath);
  const fileDir = toPosix(dirname(rel));
  let best = null;
  let bestLen = -1;
  for (const docPath of listPackageDocs(contextRoot)) {
    const text = readText(docPath);
    const { frontmatter, body } = readFrontmatter(text);
    const governs = typeof frontmatter.governs === "string" ? frontmatter.governs.replace(/\/$/, "") : null;
    if (!governs) continue;
    if (fileDir === governs || fileDir.startsWith(governs + "/")) {
      if (governs.length > bestLen) {
        bestLen = governs.length;
        best = { docPath, frontmatter, body };
      }
    }
  }
  return best;
};

const globToRegExp = (glob) => {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
};

const matchGlob = (relPath, glob) => globToRegExp(glob).test(relPath);

export const matchStandards = (filePath, contextRoot, repoRoot) => {
  const dir = join(contextRoot, "standards");
  if (!safeIsDir(dir)) return [];
  const rel = toPosix(repoRoot ? relative(repoRoot, filePath) : filePath);
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const docPath = join(dir, name);
    const { frontmatter, body } = readFrontmatter(readText(docPath));
    const globs = Array.isArray(frontmatter.applies_to) ? frontmatter.applies_to : [];
    if (globs.some((g) => matchGlob(rel, g))) out.push({ docPath, frontmatter, body });
  }
  return out;
};

export const extractFlowTrace = (mdBody, fnName) => {
  const flows = extractSection(mdBody, "Data flows");
  if (!flows || !fnName) return flows;
  const lines = flows.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp("^\\s*" + escapeRe(fnName) + "\\s*\\(").test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return flows;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && /\(/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const cap = (text, maxChars) =>
  text.length <= maxChars ? text : text.slice(0, maxChars) + "\n…[truncated]";

// Pack whole blocks under a budget. Include each block until the next would
// overflow; never cut inside a block. For anything dropped, append an explicit
// pointer to its source path so the reader can open it — degrade to a link,
// never to a silent truncation. `ref` is the doc path shown in the pointer.
// maxChars <= 0 disables the budget (include everything).
export const packSections = (blocks, maxChars, pointerLabel) => {
  if (!blocks.length) return "";
  if (!(maxChars > 0)) return blocks.map((b) => b.text).join("\n\n");
  const kept = [];
  const dropped = [];
  let used = 0;
  for (const b of blocks) {
    const cost = b.text.length + (kept.length ? 2 : 0);
    if (kept.length && used + cost > maxChars) dropped.push(b);
    else {
      kept.push(b.text);
      used += cost;
    }
  }
  let out = kept.join("\n\n");
  if (dropped.length) {
    const refs = dropped.map((b) => b.ref).filter(Boolean);
    out += `\n\n…${dropped.length} more ${pointerLabel} apply — read in full: ${refs.join(", ")}`;
  }
  return out;
};

export const buildPhaseContext = (filePaths, contextRoot, repoRoot, opts = {}) => {
  const capChars = opts.capChars ?? 5000;
  const seenDocs = new Set();
  const seenStandards = new Set();
  const docBlocks = [];
  const stdBlocks = [];

  for (const filePath of filePaths) {
    const doc = resolveOwningDoc(filePath, contextRoot, repoRoot);
    if (doc && !seenDocs.has(doc.docPath)) {
      seenDocs.add(doc.docPath);
      const ref = toPosix(relative(contextRoot, doc.docPath));
      const purpose = extractSection(doc.body, "Purpose");
      const flows = extractSection(doc.body, "Data flows");
      const gotchas = extractSection(doc.body, "Gotchas");
      const parts = [`### ${ref}`];
      if (purpose) parts.push(`**Purpose:** ${purpose}`);
      if (flows) parts.push(`**Data flows:**\n${flows}`);
      if (gotchas) parts.push(`**Gotchas:**\n${gotchas}`);
      docBlocks.push({ ref, text: parts.join("\n") });
    }
    for (const std of matchStandards(filePath, contextRoot, repoRoot)) {
      if (seenStandards.has(std.docPath)) continue;
      seenStandards.add(std.docPath);
      const ref = toPosix(relative(contextRoot, std.docPath));
      const enforced = std.frontmatter.enforced_by ? ` (enforced_by: ${std.frontmatter.enforced_by})` : "";
      stdBlocks.push({ ref, text: `### ${ref}${enforced}\n${std.body.trim()}` });
    }
  }

  if (!docBlocks.length && !stdBlocks.length) return "";
  // Budget split: standards are smaller + higher-priority (CI-backed rules), so
  // give them a guaranteed slice and let package context take the remainder.
  const stdBudget = capChars > 0 ? Math.round(capChars * 0.4) : 0;
  const sections = [];
  if (stdBlocks.length) {
    const packed = packSections(stdBlocks, stdBudget, "standards shards");
    sections.push(`## Standards that apply\n${packed}`);
  }
  if (docBlocks.length) {
    const docBudget = capChars > 0 ? Math.max(0, capChars - (sections[0]?.length ?? 0)) : 0;
    const packed = packSections(docBlocks, docBudget, "package docs");
    sections.push(`## Package context\n${packed}`);
  }
  const block = sections.join("\n\n");
  return opts.withStats ? { block, docs: docBlocks.length, standards: stdBlocks.length } : block;
};

// Pointer mode: resolve the files to the context-doc PATHS the agent should read
// itself (owning PACKAGE.md per file + matching standards shards), repo-relative,
// deduped. No body extraction, no packing — the agent Reads these on demand. This
// keeps the dispatch preamble tiny and lets the agent pull only what it opens.
export const resolvePhasePaths = (filePaths, contextRoot, repoRoot) => {
  const docs = new Set();
  const standards = new Set();
  for (const filePath of filePaths) {
    const doc = resolveOwningDoc(filePath, contextRoot, repoRoot);
    if (doc) docs.add(toPosix(relative(repoRoot, doc.docPath)));
    for (const std of matchStandards(filePath, contextRoot, repoRoot)) {
      standards.add(toPosix(relative(repoRoot, std.docPath)));
    }
  }
  return { docs: [...docs], standards: [...standards] };
};

// Stderr markers let the caller (and the transcript) tell apart three states that
// otherwise all look like "no output": map absent, map present but nothing matched,
// and a real injection. Stdout carries ONLY the block (safe to paste into a prompt).
// Commands:
//   phase-paths <files...>     → list the doc PATHS the agent must read (pointer mode, default)
//   phase-context <files...>   → emit the assembled content block (push mode, e.g. SessionStart)
//   diff <sha> [--paths]       → same, but resolve files from the working-tree diff since <sha>
// Stderr markers (NONE | EMPTY | INJECTED) tell the three states apart in every mode.
const main = (argv) => {
  let [cmd, ...rest] = argv;
  const cwd = process.cwd();
  const pathsMode = cmd === "phase-paths" || rest.includes("--paths");
  rest = rest.filter((a) => a !== "--paths");

  let files = rest;
  if (cmd === "diff") {
    // Files the coder discovered that the planner's **Files:** list never named.
    const root = repoRoot(cwd) ?? cwd;
    files = diffNamesSince(rest[0] ?? "HEAD", cwd).map((f) => join(root, f));
  } else if (cmd !== "phase-context" && cmd !== "phase-paths") {
    return;
  }

  const contextRoot = findContextRoot(cwd);
  if (!contextRoot) {
    process.stderr.write("CONTEXT_MAP:NONE (no docs/context found)\n");
    return;
  }

  if (pathsMode) {
    const { docs, standards } = resolvePhasePaths(files, contextRoot, repoRoot(cwd) ?? cwd);
    if (!docs.length && !standards.length) {
      process.stderr.write("CONTEXT_MAP:EMPTY (map present, nothing matched these files)\n");
      return;
    }
    const lines = [];
    if (docs.length) lines.push("Package docs:", ...docs.map((d) => `  - ${d}`));
    if (standards.length) lines.push("Standards:", ...standards.map((s) => `  - ${s}`));
    process.stdout.write(lines.join("\n") + "\n");
    process.stderr.write(`CONTEXT_MAP:INJECTED docs=${docs.length} standards=${standards.length}\n`);
    return;
  }

  const { block, docs, standards } = buildPhaseContext(files, contextRoot, cwd, {
    capChars: 5000,
    withStats: true,
  });
  if (block) {
    process.stdout.write(block + "\n");
    process.stderr.write(`CONTEXT_MAP:INJECTED docs=${docs} standards=${standards}\n`);
  } else {
    process.stderr.write("CONTEXT_MAP:EMPTY (map present, nothing matched these files)\n");
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
