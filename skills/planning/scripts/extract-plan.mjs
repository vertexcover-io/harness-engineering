#!/usr/bin/env node
// Extract the agent-facing markdown payloads embedded in plan.html.
// Usage: node extract-plan.mjs <path/to/plan.html> [out-dir]
// out-dir defaults to plan.html's own directory (the spec dir).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, normalize } from 'node:path';

const [, , htmlPath, outArg] = process.argv;
if (!htmlPath) {
  console.error('usage: extract-plan.mjs <plan.html> [out-dir]');
  process.exit(1);
}
const outDir = resolve(outArg ?? dirname(resolve(htmlPath)));
const html = readFileSync(htmlPath, 'utf8');

const rx = /<script type="text\/markdown" data-file="([^"]+)">([\s\S]*?)<\/script>/g;
let match;
let count = 0;
while ((match = rx.exec(html))) {
  const rel = normalize(match[1]);
  if (rel.startsWith('..') || rel.startsWith('/')) {
    console.error(`refused unsafe path: ${match[1]}`);
    process.exit(1);
  }
  const body = match[2].replace(/<\\\/script>/g, '</script>').replace(/^\n/, '').trimEnd();
  if (!body || body.startsWith('<!-- SLOT:')) {
    console.error(`payload for ${rel} is empty or an unfilled slot`);
    process.exit(1);
  }
  const target = join(outDir, rel);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body + '\n');
  console.log(`wrote ${target}`);
  count += 1;
}
if (count === 0) {
  console.error('no <script type="text/markdown" data-file> blocks found');
  process.exit(1);
}
console.log(`extracted ${count} file(s) to ${outDir}`);
