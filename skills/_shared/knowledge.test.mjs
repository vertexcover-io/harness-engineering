// Tests for knowledge.mjs — sandbox pattern mirrors hooks/coder-e2e-gate.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "knowledge.mjs");

const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: "utf8" });

const makeSandbox = () => {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-test-"));
  sh(dir, "git", ["init", "-q"]);
  sh(dir, "git", ["config", "user.email", "t@t.local"]);
  sh(dir, "git", ["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-qm", "init"]);
  return dir;
};

const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

const runKnowledge = (dir, args) => {
  const res = spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {}
  return { code: res.status, json, stdout: res.stdout, stderr: res.stderr };
};

// REQ-002 / EDGE-001: fresh repo → verify bootstraps zones + INDEX + README
test("verify bootstraps zones, INDEX, and README on a fresh repo", () => {
  const dir = makeSandbox();
  try {
    const { code, json } = runKnowledge(dir, ["verify"]);
    assert.equal(code, 1, "bootstrap actions taken → exit 1");
    for (const p of [
      ".harness/knowledge/lessons",
      ".harness/knowledge/context",
      ".harness/features",
      ".harness/runtime",
    ]) {
      assert.ok(existsSync(join(dir, p)), `${p} created`);
      assert.ok(json.created.includes(p), `${p} reported in created`);
    }
    assert.ok(existsSync(join(dir, ".harness/knowledge/INDEX.md")), "INDEX created");
    assert.ok(existsSync(join(dir, ".harness/README.md")), "README created");
    assert.deepEqual(json.errors, [], "no errors");
  } finally {
    cleanup(dir);
  }
});

// REQ-002: second verify is a no-op
test("verify is idempotent — second run reports nothing created, exit 0", () => {
  const dir = makeSandbox();
  try {
    runKnowledge(dir, ["verify"]);
    const { code, json } = runKnowledge(dir, ["verify"]);
    assert.equal(code, 0);
    assert.deepEqual(json.created, []);
  } finally {
    cleanup(dir);
  }
});

