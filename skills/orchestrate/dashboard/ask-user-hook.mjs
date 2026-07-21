#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { notify } from "../../../hooks/_lib/notify.mjs";
import { run as dagRun } from "./dag-update.mjs";

const BREADCRUMB = join(tmpdir(), ".claude-harness-active");

const findLastNodeWithStatus = (nodes, status) => {
  const entries = Object.entries(nodes || {});
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i][1]?.status === status) return entries[i];
  }
  return null;
};

const setStatus = async (harnessDir, nodeId, status) => {
  const prev = process.env.HARNESS_DIR;
  process.env.HARNESS_DIR = harnessDir;
  try {
    await dagRun(["set-status", nodeId, status]);
  } finally {
    if (prev === undefined) delete process.env.HARNESS_DIR;
    else process.env.HARNESS_DIR = prev;
  }
};

export const run = async (argv = []) => {
  const action = argv[0] || "pre";
  if (!existsSync(BREADCRUMB)) return { exitCode: 0 };

  const harnessDir = readFileSync(BREADCRUMB, "utf8").trim();
  if (!existsSync(harnessDir)) return { exitCode: 0 };

  const dagFile = join(harnessDir, "dag.json");
  if (!existsSync(dagFile)) return { exitCode: 0 };

  let dag;
  try {
    dag = JSON.parse(readFileSync(dagFile, "utf8"));
  } catch {
    return { exitCode: 0 };
  }

  if (action === "pre") {
    const found = findLastNodeWithStatus(dag.nodes, "running");
    if (found) {
      const [nodeId, node] = found;
      await setStatus(harnessDir, nodeId, "waiting");
      await notify("Pipeline: Input Required", `${node.label || nodeId} is waiting for your response`);
    }
    return { exitCode: 0 };
  }

  if (action === "post") {
    const found = findLastNodeWithStatus(dag.nodes, "waiting");
    if (found) await setStatus(harnessDir, found[0], "running");
    return { exitCode: 0 };
  }

  return { exitCode: 0 };
};

const isMain = () => import.meta.url === `file://${process.argv[1]}`;

if (isMain()) {
  const { exitCode } = await run(process.argv.slice(2));
  process.exit(exitCode);
}
