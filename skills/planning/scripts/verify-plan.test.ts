import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Finding, referencedFrames, verifyPlan } from "./verify-plan.ts";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

type PlanParts = {
  readonly steps?: string;
  readonly img?: string;
  readonly payloads?: string;
  readonly slots?: string;
};

/** A plan.html with only the parts these checks read, including the engine text that mentions SLOT. */
const planHtml = ({ steps = "", img = "", payloads, slots = "" }: PlanParts): string => `<!doctype html>
<title>Plan</title>
<main>
${slots}
<section id="phases">${steps}</section>
</main>
${
  payloads ??
  `<script type="text/markdown" data-file="plan.md">
# Plan
</script>
<script type="text/markdown" data-file="phases/phase-1.md">
## Implementation
1. **Do it**
</script>`
}
<script>
const IMG = {
${img}
};
/* ---- engine: loaders while the page is still being written ----
   Any SLOT: comment left in the body renders as a spinner. */
if (/^\\s*SLOT:/.test(node.nodeValue)) pendingSlots.push(node);
/* ---- engine: auto-link internal ids ----
   SLOT:xref-regex — extend the alternation to match this feature's id families. */
</script>`;

const framePanel = (file: string): string =>
  `<details class="media"><summary>Design — x</summary><div class="d-body"><img data-img="${file}" alt="x"></div></details>`;

type SpecParts = {
  readonly html: string;
  readonly index?: string;
  readonly designFiles?: readonly string[];
};

const spec = ({ html, index, designFiles = [] }: SpecParts): string => {
  const dir = mkdtempSync(join(tmpdir(), "verify-plan-"));
  writeFileSync(join(dir, "plan.html"), html);
  if (index !== undefined) {
    mkdirSync(join(dir, "design"), { recursive: true });
    writeFileSync(join(dir, "design", "INDEX.md"), index);
  }
  for (const file of designFiles) {
    mkdirSync(join(dir, "design"), { recursive: true });
    writeFileSync(join(dir, "design", file), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
  return join(dir, "plan.html");
};

const INDEX_ONE = `| Screen | Local file | Source | Source of truth for |
|---|---|---|---|
| Drawer states | [04-states.png](04-states.png) | Asana | state order, copy |
`;

test("a plan that embeds every indexed frame has no findings", () => {
  const plan = spec({
    html: planHtml({ steps: framePanel("04-states.png"), img: `  "04-states.png": "data:image/png;base64,iVBO",` }),
    index: INDEX_ONE,
    designFiles: ["04-states.png"],
  });

  assert.deepEqual(verifyPlan(plan), []);
});

test("an indexed frame that no step embeds is a finding naming the file", () => {
  const plan = spec({ html: planHtml({}), index: INDEX_ONE, designFiles: ["04-states.png"] });

  const findings = verifyPlan(plan);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, "design");
  assert.match(findings[0]?.message ?? "", /04-states\.png/);
});

test("an indexed frame recorded as not built is accounted for", () => {
  const payloads = `<script type="text/markdown" data-file="plan.md">
## Design References

design/04-states.png — not built: the six-state panel ships in REF-25061
</script>`;
  const plan = spec({ html: planHtml({ payloads }), index: INDEX_ONE, designFiles: ["04-states.png"] });

  assert.deepEqual(verifyPlan(plan), []);
});

test("a data-img with no IMG entry is a finding — the panel would render blank", () => {
  const plan = spec({
    html: planHtml({ steps: framePanel("04-states.png") }),
    index: INDEX_ONE,
    designFiles: ["04-states.png"],
  });

  const findings = verifyPlan(plan);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? "", /IMG/);
});

test("an IMG key that is not a file in design\\/ is a finding", () => {
  const plan = spec({
    html: planHtml({
      steps: framePanel("04-states.png"),
      img: `  "04-states.png": "data:image/png;base64,iVBO",\n  "ghost.png": "data:image/png;base64,iVBO",`,
    }),
    index: INDEX_ONE,
    designFiles: ["04-states.png"],
  });

  const findings = verifyPlan(plan);
  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? "", /ghost\.png/);
});

test("no design index means the design checks stay silent", () => {
  assert.deepEqual(verifyPlan(spec({ html: planHtml({}) })), []);
});

