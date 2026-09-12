#!/usr/bin/env node --experimental-strip-types
// Inlines a plan page's design frames: every <img data-img="file.png"> gets its bytes
// base64-encoded into the page's own IMG map, so plan.html stays one self-contained file
// that makes no external request.
// Usage: inline-designs.ts <path/to/plan.html>
// Frames are read from <plan.html's dir>/design/. Exits 1 on a missing argument, an
// unreadable page, or any referenced frame with no file; 0 otherwise — a page with no
// data-img is a no-op, not a failure. Idempotent: the map is regenerated from the page's
// references each run, so a second run rewrites byte-identical output.

import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// One definition of what the page asked for, shared with the checker that enforces it.
import { referencedFrames } from "./verify-plan.ts";

export type InlineResult = {
  readonly inlined: readonly string[];
  readonly missing: readonly string[];
};

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

// The comment is optional: only the first run still has it to strip.
const IMG_BLOCK = /(?:^\/\* SLOT:images[\s\S]*?\*\/\n)?^const IMG = \{[\s\S]*?^\};/m;

const mimeFor = (file: string): string =>
  MIME_BY_EXT[extname(file).toLowerCase()] ?? "application/octet-stream";

function frameEntry(frameDir: string, file: string): string | null {
  try {
    const bytes = readFileSync(join(frameDir, file));
    return `  "${file}": "data:${mimeFor(file)};base64,${bytes.toString("base64")}",`;
  } catch {
    return null;
  }
}

export function inlineDesigns(htmlPath: string): InlineResult {
  const page = resolve(htmlPath);
  const html = readFileSync(page, "utf8");
  const frames = referencedFrames(html);
  // A page with no map and no frames is not a plan page; one with a map is regenerated even when
  // empty, because leaving the SLOT comment behind is an unfilled slot to the verifier.
  if (!IMG_BLOCK.test(html)) {
    if (frames.length === 0) return { inlined: [], missing: [] };
    throw new Error(`no "const IMG = {" map found in ${page}`);
  }

  const frameDir = join(dirname(page), "design");
  const inlined: string[] = [];
  const missing: string[] = [];
  const lines: string[] = [];
  for (const file of frames) {
    const entry = frameEntry(frameDir, file);
    if (entry === null) {
      missing.push(file);
      continue;
    }
    inlined.push(file);
    lines.push(entry);
  }

  const map = ["const IMG = {", ...lines, "};"].join("\n");
  writeFileSync(page, html.replace(IMG_BLOCK, () => map));
  return { inlined, missing };
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
  const htmlPath = process.argv[2];
  if (!htmlPath) {
    console.error("usage: inline-designs.ts <path/to/plan.html>");
    process.exit(1);
  }

  let result: InlineResult;
  try {
    result = inlineDesigns(htmlPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (result.inlined.length === 0 && result.missing.length === 0) {
    console.log(`no <img data-img> on the page — the IMG map is now empty`);
    process.exit(0);
  }

  for (const file of result.missing) {
    console.error(`missing frame: design/${file}`);
  }
  if (result.missing.length > 0) process.exit(1);

  const bytes = statSync(resolve(htmlPath)).size;
  console.log(
    `inlined ${result.inlined.length} frame(s) · ${resolve(htmlPath)} is now ${bytes} bytes`,
  );
}
