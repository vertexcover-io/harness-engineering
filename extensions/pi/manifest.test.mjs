import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("S10: package.json pi.skills points at the shared skills tree that exists", () => {
  assert.ok(Array.isArray(pkg.pi?.skills), "pi.skills must be an array");
  for (const rel of pkg.pi.skills) {
    assert.ok(existsSync(join(ROOT, rel)), `pi.skills path missing: ${rel}`);
  }
});

test("S10: package.json pi.extensions points at the harness-hooks extension that exists", () => {
  assert.ok(Array.isArray(pkg.pi?.extensions), "pi.extensions must be an array");
  assert.ok(
    pkg.pi.extensions.some((p) => p.includes("harness-hooks")),
    "pi.extensions must include the harness-hooks bridge",
  );
  for (const rel of pkg.pi.extensions) {
    assert.ok(existsSync(join(ROOT, rel)), `pi.extensions path missing: ${rel}`);
  }
});

test("S11: README documents pi install (full) and npx skills --agent pi (skills-only)", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(
    /pi install git:github\.com\/vertexcover-io\/harness-engineering/.test(readme),
    "README must document the `pi install git:` full-install path",
  );
  assert.ok(
    /npx skills add [^\n]*--agent pi/.test(readme),
    "README must document `npx skills add … --agent pi`",
  );
});

test("S11: README unified npx skills note covers claude-code, codex, and pi with the skills-only caveat", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  for (const agent of ["claude-code", "codex", "pi"]) {
    assert.ok(
      new RegExp(`--agent ${agent}`).test(readme),
      `README must mention --agent ${agent}`,
    );
  }
  assert.ok(
    /skills[- ]only|only.*skills|not.*hooks|hooks.*require/i.test(readme),
    "README must state the skills-CLI path is skills-only (hooks need native install)",
  );
});
