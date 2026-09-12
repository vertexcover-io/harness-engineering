import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { inlineDesigns } from "./inline-designs.ts";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(SELF_DIR, "inline-designs.ts");

const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452deadbeef", "hex");
const SVG_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', "utf8");

const PAYLOAD = `# Plan

A step may mention \`const IMG = {\` in prose, and even a stray };
without the inliner eating this payload.
`;

const ENGINE = `document.querySelectorAll('img[data-img]').forEach((el) => {
  const src = IMG[el.dataset.img];
  if (src) { el.src = src; }
});`;

const shell = (frames: readonly string[]): string => `<!doctype html>
<html><body>
<main>
  <!-- SLOT:content — a design panel is <img data-img="x.png" alt="…"> -->
${frames.map((f) => `  <details class="media"><summary>Design</summary><div class="d-body"><img data-img="${f}" alt="${f}"><div class="cap">${f}</div></div></details>`).join("\n")}
</main>

<script type="text/markdown" data-file="plan.md">
${PAYLOAD}</script>

<script>
/* SLOT:xrefs — every internal id used anywhere on the page. */
const X = {
};

/* SLOT:images — every design/mockup the steps embed, as "file.png": "data:image/png;base64,…".
   Each file appears ONCE here however many steps use it; the engine wires it to every
   <img data-img="file.png">. Omit the entry and that img stays blank — no other breakage. */
const IMG = {
};

${ENGINE}
</script>
</body></html>
`;

type Frames = Readonly<Record<string, Buffer>>;

function sandbox(html: string, frames: Frames = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "inline-designs-"));
  mkdirSync(join(dir, "design"), { recursive: true });
  for (const [name, bytes] of Object.entries(frames)) {
    writeFileSync(join(dir, "design", name), bytes);
  }
  const htmlPath = join(dir, "plan.html");
  writeFileSync(htmlPath, html);
  return htmlPath;
}

type Run = { readonly status: number; readonly stdout: string; readonly stderr: string };

const runCli = (...args: readonly string[]): Run => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const read = (p: string): string => readFileSync(p, "utf8");

