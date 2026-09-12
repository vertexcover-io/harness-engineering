#!/usr/bin/env node --experimental-strip-types
// Checks a written plan.html against its design index, its own slot markers and its agent payloads.
// Usage: verify-plan.ts <path/to/plan.html>
// Prints one line per finding and exits 1; prints an "ok" line with the counts and exits 0 when
// clean. A missing argument or an unreadable plan.html is also exit 1.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Finding = {
  readonly check: "design" | "slot" | "payload";
  readonly message: string;
};

type Payload = {
  readonly file: string;
  readonly body: string;
};

const ROW_IMAGE = /[\w./-]+\.(?:png|jpe?g|webp|gif|svg)/;
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

function imgKeys(html: string): readonly string[] {
  const start = html.indexOf("const IMG = {");
  if (start < 0) return [];
  const end = html.indexOf("\n};", start);
  const keys = html
    .slice(start, end < 0 ? html.length : end)
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

function designFindings(html: string, designDir: string): readonly Finding[] {
  if (!existsSync(join(designDir, "INDEX.md"))) return [];

  const referenced = referencedFrames(html);
  const keys = imgKeys(html);
  const lines = html.split("\n");

  const unembedded = indexedFrames(join(designDir, "INDEX.md"))
    .filter((file) => !referenced.includes(file))
    .filter((file) => !isExcused(lines, file))
    .map((file): Finding => ({
      check: "design",
      message: `${file} is in design/INDEX.md but no step embeds it — embed it, or record "design/${file} — not built: reason"`,
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

export function verifyPlan(htmlPath: string): readonly Finding[] {
  // An unreadable page reads as empty so the payload check fails it, never passes it.
  const html = readText(htmlPath) ?? "";
  const designDir = join(dirname(resolve(htmlPath)), "design");
  return [...designFindings(html, designDir), ...slotFindings(html), ...payloadFindings(payloads(html))];
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
