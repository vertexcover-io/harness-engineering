#!/usr/bin/env -S bun --env-file=/dev/null
// Test double for the claude binary: records its own launch, then echoes every line it reads
// back to $FAKE_AGENT_OUT as JSON, so a test can assert on what a real terminal sent it.
// --env-file=/dev/null: Bun would load the repo's .env itself, hiding what the yok passed.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { VERSION } from "@yok/sdk/internal";

// A compiled yok's plugin check asks for the installed plugins; this one matches the binary.
if (process.argv[2] === "plugin") {
  console.log(JSON.stringify([{ id: "yok@yok", version: VERSION, scope: "user", enabled: true }]));
  process.exit(0);
}

const out = process.env.FAKE_AGENT_OUT;
if (!out) throw new Error("FAKE_AGENT_OUT is not set");

const record = (data: unknown): void => {
  appendFileSync(out, `${JSON.stringify(data)}\n`);
};

record({
  argv: process.argv.slice(2),
  runId: process.env.YOK_RUN_ID ?? null,
  cwd: process.cwd(),
  env: process.env,
});

createInterface({ input: process.stdin }).on("line", (line) => record({ line }));