test("SC1: every referenced frame lands in IMG as a data: URI", () => {
  const htmlPath = sandbox(shell(["one.png", "two.png"]), {
    "one.png": PNG_BYTES,
    "two.png": PNG_BYTES,
  });

  const result = inlineDesigns(htmlPath);

  assert.deepEqual([...result.inlined].toSorted(), ["one.png", "two.png"]);
  assert.deepEqual(result.missing, []);
  const out = read(htmlPath);
  assert.match(out, /"one\.png": "data:image\/png;base64,iVBORw0KGgoAAAANSUhEUt6tvu8="/);
  assert.match(out, /"two\.png": "data:image\/png;base64,/);
});

test("SC1: the SLOT:images instruction comment is gone once the map is filled", () => {
  const htmlPath = sandbox(shell(["one.png"]), { "one.png": PNG_BYTES });

  inlineDesigns(htmlPath);

  const out = read(htmlPath);
  assert.equal(out.includes("SLOT:images"), false);
  assert.match(out, /^const IMG = \{$/m);
  assert.match(out, /\/\* SLOT:xrefs/);
});

test("SC2: a second run rewrites the file byte-identically", () => {
  const htmlPath = sandbox(shell(["one.png", "two.png"]), {
    "one.png": PNG_BYTES,
    "two.png": SVG_BYTES,
  });

  inlineDesigns(htmlPath);
  const first = read(htmlPath);
  const second = inlineDesigns(htmlPath);

  assert.equal(read(htmlPath), first);
  assert.deepEqual([...second.inlined].toSorted(), ["one.png", "two.png"]);
});

test("SC3: a frame with no file is reported missing and left out of the map", () => {
  const htmlPath = sandbox(shell(["here.png", "gone.png"]), { "here.png": PNG_BYTES });

  const result = inlineDesigns(htmlPath);

  assert.deepEqual(result.inlined, ["here.png"]);
  assert.deepEqual(result.missing, ["gone.png"]);
  const out = read(htmlPath);
  assert.match(out, /"here\.png": "data:image\/png/);
  assert.equal(out.includes('"gone.png":'), false);
});

test("SC3: the CLI exits 1 and names every missing frame", () => {
  const htmlPath = sandbox(shell(["here.png", "gone.png"]), { "here.png": PNG_BYTES });

  const run = runCli(htmlPath);

  assert.equal(run.status, 1);
  assert.match(run.stderr, /gone\.png/);
  assert.equal(run.stderr.includes("here.png"), false);
});

test("SC4: a page with no data-img empties the map and the CLI exits 0", () => {
  const htmlPath = sandbox(shell([]));

  const result = inlineDesigns(htmlPath);
  assert.deepEqual(result, { inlined: [], missing: [] });
  // The map is emptied rather than left alone: an untouched SLOT:images comment is an unfilled
  // slot to verify-plan, so an API-only plan could never pass its own gate.
  assert.equal(read(htmlPath).includes("SLOT:images"), false);
  assert.match(read(htmlPath), /const IMG = \{\n\};/);

  const afterFirst = read(htmlPath);
  const run = runCli(htmlPath);
  assert.equal(run.status, 0);
  assert.match(run.stdout, /IMG map is now empty/);
  assert.equal(read(htmlPath), afterFirst);
});

test("SC4: the untouched plan shell has nothing to inline — its data-img are comments", () => {
  const htmlPath = sandbox(read(join(SELF_DIR, "plan-shell.html")));
  const before = read(htmlPath);

  assert.deepEqual(inlineDesigns(htmlPath), { inlined: [], missing: [] });
  // The shell's own instruction comments name x.png and file.png; neither is a frame.
  assert.equal(read(htmlPath).replace(/const IMG = \{\n\};/, ""), before.replace(/\/\* SLOT:images[\s\S]*?\*\/\n?const IMG = \{\n\};/, ""));
  assert.equal(read(htmlPath).includes("SLOT:images"), false);
});

test("SC5: the engine and the markdown payloads come out untouched", () => {
  const htmlPath = sandbox(shell(["one.png"]), { "one.png": PNG_BYTES });

  inlineDesigns(htmlPath);

  const out = read(htmlPath);
  assert.ok(out.includes(ENGINE));
  assert.ok(out.includes(PAYLOAD));
  assert.match(out, /const X = \{\n\};/);
  assert.match(out, /<img data-img="one\.png" alt="one\.png">/);
});

test("SC6: an svg frame carries the image/svg\\+xml mime", () => {
  const htmlPath = sandbox(shell(["flow.svg", "shot.jpg"]), {
    "flow.svg": SVG_BYTES,
    "shot.jpg": PNG_BYTES,
  });

  inlineDesigns(htmlPath);

  const out = read(htmlPath);
  assert.match(out, /"flow\.svg": "data:image\/svg\+xml;base64,/);
  assert.match(out, /"shot\.jpg": "data:image\/jpeg;base64,/);
});

test("CLI: no argument prints usage and exits 1", () => {
  const run = runCli();

  assert.equal(run.status, 1);
  assert.match(run.stderr, /usage: inline-designs\.ts/);
});

test("CLI: an unreadable page exits 1", () => {
  const run = runCli(join(mkdtempSync(join(tmpdir(), "inline-designs-")), "absent.html"));

  assert.equal(run.status, 1);
  assert.match(run.stderr, /absent\.html/);
});

test("CLI: a successful run reports the frame count and the file size", () => {
  const htmlPath = sandbox(shell(["one.png"]), { "one.png": PNG_BYTES });

  const run = runCli(htmlPath);

  assert.equal(run.status, 0);
  assert.match(run.stdout, /inlined 1 frame/);
  assert.match(run.stdout, /\d+ bytes|\d+(\.\d+)? KB/);
});


test("a plan with no frames still loses its SLOT:images marker, so the verifier can pass it", () => {
  const dir = mkdtempSync(join(tmpdir(), "inline-none-"));
  const page = join(dir, "plan.html");
  writeFileSync(page, shell([]));

  const result = inlineDesigns(page);
  const after = readFileSync(page, "utf8");

  assert.deepEqual(result, { inlined: [], missing: [] });
  assert.ok(!/SLOT:images/.test(after), "the slot marker must be gone — verify-plan reports it as unfilled");
  assert.match(after, /const IMG = \{\n\};/, "an empty map, not a removed one — the engine reads IMG");
});

test("an API-only plan is byte-identical on a second inliner run", () => {
  const dir = mkdtempSync(join(tmpdir(), "inline-none-idem-"));
  const page = join(dir, "plan.html");
  writeFileSync(page, shell([]));

  inlineDesigns(page);
  const once = readFileSync(page, "utf8");
  inlineDesigns(page);

  assert.equal(readFileSync(page, "utf8"), once);
});

test("a plan with no frames keeps its payload and engine untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "inline-none-keep-"));
  const page = join(dir, "plan.html");
  writeFileSync(page, shell([]));

  inlineDesigns(page);
  const after = readFileSync(page, "utf8");

  assert.ok(after.includes(PAYLOAD), "the markdown payload must survive");
  assert.ok(after.includes(ENGINE), "the engine must survive");
});
