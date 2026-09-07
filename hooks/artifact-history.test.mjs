import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACTS, run } from "./artifact-history.mjs";

const REPO = join(import.meta.dirname, "..");
const NOW = new Date("2026-08-27T14:32:00Z");

const template = (rel) => readFileSync(join(REPO, rel), "utf8");

// Fixtures come from the real templates: a hand-written one only proves the
// completeness predicate matches this file.
const PLAN_SHELL = template("skills/planning/scripts/plan-shell.html");
const PROOF_TEMPLATE = template("skills/functional-verify/references/proof-report-template.html");

const COMPLETE_PLAN = PLAN_SHELL.slice(0, PLAN_SHELL.indexOf("<!-- SLOT:content")) + "<section>done</section>";
const FILLED_PROOF = PROOF_TEMPLATE.replace('"<feature name>"', '"Checkout flow"');

const sandbox = () => mkdtempSync(join(tmpdir(), "artifact-history-"));
const clean = (dir) => rmSync(dir, { recursive: true, force: true });

const write = (dir, rel, body) => {
  const p = join(dir, ".harness", rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
};

const historyOf = (dir, spec = "") => {
  const h = join(dir, ".harness", spec, "history");
  return existsSync(h) ? readdirSync(h).filter((f) => !f.startsWith(".")).sort() : [];
};

const indexOf = (dir, spec = "") => readFileSync(join(dir, ".harness", spec, "history/index.md"), "utf8");

const go = (dir) => run([], dir, NOW);

test("no .harness directory is a clean no-op", () => {
  const dir = sandbox();
  const { exitCode, stdout } = go(dir);
  assert.equal(exitCode, 0);
  assert.equal(stdout, "");
  clean(dir);
});

const FIXTURES = {
  "plan.html": { dir: "", unfinished: PLAN_SHELL, finished: COMPLETE_PLAN, archived: "plan-v1.html" },
  "design.md": { dir: "", unfinished: "   \n", finished: "# Design\n", archived: "design-v1.md" },
  "review.md": { dir: "review", unfinished: "   \n", finished: "# Review\n\nAPPROVE\n", archived: "review-v1.md" },
  "proof-report.html": {
    dir: "verification",
    unfinished: PROOF_TEMPLATE,
    finished: FILLED_PROOF,
    archived: "proof-report-v1",
  },
};

for (const { file } of ARTIFACTS) {
  test(`${file}: an unfinished artifact is not archived, a finished one is`, () => {
    const dir = sandbox();
    const { dir: sub, unfinished, finished, archived } = FIXTURES[file];
    const rel = join("add-search", sub, file);

    write(dir, rel, unfinished);
    go(dir);
    assert.deepEqual(historyOf(dir, "add-search"), [], "unfinished artifact was archived");

    write(dir, rel, finished);
    go(dir);
    assert.deepEqual(historyOf(dir, "add-search"), ["index.md", archived].sort());
    clean(dir);
  });
}

test("an unchanged artifact is not archived twice", () => {
  const dir = sandbox();
  write(dir, "add-search/plan.html", COMPLETE_PLAN);
  go(dir);
  const { stdout } = go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "plan-v1.html"]);
  assert.equal(stdout, "");
  clean(dir);
});

test("a changed artifact lands as the next version", () => {
  const dir = sandbox();
  write(dir, "add-search/plan.html", COMPLETE_PLAN);
  go(dir);
  write(dir, "add-search/plan.html", `${COMPLETE_PLAN}<!-- round 2 -->`);
  go(dir);
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "plan-v1.html", "plan-v2.html"]);
  clean(dir);
});

test("the index line records name, timestamp and size", () => {
  const dir = sandbox();
  write(dir, "add-search/design.md", "# Design\n");
  go(dir);
  assert.equal(indexOf(dir, "add-search"), "- design-v1.md — 2026-08-27 14:32 — 1 KB\n");
  clean(dir);
});

