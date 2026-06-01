import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative, sep } from "node:path";

const toPosix = (p) => p.split(sep).join("/");

export const findContextRoot = (cwd) => {
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    const candidate = join(dir, "docs", "context");
    if (existsSync(candidate) && safeIsDir(candidate)) return candidate;
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
      const purpose = extractSection(doc.body, "Purpose");
      const flows = extractSection(doc.body, "Data flows");
      const gotchas = extractSection(doc.body, "Gotchas");
      const parts = [`### ${toPosix(relative(contextRoot, doc.docPath))}`];
      if (purpose) parts.push(`**Purpose:** ${purpose}`);
      if (flows) parts.push(`**Data flows:**\n${flows}`);
      if (gotchas) parts.push(`**Gotchas:**\n${gotchas}`);
      docBlocks.push(parts.join("\n"));
    }
    for (const std of matchStandards(filePath, contextRoot, repoRoot)) {
      if (seenStandards.has(std.docPath)) continue;
      seenStandards.add(std.docPath);
      const enforced = std.frontmatter.enforced_by ? ` (enforced_by: ${std.frontmatter.enforced_by})` : "";
      stdBlocks.push(`### ${toPosix(relative(contextRoot, std.docPath))}${enforced}\n${std.body.trim()}`);
    }
  }

  if (!docBlocks.length && !stdBlocks.length) return "";
  const sections = [];
  if (stdBlocks.length) sections.push(`## Standards that apply\n${stdBlocks.join("\n\n")}`);
  if (docBlocks.length) sections.push(`## Package context\n${docBlocks.join("\n\n")}`);
  return cap(sections.join("\n\n"), capChars);
};

const main = (argv) => {
  const [cmd, ...rest] = argv;
  if (cmd !== "phase-context") return;
  const cwd = process.cwd();
  const contextRoot = findContextRoot(cwd);
  if (!contextRoot) return;
  const block = buildPhaseContext(rest, contextRoot, cwd, { capChars: 5000 });
  if (block) process.stdout.write(block + "\n");
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