test("an unfilled slot is a finding, and the engine's own SLOT text is not", () => {
  const plan = spec({ html: planHtml({ slots: "<!-- SLOT:content — the sections, in this order -->" }) });

  const findings = verifyPlan(plan);
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, "slot");
  assert.match(findings[0]?.message ?? "", /content/);
});

test("a missing plan.md payload block is a finding", () => {
  const payloads = `<script type="text/markdown" data-file="phases/phase-1.md">
## Implementation
1. **Do it**
</script>`;
  const findings = verifyPlan(spec({ html: planHtml({ payloads }) }));

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, "payload");
  assert.match(findings[0]?.message ?? "", /plan\.md/);
});

test("a payload block still holding its slot is a finding", () => {
  const payloads = `<script type="text/markdown" data-file="plan.md">
<!-- SLOT:plan-md — full plan.md per references/plan-sections.md -->
</script>`;
  const findings = verifyPlan(spec({ html: planHtml({ payloads }) }));

  assert.ok(findings.some((f) => f.check === "payload" && /plan\.md/.test(f.message)));
});

test("a page with no payload blocks at all is a finding", () => {
  const findings = verifyPlan(spec({ html: planHtml({ payloads: "" }) }));

  assert.ok(findings.some((f) => f.check === "payload"));
});

test("referencedFrames reads every data-img on the page, once each", () => {
  const html = planHtml({ steps: framePanel("a.png") + framePanel("b.png") + framePanel("a.png") });

  assert.deepEqual([...referencedFrames(html)].toSorted(), ["a.png", "b.png"]);
});

const shell = (): string => readFileSync(join(SELF_DIR, "plan-shell.html"), "utf8");

test("the shell's instruction comments hold example references, and none of them is a frame", () => {
  assert.deepEqual(referencedFrames(shell()), []);
});

test("a half-built page reports the unembedded frame and invents none from the shell's examples", () => {
  const plan = spec({ html: shell(), index: INDEX_ONE, designFiles: ["04-states.png"] });

  const design = verifyPlan(plan).filter((finding) => finding.check === "design");
  assert.equal(design.length, 1);
  assert.match(design[0]?.message ?? "", /04-states\.png/);
});

const run = (planPath: string): { readonly status: number | null; readonly out: string } => {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SELF_DIR, "verify-plan.ts"), planPath],
    { encoding: "utf8" },
  );
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

test("the CLI exits 0 and says ok on a clean plan", () => {
  const plan = spec({
    html: planHtml({ steps: framePanel("04-states.png"), img: `  "04-states.png": "data:image/png;base64,iVBO",` }),
    index: INDEX_ONE,
    designFiles: ["04-states.png"],
  });

  const { status, out } = run(plan);
  assert.equal(status, 0);
  assert.match(out, /ok/);
});

test("the CLI exits 1 and prints each finding", () => {
  const plan = spec({ html: planHtml({}), index: INDEX_ONE, designFiles: ["04-states.png"] });

  const { status, out } = run(plan);
  assert.equal(status, 1);
  assert.match(out, /04-states\.png/);
});

test("the CLI exits 1 when the file is missing", () => {
  assert.equal(run(join(tmpdir(), "does-not-exist-plan.html")).status, 1);
});


const excusedBy = (note: string): readonly Finding[] => {
  const payloads = `<script type="text/markdown" data-file="plan.md">
## Design References

${note}
</script>`;
  return verifyPlan(spec({ html: planHtml({ payloads }), index: INDEX_ONE, designFiles: ["04-states.png"] }));
};

test("the documented not-built form excuses a frame no step embeds", () => {
  assert.deepEqual(excusedBy("design/04-states.png — not built: the six-state panel ships in REF-25061"), []);
});

test("a hyphen instead of an em dash still excuses it — nobody should fail on punctuation", () => {
  assert.deepEqual(excusedBy("design/04-states.png - not built: ships in REF-25061"), []);
});

test("prose that merely mentions the file and the words does not excuse it", () => {
  const findings = excusedBy("this panel is not built from 04-states.png directly");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.check, "design");
});

test("the form without a reason does not excuse it", () => {
  assert.equal(excusedBy("design/04-states.png — not built:").length, 1);
});

test("a casual note does not excuse it", () => {
  assert.equal(excusedBy("04-states.png is not built yet").length, 1);
});

test("the filename is matched literally, not as a pattern", () => {
  assert.equal(excusedBy("design/04-statesXpng — not built: a different file entirely").length, 1);
});