const write = (dir, rel, body) => {
  mkdirSync(join(dir, dirname(rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};

// Old-layout fixture: tracked docs roots + broad gitignore
const makeOldLayout = () => {
  const dir = makeSandbox();
  write(dir, "docs/context/ARCHITECTURE.md", "# arch\n");
  write(dir, "docs/context/standards/S-api.md", "# S-api\n");
  write(dir, "docs/spec/foo/design.md", "# design\n");
  write(dir, "docs/specs/2026-01-01-coverage-gap-spec.md", "# stray\n");
  writeFileSync(join(dir, ".gitignore"), ".harness/\ndocs/solutions/\n");
  sh(dir, "git", ["add", "-A"]);
  sh(dir, "git", ["commit", "-qm", "old layout"]);
  return dir;
};

// REQ-004 / REQ-007: migrate moves tracked roots and narrows gitignore in one commit
test("migrate moves tracked old roots to zones, narrows gitignore, commits standalone", () => {
  const dir = makeOldLayout();
  try {
    const { code, json } = runKnowledge(dir, ["migrate"]);
    assert.equal(code, 1, "actions taken");
    assert.ok(existsSync(join(dir, ".harness/knowledge/context/ARCHITECTURE.md")));
    assert.ok(existsSync(join(dir, ".harness/knowledge/context/standards/S-api.md")));
    assert.ok(existsSync(join(dir, ".harness/features/foo/design.md")));
    assert.ok(existsSync(join(dir, ".harness/features/2026-01-01-coverage-gap-spec.md")));
    assert.ok(!existsSync(join(dir, "docs/context")), "old context root gone");
    assert.ok(!existsSync(join(dir, "docs/spec")), "old spec root gone");
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.ok(gitignore.includes(".harness/runtime/"), "narrowed rule present");
    assert.ok(!/^\.harness\/$/m.test(gitignore), "broad rule removed");
    assert.ok(json.gitignore_changed);
    assert.ok(json.migrated.some((m) => m.from === "docs/context"));
    // standalone commit: working tree clean, last commit is migration-only
    const porcelain = sh(dir, "git", ["status", "--porcelain"]).stdout.trim();
    assert.equal(porcelain, "", "everything committed");
    const subject = sh(dir, "git", ["log", "-1", "--pretty=%s"]).stdout;
    assert.ok(/migrate/i.test(subject), "migration commit subject");
  } finally {
    cleanup(dir);
  }
});

// REQ-004: gitignored roots (docs/solutions, legacy .harness/<spec>) move via fs rename
test("migrate moves gitignored roots: solutions → lessons, legacy .harness specs → runtime", () => {
  const dir = makeOldLayout();
  try {
    write(dir, "docs/solutions/gotchas/pool-exhaustion.md", "# gotcha\n");
    write(dir, ".harness/oldspec/baseline.json", "{}\n");
    write(dir, ".harness/oldspec/phase-1.md", "# p1\n");
    const { code, json } = runKnowledge(dir, ["migrate"]);
    assert.equal(code, 1);
    assert.ok(existsSync(join(dir, ".harness/knowledge/lessons/gotchas/pool-exhaustion.md")));
    assert.ok(existsSync(join(dir, ".harness/runtime/oldspec/baseline.json")));
    assert.ok(existsSync(join(dir, ".harness/runtime/oldspec/phase-1.md")));
    assert.ok(!existsSync(join(dir, "docs/solutions")), "solutions root gone");
    assert.ok(!existsSync(join(dir, ".harness/oldspec")), "legacy spec dir gone");
    assert.ok(json.migrated.some((m) => m.from === ".harness/oldspec"));
  } finally {
    cleanup(dir);
  }
});

// REQ-005: second migrate run is a no-op
test("migrate is idempotent — second run moves nothing, exit 0", () => {
  const dir = makeOldLayout();
  try {
    runKnowledge(dir, ["migrate"]);
    const before = sh(dir, "git", ["status", "--porcelain"]).stdout;
    const { code, json } = runKnowledge(dir, ["migrate"]);
    assert.equal(code, 0);
    assert.deepEqual(json.migrated, []);
    assert.equal(json.gitignore_changed, false);
    assert.equal(sh(dir, "git", ["status", "--porcelain"]).stdout, before);
  } finally {
    cleanup(dir);
  }
});

// REQ-006 / EDGE-007: dirty old-root paths defer; clean ones still move
test("migrate defers dirty paths and moves the rest", () => {
  const dir = makeOldLayout();
  try {
    writeFileSync(join(dir, "docs/spec/foo/design.md"), "# modified, uncommitted\n");
    const { code, json } = runKnowledge(dir, ["migrate"]);
    assert.equal(code, 1);
    assert.ok(existsSync(join(dir, "docs/spec/foo/design.md")), "dirty path stays");
    assert.ok(!existsSync(join(dir, ".harness/features/foo")), "dirty path not moved");
    assert.ok(
      existsSync(join(dir, ".harness/knowledge/context/ARCHITECTURE.md")),
      "clean root still moved",
    );
    assert.ok(json.deferred.some((d) => d.path === "docs/spec/foo" && d.reason));
    // deferred path must not be swept into the migration commit
    const show = sh(dir, "git", ["show", "--stat", "--name-only", "HEAD"]).stdout;
    assert.ok(!show.includes("docs/spec/foo/design.md"), "dirty file not committed");
  } finally {
    cleanup(dir);
  }
});

// REQ-008: --dry-run reports the same plan without touching the tree
test("migrate --dry-run changes nothing on disk", () => {
  const dir = makeOldLayout();
  try {
    const hashBefore = sh(dir, "git", ["stash", "create"]).stdout; // no-op probe
    const { code, json } = runKnowledge(dir, ["migrate", "--dry-run"]);
    assert.equal(code, 1, "would take actions");
    assert.ok(json.migrated.some((m) => m.from === "docs/context"));
    assert.ok(json.gitignore_changed, "reports the gitignore change it WOULD make");
    assert.ok(existsSync(join(dir, "docs/context/ARCHITECTURE.md")), "nothing moved");
    assert.ok(!existsSync(join(dir, ".harness")), "no zones created");
    assert.equal(
      readFileSync(join(dir, ".gitignore"), "utf8"),
      ".harness/\ndocs/solutions/\n",
      "gitignore untouched",
    );
    assert.equal(sh(dir, "git", ["stash", "create"]).stdout, hashBefore, "tree unchanged");
  } finally {
    cleanup(dir);
  }
});

const lessonDoc = (title, { applies = '["src/api/**"]', tags = '[auth]', ec = 1, lv = "2026-06-01" } = {}) =>
  `---
title: "${title}"
category: gotchas
applies_to: ${applies}
tags: ${tags}
evidence_count: ${ec}
last_validated: ${lv}
---

# ${title}

Body.
`;

// REQ-013: reindex regenerates INDEX deterministically from frontmatter
test("reindex builds INDEX from lesson+standard frontmatter, sorted, deterministic", () => {
  const dir = makeSandbox();
  try {
    runKnowledge(dir, ["verify"]);
    write(dir, ".harness/knowledge/lessons/gotchas/low.md", lessonDoc("Low evidence", { ec: 1 }));
    write(dir, ".harness/knowledge/lessons/gotchas/high.md", lessonDoc("High evidence", { ec: 5 }));
    write(
      dir,
      ".harness/knowledge/context/standards/S-api.md",
      `---\ntitle: "S-api error shapes"\napplies_to: ["src/api/**"]\n---\n\n# S-api\n`,
    );
    const r1 = runKnowledge(dir, ["reindex"]);
    assert.equal(r1.json.entries, 3);
    const index1 = readFileSync(join(dir, ".harness/knowledge/INDEX.md"), "utf8");
    const high = index1.indexOf("High evidence");
    const low = index1.indexOf("Low evidence");
    assert.ok(high !== -1 && low !== -1 && high < low, "sorted by evidence_count desc");
    assert.ok(index1.includes("(lessons/gotchas/high.md)"), "lesson path relative to knowledge/");
    assert.ok(index1.includes("ec:5"), "row carries evidence count");
    assert.ok(index1.includes("applies_to: src/api/**"), "row carries routing globs");
    // hand-edits do not survive; double run is byte-identical
    writeFileSync(join(dir, ".harness/knowledge/INDEX.md"), index1 + "- hand edit\n");
    runKnowledge(dir, ["reindex"]);
    const index2 = readFileSync(join(dir, ".harness/knowledge/INDEX.md"), "utf8");
    assert.equal(index2, index1, "regenerated, hand edit gone, byte-identical");
  } finally {
    cleanup(dir);
  }
});

// REQ-014 / EDGE-012: 101st entry evicts exactly the weakest, deterministically
test("reindex caps INDEX at 100 and evicts the weakest entry", () => {
  const dir = makeSandbox();
  try {
    runKnowledge(dir, ["verify"]);
    for (let i = 0; i < 100; i++) {
      write(
        dir,
        `.harness/knowledge/lessons/gotchas/l${String(i).padStart(3, "0")}.md`,
        lessonDoc(`Lesson ${i}`, { ec: 2, lv: "2026-06-01" }),
      );
    }
    write(
      dir,
      ".harness/knowledge/lessons/gotchas/weakest.md",
      lessonDoc("Weakest", { ec: 1, lv: "2025-01-01" }),
    );
    const r1 = runKnowledge(dir, ["reindex"]);
    assert.equal(r1.json.entries, 100);
    assert.deepEqual(r1.json.evicted, ["lessons/gotchas/weakest.md"]);
    const index = readFileSync(join(dir, ".harness/knowledge/INDEX.md"), "utf8");
    assert.ok(!index.includes("Weakest"), "evicted entry not in INDEX");
    assert.ok(
      existsSync(join(dir, ".harness/knowledge/lessons/gotchas/weakest.md")),
      "evicted lesson file survives on disk",
    );
    const r2 = runKnowledge(dir, ["reindex"]);
    assert.deepEqual(r2.json.evicted, r1.json.evicted, "deterministic across runs");
  } finally {
    cleanup(dir);
  }
});

// REQ-015: lessons citing deleted files are flagged stale
test("reindex lists lessons whose related files no longer exist in {stale}", () => {
  const dir = makeSandbox();
  try {
    runKnowledge(dir, ["verify"]);
    write(dir, "src/api/handler.js", "// exists\n");
    write(
      dir,
      ".harness/knowledge/lessons/gotchas/fresh.md",
      `---\ntitle: "Fresh"\nrelated: ["src/api/handler.js"]\nevidence_count: 1\n---\n\n# Fresh\n`,
    );
    write(
      dir,
      ".harness/knowledge/lessons/gotchas/stale.md",
      `---\ntitle: "Stale"\nrelated: ["src/api/deleted.js"]\nevidence_count: 1\n---\n\n# Stale\n`,
    );
    const { json } = runKnowledge(dir, ["reindex"]);
    assert.deepEqual(json.stale, ["lessons/gotchas/stale.md"]);
  } finally {
    cleanup(dir);
  }
});

// REQ-011: no skill may reference old artifact roots. Exclusions: evals
// fixtures (may intentionally show old layouts) and the knowledge contract
// (documents the old→new migration mapping itself).
test("REQ-011: skills reference only unified .harness paths", () => {
  const skillsRoot = join(dirname(SCRIPT), "..");
  const walk = (d, out = []) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory() && e.name !== "evals" && e.name !== "node_modules") walk(p, out);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
    }
    return out;
  };
  const OLD_DOCS = /\bdocs\/(spec|specs|context|solutions|superpowers)(\/|\b)/;
  const OLD_HARNESS = /\.harness\/(?!runtime\/|runtime`|knowledge\/|knowledge`|features\/|features`|README)/;
  const offenders = [];
  for (const f of walk(skillsRoot)) {
    if (f.endsWith(join("_shared", "knowledge.md"))) continue;
    const text = readFileSync(f, "utf8");
    for (const [i, line] of text.split("\n").entries()) {
      if (OLD_DOCS.test(line) || OLD_HARNESS.test(line)) {
        offenders.push(`${f.slice(skillsRoot.length + 1)}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `old-root references:\n${offenders.join("\n")}`);
});

