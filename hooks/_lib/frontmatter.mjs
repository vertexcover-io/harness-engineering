// Standalone YAML-like frontmatter parser — no dependencies.
// Extracted from context-map.mjs to serve knowledge.mjs and other
// consumers that need frontmatter parsing without the context-map stack.

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
