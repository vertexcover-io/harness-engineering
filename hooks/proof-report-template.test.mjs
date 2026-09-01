import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const TEMPLATE = readFileSync(
  join(REPO, "skills/functional-verify/references/proof-report-template.html"),
  "utf8",
);

const island = () => {
  const m = TEMPLATE.match(
    /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/,
  );
  assert.ok(m, "the template carries a report-data island");
  return JSON.parse(m[1]);
};

// A report whose island does not parse renders as a blank page, and the skill
// only finds out by opening it. This is the cheapest place to catch that.
test("the scaffold island parses", () => {
  assert.ok(island().scenarios.length > 0);
});

test("every scaffold url is a bare path, never a host", () => {
  const d = island();
  const urls = [
    ...d.scenarios.map((s) => s.url),
    ...d.scenarios.flatMap((s) => (s.steps ?? []).map((x) => x.url)),
  ].filter(Boolean);

  assert.ok(urls.length > 0, "the scaffold demonstrates the url field");
  for (const u of urls) {
    assert.equal(typeof u, "string", `url is a string, got ${typeof u}`);
    assert.doesNotMatch(u, /^[a-z]+:\/\//i, `${u} carries a host`);
  }
});

test("the base URL has a home in fields[]", () => {
  assert.ok(island().fields.some((f) => /base url/i.test(f.label)));
});

// The renderer reads s.url and step.url; a header comment that documents other
// key names is how an author ends up writing undefined into the deliverable.
test("the renderer and the scaffold agree on the key name", () => {
  assert.match(TEMPLATE, /pathChip\('path', s\.url\)/);
  assert.match(TEMPLATE, /pathChip\('step__u', step\.url\)/);
  assert.doesNotMatch(TEMPLATE, /\{path,label\}/);
});