test("the index line reports a bundle's whole size, not just the report", () => {
  const dir = sandbox();
  write(dir, "add-search/verification/proof-report.html", FILLED_PROOF);
  write(dir, "add-search/verification/big.mp4", "x".repeat(40 * 1024));
  go(dir);

  const reportKb = Buffer.byteLength(FILLED_PROOF) / 1024;
  const reported = Number(/— (\d+) KB/.exec(indexOf(dir, "add-search"))?.[1]);
  assert.ok(reported >= reportKb + 39, `bundle reported ${reported} KB, evidence not counted`);
  clean(dir);
});

for (const [name, breakState] of [
  ["a missing", (p) => rmSync(p)],
  ["a corrupt", (p) => writeFileSync(p, '{"plan.html": {"hash"')],
  ["an empty", (p) => writeFileSync(p, "")],
]) {
  test(`${name} .state.json never overwrites an archived version`, () => {
    const dir = sandbox();
    write(dir, "add-search/plan.html", COMPLETE_PLAN);
    go(dir);

    breakState(join(dir, ".harness/add-search/history/.state.json"));
    write(dir, "add-search/plan.html", `${COMPLETE_PLAN}<!-- round 2 -->`);
    go(dir);

    assert.equal(
      readFileSync(join(dir, ".harness/add-search/history/plan-v1.html"), "utf8"),
      COMPLETE_PLAN,
      "v1 was overwritten",
    );
    assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "plan-v1.html", "plan-v2.html"]);
    clean(dir);
  });
}

test("one unarchivable artifact does not block the others in its spec", () => {
  const dir = sandbox();
  const historyDir = join(dir, ".harness/add-search/history");
  write(dir, "add-search/plan.html", COMPLETE_PLAN);
  write(dir, "add-search/design.md", "# Design\n");

  // An existing directory of the same name is what makes the copy fail.
  mkdirSync(join(historyDir, "plan-v1.html"), { recursive: true });
  go(dir);

  assert.ok(existsSync(join(historyDir, "design-v1.md")), "a later artifact was skipped after an earlier failure");
  clean(dir);
});

test("a failed archive does not re-archive the ones that landed", () => {
  const dir = sandbox();
  const historyDir = join(dir, ".harness/add-search/history");
  write(dir, "add-search/plan.html", COMPLETE_PLAN);
  write(dir, "add-search/design.md", "# Design\n");
  mkdirSync(join(historyDir, "design-v1.md"), { recursive: true });

  go(dir); // plan lands, design fails
  rmSync(join(historyDir, "design-v1.md"), { recursive: true });
  go(dir); // design gets a second chance

  const planLines = indexOf(dir, "add-search").match(/- plan-v1\.html /g) ?? [];
  assert.equal(planLines.length, 1, "a landed artifact was archived twice");
  assert.equal(readFileSync(join(historyDir, "plan-v1.html"), "utf8"), COMPLETE_PLAN);
  clean(dir);
});

test("one broken spec never stops a later one from being archived", () => {
  const dir = sandbox();
  write(dir, "aaa-broken/plan.html", COMPLETE_PLAN);
  write(dir, "zzz-healthy/plan.html", COMPLETE_PLAN);

  writeFileSync(join(dir, ".harness/aaa-broken/history"), "not a directory");

  const { exitCode } = go(dir);
  assert.equal(exitCode, 0);
  assert.deepEqual(historyOf(dir, "zzz-healthy"), ["index.md", "plan-v1.html"]);
  clean(dir);
});

test("an unreadable .harness never fails the turn", () => {
  const dir = sandbox();
  writeFileSync(join(dir, ".harness"), "not a directory");
  const { exitCode } = go(dir);
  assert.equal(exitCode, 0);
  clean(dir);
});

test("a review written straight into .harness is archived at the root", () => {
  const dir = sandbox();
  write(dir, "review.md", "# Review\n\nAPPROVE\n");
  go(dir);
  assert.deepEqual(historyOf(dir), ["index.md", "review-v1.md"]);
  clean(dir);
});

test("an uppercase REVIEW.md is never archived", () => {
  const dir = sandbox();
  write(dir, "REVIEW.md", "# Review\n\nAPPROVE\n");
  const { exitCode, stdout } = go(dir);
  assert.equal(exitCode, 0);
  assert.equal(stdout, "", "REVIEW.md was archived");
  assert.deepEqual(historyOf(dir), []);
  clean(dir);
});

