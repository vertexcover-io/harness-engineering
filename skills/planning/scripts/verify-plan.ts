#!/usr/bin/env node --experimental-strip-types
// Checks a written plan.html against its design index, its design spec, its own slot markers and
// its agent payloads.
// Usage: verify-plan.ts <path/to/plan.html>
// Prints one line per finding and exits 1; prints an "ok" line with the counts and exits 0 when
// clean. A missing argument or an unreadable plan.html is also exit 1.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Finding = {
  readonly check: "design" | "spec" | "slot" | "payload" | "diff";
  readonly message: string;
};

type Payload = {
  readonly file: string;
  readonly body: string;
};

const ROW_IMAGE = /[\w./-]+\.(?:png|jpe?g|webp|gif|svg)/;
// A component in design/spec.md is a level-2 heading; the title is level 1 and anything deeper
// belongs to the component above it. A step cites one as `spec: design/spec.md#<slug>`.
const SPEC_HEADING = /^##\s+(.+?)\s*$/;
const SPEC_CITATION = /spec:\s*design\/spec\.md#([\w-]+)/g;
const IMG_ATTR = /data-img="([^"]+)"/g;
const IMG_ENTRY = /^\s*["']([^"']+)["']\s*:/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// Anchored at column 0, and the same block inline-designs.ts rewrites: a payload's prose may
// mention `const IMG = {`, and an unanchored match would run from there into the engine.
const IMG_BLOCK = /(?:^\/\* SLOT:images[\s\S]*?\*\/\n)?^const IMG = \{[\s\S]*?^\};/m;
// Only a marker that OPENS a comment is a slot: the shell's engine quotes "SLOT:" in its own
// prose and in a live regex, and that text survives into every finished plan.
const SLOT_MARKER = /(?:<!--|\/\*)\s*SLOT:([\w-]+)/;
const SLOT_MARKERS = new RegExp(SLOT_MARKER, "g");
const PAYLOAD_BLOCK = /<script type="text\/markdown" data-file="([^"]+)">([\s\S]*?)<\/script>/g;
// Any <pre> whose class list holds "diff", whatever else the tag carries (an id, another class).
const DIFF_BLOCK = /<pre\b[^>]*\bclass="[^"]*\bdiff\b[^"]*"[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>/g;
// A unified-diff line opens with "+", "-", "@@" or a space (context); git also emits
// "\ No newline at end of file". The shell's engine colours by that first character, so any
// other opener is a line the reader sees uncoloured and wrong.
const DIFF_LINE = /^(?:[+\- \\]|@@|$)/;
// The frames a plan has actually built steps for live under #phases (the phase cards' .builds
// strips and the steps' media panels). The gallery at the top references every frame the moment
// the scout returns, so a whole-page scan could never find one unbuilt.
const PHASES_SECTION = /<section\b[^>]*\bid="phases"[^>]*>([\s\S]*?)<\/section>/;

const unique = <T>(values: readonly T[]): readonly T[] => [...new Set(values)];

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isFileIn(dir: string, name: string): boolean {
  try {
    return statSync(join(dir, name)).isFile();
  } catch {
    return false;
  }
}

// The shell's instruction comments carry example references ("x.png", "file.png"), so only markup
// outside them and outside the map names a real frame. inline-designs.ts imports this: one
// definition, or the writer and the checker disagree about what the page asked for.
export function referencedFrames(html: string): readonly string[] {
  const markup = html.replace(HTML_COMMENT, "").replace(IMG_BLOCK, "");
  const values = [...markup.matchAll(IMG_ATTR)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined);
  return unique(values);
}

function indexedFrames(indexPath: string): readonly string[] {
  const index = readText(indexPath);
  if (index === null) return [];
  const frames = index
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .map((line) => ROW_IMAGE.exec(line)?.[0])
    .filter((file): file is string => file !== undefined)
    .map((file) => basename(file));
  return unique(frames);
}

// Frames referenced inside #phases — what the plan has written a step for. Absent section: none.
export function builtFrames(html: string): readonly string[] {
  const phases = PHASES_SECTION.exec(html)?.[1];
  return phases === undefined ? [] : referencedFrames(phases);
}

function imgKeys(html: string): readonly string[] {
  // The same column-anchored block inline-designs.ts rewrites: a payload's prose may mention
  // `const IMG = {`, and payloads sit above the engine in the page.
  const block = IMG_BLOCK.exec(html)?.[0];
  if (block === undefined) return [];
  const keys = block
    .split("\n")
    .map((line) => IMG_ENTRY.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
  return unique(keys);
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The escape hatch is one documented form on one line: "design/<file> — not built: <reason>".
// Matching the filename and the words anywhere would let prose excuse a frame — "this panel is
// not built from 04-states.png directly" silences the check while meaning the opposite — and an
// empty reason skips a screen nobody has to justify. A hyphen passes for the dash: no gate should
// turn on punctuation.
const isExcused = (lines: readonly string[], file: string): boolean => {
  const form = new RegExp(String.raw`design/${escapeRegExp(file)}\s*[—-]\s*not built:\s*\S`, "i");
  return lines.some((line) => form.test(line));
};

// The slug GitHub gives a heading, so `## Template select` and `#template-select` name one thing.
const slug = (heading: string): string =>
  heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

function specHeadings(specPath: string): readonly string[] {
  const text = readText(specPath);
  if (text === null) return [];
  const headings = text
    .split("\n")
    .map((line) => SPEC_HEADING.exec(line)?.[1])
    .filter((heading): heading is string => heading !== undefined);
  return unique(headings);
}

// A citation counts only inside a phases/*.md payload: that file is what the coder reads, so a
// `spec:` line in plan.md or in page prose leaves the coder with nothing to build against.
function citedSlugs(html: string): readonly string[] {
  const steps = payloads(html)
    .filter(({ file }) => file.startsWith("phases/"))
    .map(({ body }) => body)
    .join("\n");
  const values = [...steps.matchAll(SPEC_CITATION)]
    .map((match) => match[1])
    .filter((value): value is string => value !== undefined)
    .map(slug);
  return unique(values);
}

// The same one-line escape hatch as a frame: "design/spec.md#<slug> — not built: <reason>".
const isSpecExcused = (lines: readonly string[], headingSlug: string): boolean => {
  const form = new RegExp(String.raw`design/spec\.md#${escapeRegExp(headingSlug)}\s*[—-]\s*not built:\s*\S`, "i");
  return lines.some((line) => form.test(line));
};

function specFindings(html: string, designDir: string): readonly Finding[] {
  const specPath = join(designDir, "spec.md");
  if (!existsSync(specPath)) return [];

  const cited = citedSlugs(html);
  const lines = html.split("\n");

  return specHeadings(specPath)
    .map((heading) => ({ heading, headingSlug: slug(heading) }))
    .filter(({ headingSlug }) => !cited.includes(headingSlug))
    .filter(({ headingSlug }) => !isSpecExcused(lines, headingSlug))
    .map(({ heading, headingSlug }): Finding => ({
      check: "spec",
      message: `"${heading}" is a heading in design/spec.md but no step cites it — add "spec: design/spec.md#${headingSlug}" to the step that builds it, or record "design/spec.md#${headingSlug} — not built: reason"`,
    }));
}

function designFindings(html: string, designDir: string): readonly Finding[] {
  if (!existsSync(join(designDir, "INDEX.md"))) return [];

  const referenced = referencedFrames(html);
  const built = builtFrames(html);
  const keys = imgKeys(html);
  const lines = html.split("\n");

  const unembedded = indexedFrames(join(designDir, "INDEX.md"))
    .filter((file) => !built.includes(file))
    .filter((file) => !isExcused(lines, file))
    .map((file): Finding => ({
      check: "design",
      message: `${file} is in design/INDEX.md but no phase builds to it — embed it under #phases, or record "design/${file} — not built: reason"`,
    }));

  const blank = referenced
    .filter((file) => !keys.includes(file))
    .map((file): Finding => ({
      check: "design",
      message: `data-img="${file}" has no IMG entry — the panel would render blank`,
    }));

  const stray = keys
    .filter((key) => !isFileIn(designDir, key))
    .map((key): Finding => ({
      check: "design",
      message: `IMG key ${key} is not a file in ${designDir}`,
    }));

  return [...unembedded, ...blank, ...stray];
}

function slotFindings(html: string): readonly Finding[] {
  return [...html.matchAll(SLOT_MARKERS)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
    .map((name): Finding => ({ check: "slot", message: `unfilled slot SLOT:${name} is still in the page` }));
}

function payloads(html: string): readonly Payload[] {
  return [...html.matchAll(PAYLOAD_BLOCK)].map((match) => ({
    file: match[1] ?? "",
    body: (match[2] ?? "").replace(/^\n/, "").trimEnd(),
  }));
}

function payloadFindings(blocks: readonly Payload[]): readonly Finding[] {
  if (blocks.length === 0) {
    return [{ check: "payload", message: 'no <script type="text/markdown" data-file> blocks found' }];
  }

  const missingPlan: readonly Finding[] = blocks.some((block) => block.file === "plan.md")
    ? []
    : [{ check: "payload", message: "no payload block for plan.md" }];

  const unwritten = blocks
    .filter((block) => block.body === "" || SLOT_MARKER.test(block.body))
    .map((block): Finding => ({
      check: "payload",
      message: `payload for ${block.file} is empty or still an unfilled slot`,
    }));

  return [...missingPlan, ...unwritten];
}

function diffFindings(html: string): readonly Finding[] {
  return [...html.matchAll(DIFF_BLOCK)].flatMap((match, index) => {
    const body = (match[1] ?? "").replace(/^\n/, "").trimEnd();
    if (body === "") {
      return [{ check: "diff" as const, message: `pre.diff block ${index + 1} is empty` }];
    }
    const bad = body.split("\n").find((line) => !DIFF_LINE.test(line));
    return bad === undefined
      ? []
      : [
          {
            check: "diff" as const,
            message: `pre.diff block ${index + 1} has a line that opens with neither "+", "-", "@@" nor a space: ${bad.slice(0, 60)}`,
          },
        ];
  });
}

export function verifyPlan(htmlPath: string): readonly Finding[] {
  // An unreadable page reads as empty so the payload check fails it, never passes it.
  const html = readText(htmlPath) ?? "";
  const designDir = join(dirname(resolve(htmlPath)), "design");
  return [
    ...designFindings(html, designDir),
    ...specFindings(html, designDir),
    ...slotFindings(html),
    ...payloadFindings(payloads(html)),
    ...diffFindings(html),
  ];
}

function run(htmlPath: string | undefined): number {
  if (htmlPath === undefined) {
    console.error("usage: verify-plan.ts <path/to/plan.html>");
    return 1;
  }

  const html = readText(htmlPath);
  if (html === null) {
    console.error(`cannot read ${htmlPath}`);
    return 1;
  }

  const findings = verifyPlan(htmlPath);
  if (findings.length > 0) {
    for (const finding of findings) console.error(`${finding.check}: ${finding.message}`);
    return 1;
  }

  console.log(
    `ok — ${referencedFrames(html).length} frame(s) embedded, ${payloads(html).length} payload block(s)`,
  );
  return 0;
}

const invokedScript = (): string => {
  const argv1 = resolve(process.argv[1] ?? "");
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
};

if (fileURLToPath(import.meta.url) === invokedScript()) {
  process.exit(run(process.argv[2]));
}
