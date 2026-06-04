// Tests for the context-map resolver lib, the phase-context CLI, and the
// SessionStart hook. Each test builds an isolated tmp docs/context fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findContextRoot,
  readFrontmatter,
  extractSection,
  resolveOwningDoc,
  matchStandards,
  extractFlowTrace,
  cap,
  packSections,
  buildPhaseContext,
  resolvePhasePaths,
} from "./_lib/context-map.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "_lib", "context-map.mjs");
const HOOK = join(HERE, "session-start-context.mjs");

const write = (dir, rel, body) => {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};

const makeFixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-map-"));
  write(dir, "docs/context/INDEX.md", "---\nstatus: active\n---\n# Read order\n1. ARCH\n");
  write(dir, "docs/context/ARCHITECTURE.md", "---\nstatus: active\n---\n# Architecture\nHono.\n## Boundaries\nx\n");
  write(dir, "docs/context/.sync-report.md", "context-map sync @ abc\nverdict: PASS\n");
  write(
    dir,
    "docs/context/standards/global.md",
    "---\nid: S-global\napplies_to: [\"**/*\"]\nenforced_by: convention\nstatus: active\n---\n# Global\n## S-global-01 — Early returns\n**Rule:** early returns.\n"
  );
  write(
    dir,
    "docs/context/standards/api.md",
    "---\nid: S-api\napplies_to: [\"packages/api/src/**\", \"**/routes/**\"]\nenforced_by: eslint\ndecisions: [D-002]\nstatus: active\n---\n# API\n## S-api-01 — Routes thin\n**Rule:** no DB in routes.\n"
  );
  write(
    dir,
    "docs/context/standards/python.md",
    "---\nid: S-py\napplies_to: [\"**/*.py\", \"**/*.pyi\"]\nenforced_by: tsconfig\nstatus: active\n---\n# Python\n## S-py-01 — Type hints\n**Rule:** annotate.\n"
  );
  write(
    dir,
    "docs/context/DECISIONS.md",
    "# Decisions index\n| id | title | lives in |\n|----|-------|----------|\n| D-001 | Auth model | DECISIONS.md |\n| D-014 | Routes delegate | packages/api/PACKAGE.md |\n\n# Cross-package decisions\n## D-001 — Auth model\n**Why:** session cookie.\n"
  );
  write(
    dir,
    "docs/context/packages/api/PACKAGE.md",
    "---\ngoverns: packages/api/src\nstatus: active\n---\n# api\n## Purpose\nHTTP.\n## Data flows\nlistUsers(req) → res:\n  req → repo.findAll → 200\n## Gotchas / landmines\n- 404 empty body.\n"
  );
  write(
    dir,
    "docs/context/packages/api/src/routes/PACKAGE.md",
    "---\ngoverns: packages/api/src/routes\nstatus: active\n---\n# routes\n## Purpose\nHandlers.\n## Data flows\ncreateUser(req) → res:\n  req → validate → 201   (D-002)\n## Gotchas / landmines\n- 409 dup.\n"
  );
  return dir;
};