// REQ-016 / REQ-021 / EDGE-004: route ranks path-matches above tag-only, writes
// advisory-delimited full text, appends matched standards
test("route ranks path matches first and writes advisory-wrapped lessons", () => {
  const dir = makeSandbox();
  try {
    runKnowledge(dir, ["verify"]);
    write(dir, "src/api/handler.js", "// app code\n");
    write(
      dir,
      ".harness/knowledge/lessons/gotchas/path-hit.md",
      lessonDoc("Path hit", { applies: '["src/api/**"]', tags: "[perf]" }),
    );
    write(
      dir,
      ".harness/knowledge/lessons/gotchas/tag-hit.md",
      lessonDoc("Tag hit", { applies: '["scripts/**"]', tags: "[auth]" }),
    );
    write(
      dir,
      ".harness/knowledge/lessons/gotchas/no-hit.md",
      lessonDoc("No hit", { applies: '["scripts/**"]', tags: "[css]" }),
    );
    write(
      dir,
      ".harness/knowledge/context/standards/S-api.md",
      `---\ntitle: "S-api error shapes"\napplies_to: ["src/api/**"]\n---\n\n# S-api rule body\n`,
    );
    const { json } = runKnowledge(dir, [
      "route", "--spec", "myspec", "--keywords", "auth,retry", "--paths", "src/api/handler.js",
    ]);
    assert.equal(json.matched, 3, "2 lessons + 1 standard");
    const out = readFileSync(join(dir, ".harness/runtime/myspec/relevant-lessons.md"), "utf8");
    assert.ok(out.includes("advisory-reference"), "advisory delimiter present (REQ-021)");
    const pathIdx = out.indexOf("## Lesson: Path hit");
    const tagIdx = out.indexOf("## Lesson: Tag hit");
    assert.ok(pathIdx !== -1 && tagIdx !== -1 && pathIdx < tagIdx, "path match ranks first");
    assert.ok(!out.includes("No hit"), "non-matching lesson excluded");
    assert.ok(out.includes("## Standard: S-api error shapes"), "matched standard appended");
    assert.ok(out.includes("Body."), "full lesson body included");
    assert.ok(!out.includes("evidence_count:"), "frontmatter stripped");
  } finally {
    cleanup(dir);
  }
});

