import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { auditSkill, auditAllSkills } from "./pi-skill-audit.mjs";

const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");

const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, "SKILL.md")))
  .map((e) => e.name);

test("S3: every harness SKILL.md satisfies PI's frontmatter rules — no violations", () => {
  const { violations } = auditAllSkills(SKILLS_DIR);
  assert.deepEqual(
    violations,
    [],
    `PI-incompatible frontmatter:\n${violations.map((v) => `  ${v.skill}: ${v.reason}`).join("\n")}`,
  );
});

test("S3: auditSkill rejects a name with uppercase or spaces", () => {
  const md = "---\nname: Bad Name\ndescription: valid description\n---\nbody";
  const { violations } = auditSkill("x", md);
  assert.ok(
    violations.some((v) => v.reason.includes("name")),
    "expected a name violation for 'Bad Name'",
  );
});

test("S3: auditSkill rejects a description over 1024 chars", () => {
  const md = `---\nname: ok\ndescription: ${"a".repeat(1025)}\n---\nbody`;
  const { violations } = auditSkill("x", md);
  assert.ok(
    violations.some((v) => v.reason.includes("description")),
    "expected a description length violation",
  );
});

test("S3: auditSkill accepts a folded (>) multi-line description within budget", () => {
  const md = "---\nname: ok\ndescription: >\n  line one of the description\n  line two continues it\n---\nbody";
  const { violations } = auditSkill("ok", md);
  assert.deepEqual(violations, [], "folded description within budget must pass");
});

test("S3: auditSkill tolerates unknown keys (PI ignores them) — argument-hint, user-invocable", () => {
  const md = "---\nname: ok\ndescription: fine\nargument-hint: x\nuser-invocable: true\n---\nbody";
  const { violations } = auditSkill("ok", md);
  assert.deepEqual(violations, [], "PI ignores unknown frontmatter keys; they must not be violations");
});

test("S3: real skill set is non-empty (audit actually ran over content)", () => {
  assert.ok(skillDirs.length >= 20, `expected the 25 harness skills, found ${skillDirs.length}`);
});