test("findContextRoot walks up to docs/context", () => {
  const dir = makeFixture();
  try {
    assert.equal(findContextRoot(join(dir, "packages", "api")), join(dir, "docs", "context"));
    assert.equal(findContextRoot("/"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Unified layout: .harness/knowledge/context wins; docs/context is the
// pre-migration fallback (covered by the test above).
test("findContextRoot prefers .harness/knowledge/context over docs/context", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-map-new-"));
  try {
    write(dir, ".harness/knowledge/context/ARCHITECTURE.md", "# arch\n");
    assert.equal(
      findContextRoot(join(dir, "packages", "api")),
      join(dir, ".harness", "knowledge", "context"),
      "finds the unified root with no docs/context present",
    );
    write(dir, "docs/context/ARCHITECTURE.md", "# old\n");
    assert.equal(
      findContextRoot(dir),
      join(dir, ".harness", "knowledge", "context"),
      "unified root wins when both exist",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readFrontmatter parses scalars and lists", () => {
  const { frontmatter, body } = readFrontmatter(
    "---\nid: S-api\napplies_to: [\"a/**\", \"b\"]\nstatus: active\n---\n# Title\nbody\n"
  );
  assert.equal(frontmatter.id, "S-api");
  assert.deepEqual(frontmatter.applies_to, ["a/**", "b"]);
  assert.match(body, /# Title/);
});

test("extractSection returns body up to next heading", () => {
  const md = "## Purpose\nthe why\nmore\n## Gotchas\nbad\n";
  assert.equal(extractSection(md, "Purpose"), "the why\nmore");
  assert.equal(extractSection(md, "Nope"), "");
});

test("resolveOwningDoc picks longest governs prefix", () => {
  const dir = makeFixture();
  const root = join(dir, "docs", "context");
  try {
    const doc = resolveOwningDoc(join(dir, "packages/api/src/routes/users.ts"), root, dir);
    assert.match(doc.docPath, /api\/src\/routes\/PACKAGE\.md$/);
    const doc2 = resolveOwningDoc(join(dir, "packages/api/src/db.ts"), root, dir);
    assert.match(doc2.docPath, /api\/PACKAGE\.md$/);
    assert.equal(resolveOwningDoc(join(dir, "packages/web/x.ts"), root, dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("matchStandards routes by applies_to globs", () => {
  const dir = makeFixture();
  const root = join(dir, "docs", "context");
  try {
    const apiHits = matchStandards(join(dir, "packages/api/src/routes/users.ts"), root, dir).map((s) =>
      s.frontmatter.id
    );
    assert.ok(apiHits.includes("S-api"));
    assert.ok(apiHits.includes("S-global"));
    assert.ok(!apiHits.includes("S-py"));

    const pyHits = matchStandards(join(dir, "scripts/foo.py"), root, dir).map((s) => s.frontmatter.id);
    assert.ok(pyHits.includes("S-py"));
    assert.ok(pyHits.includes("S-global"));
    assert.ok(!pyHits.includes("S-api"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extractFlowTrace narrows to a single fn block", () => {
  const md = "## Data flows\na(x) → y:\n  step\nb(z) → w:\n  step2\n";
  assert.match(extractFlowTrace(md, "a"), /a\(x\)/);
  assert.ok(!extractFlowTrace(md, "a").includes("b(z)"));
  assert.match(extractFlowTrace(md, null), /a\(x\)/);
});

test("cap truncates with marker", () => {
  assert.equal(cap("abc", 10), "abc");
  assert.match(cap("abcdefghij", 3), /…\[truncated\]$/);
});

test("packSections keeps whole blocks and points at dropped ones", () => {
  const blocks = [
    { ref: "a.md", text: "AAAA" },
    { ref: "b.md", text: "BBBB" },
    { ref: "c.md", text: "CCCC" },
  ];
  // budget fits only the first block; the rest degrade to a pointer (never cut)
  const out = packSections(blocks, 5, "docs");
  assert.match(out, /AAAA/);
  assert.ok(!out.includes("BBBB"));
  assert.match(out, /…2 more docs apply — read in full: b\.md, c\.md/);
  // no block is ever sliced mid-content
  assert.ok(!/AA…|BB…/.test(out));
  // disabled budget includes everything
  assert.equal(packSections(blocks, 0, "docs"), "AAAA\n\nBBBB\n\nCCCC");
  assert.equal(packSections([], 5, "docs"), "");
});

test("buildPhaseContext dedupes and includes standards + package", () => {
  const dir = makeFixture();
  const root = join(dir, "docs", "context");
  try {
    const block = buildPhaseContext(
      [join(dir, "packages/api/src/routes/users.ts"), join(dir, "packages/api/src/routes/posts.ts")],
      root,
      dir,
      {}
    );
    assert.match(block, /S-api-01/);
    assert.match(block, /createUser/);
    // routes PACKAGE.md appears once despite two files in it
    assert.equal((block.match(/routes\/PACKAGE\.md/g) || []).length, 1);
    // a file with no owning package still gets the global catch-all standard, no api/package noise
    const webBlock = buildPhaseContext([join(dir, "packages/web/x.ts")], root, dir, {});
    assert.match(webBlock, /S-global-01/);
    assert.ok(!webBlock.includes("S-api-01"));
    assert.ok(!webBlock.includes("Package context"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phase-context CLI: block on stdout, INJECTED marker on stderr", () => {
  const dir = makeFixture();
  try {
    const r = spawnSync(process.execPath, [LIB, "phase-context", "packages/api/src/routes/users.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /S-api-01/);
    assert.match(r.stderr, /CONTEXT_MAP:INJECTED docs=\d+ standards=\d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phase-context CLI markers distinguish NONE vs EMPTY", () => {
  const none = spawnSync(process.execPath, [LIB, "phase-context", "a.ts"], {
    cwd: tmpdir(),
    encoding: "utf8",
  });
  assert.equal(none.status, 0);
  assert.equal(none.stdout.trim(), "");
  assert.match(none.stderr, /CONTEXT_MAP:NONE/);

  // map exists but file matches no package and no standards → EMPTY
  const dir = mkdtempSync(join(tmpdir(), "ctx-empty-"));
  write(dir, "docs/context/INDEX.md", "---\n---\n# x\n");
  write(dir, "docs/context/packages/api/PACKAGE.md", "---\ngoverns: packages/api/src\n---\n# api\n");
  try {
    const empty = spawnSync(process.execPath, [LIB, "phase-context", "totally/unrelated.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(empty.stdout.trim(), "");
    assert.match(empty.stderr, /CONTEXT_MAP:EMPTY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diff mode resolves untracked (newly-created) files", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-diff-"));
  const sh = (args) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  try {
    write(dir, "docs/context/standards/api.md", "---\napplies_to: [\"**/routes/**\"]\nenforced_by: eslint\n---\n# API\n## S-api-01 — thin\n");
    sh(["init", "-q"]);
    sh(["config", "user.email", "t@t"]);
    sh(["config", "user.name", "t"]);
    sh(["add", "-A"]);
    sh(["commit", "-qm", "init"]);
    const sha = sh(["rev-parse", "HEAD"]).stdout.trim();
    write(dir, "packages/api/src/routes/new.ts", "export const x = 1\n"); // untracked
    const r = spawnSync(process.execPath, [LIB, "diff", sha], { cwd: dir, encoding: "utf8" });
    assert.match(r.stdout, /S-api-01/);
    assert.match(r.stderr, /CONTEXT_MAP:INJECTED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolvePhasePaths returns repo-relative doc + standards paths, deduped", () => {
  const dir = makeFixture();
  const root = join(dir, "docs", "context");
  try {
    const r = resolvePhasePaths(
      [join(dir, "packages/api/src/routes/users.ts"), join(dir, "packages/api/src/routes/posts.ts")],
      root,
      dir
    );
    assert.deepEqual(r.docs, ["docs/context/packages/api/src/routes/PACKAGE.md"]); // deduped to one
    assert.ok(r.standards.some((s) => s.endsWith("standards/api.md")));
    assert.ok(r.standards.some((s) => s.endsWith("standards/global.md")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("phase-paths CLI lists paths on stdout + INJECTED marker", () => {
  const dir = makeFixture();
  try {
    const r = spawnSync(process.execPath, [LIB, "phase-paths", "packages/api/src/routes/users.ts"], {
      cwd: dir,
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Package docs:/);
    assert.match(r.stdout, /routes\/PACKAGE\.md/);
    assert.match(r.stdout, /Standards:/);
    assert.match(r.stdout, /standards\/api\.md/);
    // pointer mode does NOT paste bodies
    assert.ok(!r.stdout.includes("createUser"));
    assert.match(r.stderr, /CONTEXT_MAP:INJECTED docs=1 standards=2/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildPhaseContext withStats returns counts", () => {
  const dir = makeFixture();
  const root = join(dir, "docs", "context");
  try {
    const r = buildPhaseContext([join(dir, "packages/api/src/routes/users.ts")], root, dir, {
      withStats: true,
    });
    assert.ok(r.block.length > 0);
    assert.equal(r.docs, 1);
    assert.ok(r.standards >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SessionStart hook injects context and no-ops without a map", () => {
  const dir = makeFixture();
  try {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: "SessionStart", cwd: dir, source: "startup" }),
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
    assert.match(parsed.hookSpecificOutput.additionalContext, /Project standards/);
    // root DECISIONS.md (index + cross-package bodies) is injected at session start
    assert.match(parsed.hookSpecificOutput.additionalContext, /Decisions index/);
    assert.match(parsed.hookSpecificOutput.additionalContext, /D-001/);

    const noop = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ hook_event_name: "SessionStart", cwd: tmpdir() }),
      encoding: "utf8",
    });
    assert.equal(noop.status, 0);
    assert.equal(noop.stdout.trim(), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
