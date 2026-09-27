#!/usr/bin/env bun
// Test double for the claude binary: records its own launch, then echoes every line it reads
// back to $FAKE_AGENT_OUT as JSON, so a test can assert on what a real terminal sent it.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const out = process.env.FAKE_AGENT_OUT;
if (!out) throw new Error("FAKE_AGENT_OUT is not set");

const record = (data: unknown): void => {
  appendFileSync(out, `${JSON.stringify(data)}\n`);
};

record({
  argv: process.argv.slice(2),
  runId: process.env.HARNESS_RUN_ID ?? null,
  cwd: process.cwd(),
  env: process.env,
});

createInterface({ input: process.stdin }).on("line", (line) => record({ line }));
