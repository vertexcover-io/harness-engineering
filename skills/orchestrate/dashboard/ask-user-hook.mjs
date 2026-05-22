#!/usr/bin/env node
// Pre/Post AskUserQuestion hook. Port of ask-user-hook.sh.
// Pre  → set the running node to "waiting" + desktop notification.
// Post → flip the waiting node back to "running".

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { notify } from "../../../hooks/_lib/notify.mjs";

const BREADCRUMB = join(tmpdir(), ".claude-harness-active");
const action = process.argv[2] || "pre";

if (!existsSync(BREADCRUMB)) process.exit(0);
const harnessDir = readFileSync(BREADCRUMB, "utf8").trim();
if (!existsSync(harnessDir)) process.exit(0);

const dagFile = join(harnessDir, "dag.json");
if (!existsSync(dagFile)) process.exit(0);

let dag;
try { dag = JSON.parse(readFileSync(dagFile, "utf8")); } catch { process.exit(0); }

const findLastNodeWithStatus = (status) => {
  const entries = Object.entries(dag.nodes || {});
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i][1]?.status === status) return entries[i];
  }
  return null;
};

const dagUpdate = join(dirname(fileURLToPath(import.meta.url)), "dag-update.mjs");
const setStatus = (nodeId, status) => {
  spawnSync(process.execPath, [dagUpdate, "set-status", nodeId, status], {
    env: { ...process.env, HARNESS_DIR: harnessDir },
    stdio: "inherit",
  });
};

if (action === "pre") {
  const found = findLastNodeWithStatus("running");
  if (found) {
    const [nodeId, node] = found;
    setStatus(nodeId, "waiting");
    await notify("Pipeline: Input Required", `${node.label || nodeId} is waiting for your response`);
  }
} else if (action === "post") {
  const found = findLastNodeWithStatus("waiting");
  if (found) setStatus(found[0], "running");
}
