#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const NAME_PATTERN = /^[a-z0-9-]+$/;

const extractFrontmatterBlock = (mdText) => {
  if (!mdText.startsWith("---")) return null;
  const end = mdText.indexOf("\n---", 3);
  if (end === -1) return null;
  return mdText.slice(3, end).trim();
};

const parseFrontmatter = (block) => {
  const lines = block.split("\n");
  const entries = {};
  let currentKey = null;

  const isContinuation = (line) => currentKey !== null && /^\s+\S/.test(line);
  const keyMatch = (line) => line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);

  for (const line of lines) {
    if (isContinuation(line)) {
      entries[currentKey] = `${entries[currentKey]} ${line.trim()}`.trim();
      continue;
    }
    const m = keyMatch(line);
    if (!m) continue;
    const [, key, raw] = m;
    currentKey = key;
    entries[key] = raw.replace(/^[>|]\s*$/, "").replace(/^["']|["']$/g, "").trim();
  }
  return entries;
};

const violationsFor = (fm) => {
  const out = [];
  const name = fm.name ?? "";
  if (!name) out.push("missing name");
  else if (name.length > NAME_MAX) out.push(`name exceeds ${NAME_MAX} chars`);
  else if (!NAME_PATTERN.test(name)) out.push(`name must match ${NAME_PATTERN} (got "${name}")`);

  const description = fm.description ?? "";
  if (!description) out.push("missing description");
  else if (description.length > DESCRIPTION_MAX) out.push(`description exceeds ${DESCRIPTION_MAX} chars`);

  return out;
};

export const auditSkill = (skill, mdText) => {
  const block = extractFrontmatterBlock(mdText ?? "");
  if (block === null) return { violations: [{ skill, reason: "no frontmatter block" }] };
  const fm = parseFrontmatter(block);
  return { violations: violationsFor(fm).map((reason) => ({ skill, reason })) };
};

export const auditAllSkills = (skillsDir) => {
  const skills = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(skillsDir, e.name, "SKILL.md")))
    .map((e) => e.name);

  const violations = skills.flatMap((skill) => {
    const md = readFileSync(join(skillsDir, skill, "SKILL.md"), "utf8");
    return auditSkill(skill, md).violations;
  });
  return { skills, violations };
};

const isMain = () => import.meta.url === `file://${process.argv[1]}`;

if (isMain()) {
  const skillsDir = process.argv[2] || join(process.cwd(), "skills");
  const { skills, violations } = auditAllSkills(skillsDir);
  if (violations.length === 0) {
    process.stdout.write(`PI skill audit: ${skills.length} skills OK\n`);
    process.exit(0);
  }
  for (const v of violations) process.stdout.write(`VIOLATION ${v.skill}: ${v.reason}\n`);
  process.exit(1);
}