// REQ-017 / EDGE-005: broad globs (>50% of tracked files) demote to tag-only
test("route demotes ** globs to tag-only and excludes them without a tag match", () => {
  const dir = makeSandbox();
  try {
    runKnowledge(dir, ["verify"]);
    write(
      dir,
      ".harness/knowledge/lessons/gotchas/greedy-no-tag.md",
      lessonDoc("Greedy no tag", { applies: '["**"]', tags: "[css]" }),
    );
    write(
      dir,
      ".harness/knowledge/lessons/gotchas/greedy-tagged.md",
      lessonDoc("Greedy tagged", { applies: '["**"]', tags: "[auth]" }),
    );
    write(
      dir,
      ".harness/knowledge/lessons/gotchas/specific.md",
      lessonDoc("Specific", { applies: '["src/api/**"]', tags: "[css]" }),
    );
    write(dir, "src/api/handler.js", "// code\n");
    sh(dir, "git", ["add", "-A"]);
    sh(dir, "git", ["commit", "-qm", "track files"]);
    const { json } = runKnowledge(dir, [
      "route", "--spec", "s", "--keywords", "auth", "--paths", "src/api/handler.js",
    ]);
    const out = readFileSync(join(dir, ".harness/runtime/s/relevant-lessons.md"), "utf8");
    assert.ok(!out.includes("Greedy no tag"), "** with no tag match excluded");
    const specificIdx = out.indexOf("## Lesson: Specific");
    const greedyIdx = out.indexOf("## Lesson: Greedy tagged");
    assert.ok(specificIdx !== -1 && greedyIdx !== -1 && specificIdx < greedyIdx,
      "** demoted below real path match even though ** matches the path");
    assert.equal(json.matched, 2);
  } finally {
    cleanup(dir);
  }
});