test("directories holding no artifact are left alone", () => {
  const dir = sandbox();
  write(dir, "knowledge/lessons/a.md", "note");
  write(dir, "runtime/some-spec/dag.json", "{}");
  const { exitCode, stdout } = go(dir);
  assert.equal(exitCode, 0);
  assert.equal(stdout, "");
  clean(dir);
});

test("already-archived copies are never re-archived", () => {
  const dir = sandbox();
  write(dir, "add-search/verification/proof-report.html", FILLED_PROOF);
  go(dir);
  const { stdout } = go(dir);

  assert.equal(stdout, "", "the archived copy was picked up as a fresh artifact");
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "proof-report-v1"]);
  assert.deepEqual(
    readdirSync(join(dir, ".harness/add-search/history/proof-report-v1")),
    ["proof-report.html"],
    "the archived bundle grew a history of its own",
  );
  clean(dir);
});

test("a proof report is archived with the evidence beside it", () => {
  const dir = sandbox();
  write(dir, "add-search/verification/proof-report.html", FILLED_PROOF);
  write(dir, "add-search/verification/screenshots/01_checkout__01_open.png", "PNG");
  write(dir, "add-search/verification/01_checkout.mp4", "MP4");
  go(dir);

  const bundle = join(dir, ".harness/add-search/history/proof-report-v1");
  assert.equal(readFileSync(join(bundle, "proof-report.html"), "utf8"), FILLED_PROOF);
  assert.equal(readFileSync(join(bundle, "screenshots/01_checkout__01_open.png"), "utf8"), "PNG");
  assert.equal(readFileSync(join(bundle, "01_checkout.mp4"), "utf8"), "MP4");
  clean(dir);
});

test("a revised proof report gets its own evidence bundle", () => {
  const dir = sandbox();
  write(dir, "add-search/verification/proof-report.html", FILLED_PROOF);
  write(dir, "add-search/verification/screenshots/a.png", "first");
  go(dir);

  write(dir, "add-search/verification/proof-report.html", FILLED_PROOF.replace("Checkout flow", "Checkout flow v2"));
  write(dir, "add-search/verification/screenshots/a.png", "second");
  go(dir);

  const root = join(dir, ".harness/add-search/history");
  assert.equal(readFileSync(join(root, "proof-report-v1/screenshots/a.png"), "utf8"), "first");
  assert.equal(readFileSync(join(root, "proof-report-v2/screenshots/a.png"), "utf8"), "second");
  clean(dir);
});

test("running the script as a command archives and reports", () => {
  const dir = sandbox();
  write(dir, "add-search/plan.html", COMPLETE_PLAN);
  const stdout = execFileSync("node", [join(import.meta.dirname, "artifact-history.mjs")], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.match(stdout, /archived add-search\/history\/plan-v1\.html/);
  assert.deepEqual(historyOf(dir, "add-search"), ["index.md", "plan-v1.html"]);
  clean(dir);
});

test("nested specs under a shared parent folder version independently", () => {
  const dir = sandbox();
  write(dir, "features/learning-loop/design.md", "# Learning loop\n");
  write(dir, "features/fallow/design.md", "# Fallow\n");
  go(dir);

  assert.deepEqual(historyOf(dir, "features/learning-loop"), ["design-v1.md", "index.md"]);
  assert.deepEqual(historyOf(dir, "features/fallow"), ["design-v1.md", "index.md"]);
  assert.equal(indexOf(dir, "features/fallow"), "- design-v1.md — 2026-08-27 14:32 — 1 KB\n");
  assert.deepEqual(historyOf(dir, "features"), [], "unrelated specs were versioned as one document");
  clean(dir);
});

test("an artifact's subfolder does not become its spec root", () => {
  const dir = sandbox();
  write(dir, "add-search/plan.html", COMPLETE_PLAN);
  write(dir, "add-search/review/review.md", "# Review\n\nAPPROVE\n");
  write(dir, "add-search/verification/proof-report.html", FILLED_PROOF);
  go(dir);

  assert.deepEqual(historyOf(dir, "add-search"), [
    "index.md",
    "plan-v1.html",
    "proof-report-v1",
    "review-v1.md",
  ]);
  clean(dir);
});