// REQ-018 / EDGE-014: zero matches → byte-exact sentinel
test("route writes exact sentinel when nothing matches", () => {
  const dir = makeSandbox();
  try {
    runKnowledge(dir, ["verify"]);
    write(
      dir,
      ".harness/knowledge/lessons/gotchas/x.md",
      lessonDoc("X", { applies: '["scripts/**"]', tags: "[css]" }),
    );
    const { json } = runKnowledge(dir, [
      "route", "--spec", "empty", "--keywords", "auth", "--paths", "src/api/a.js",
    ]);
    assert.equal(json.matched, 0);
    assert.equal(
      readFileSync(join(dir, ".harness/runtime/empty/relevant-lessons.md"), "utf8"),
      "No prior lessons match this spec.\n",
    );
  } finally {
    cleanup(dir);
  }
});

// REQ-003 / EDGE-003: broad .harness/ gitignore must fail loudly
test("verify exits 2 when .harness/knowledge is gitignored", () => {
  const dir = makeSandbox();
  try {
    writeFileSync(join(dir, ".gitignore"), ".harness/\n");
    const { code, json } = runKnowledge(dir, ["verify"]);
    assert.equal(code, 2, "loud failure");
    assert.ok(
      json.errors.some((e) => e.includes(".harness/runtime/")),
      "error names the fix (narrow to .harness/runtime/)",
    );
  } finally {
    cleanup(dir);
  }
});
