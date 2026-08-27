#!/usr/bin/env node
// Stop-hook archivist. On every turn boundary it snapshots each harness review
// artifact that has changed since its last snapshot, so a later reader can diff
// the plan the agent first produced against the one the user approved.
//
// The turn boundary is the signal: mid-build writes never reach it, because the
// agent has not stopped yet. Each artifact carries its own completeness marker
// for the case where the agent stops mid-build anyway.

import { createHash } from "node:crypto";
import { copyFileSync, appendFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARTIFACTS = [
  {
    rel: "plan.html",
    stem: "plan",
    ext: ".html",
    // The shell pins a spinner to the end of the written content and drops the
    // comment only with the last section.
    isComplete: (text) => !text.includes("SLOT:content"),
  },
  {
    rel: join("review", "review.md"),
    stem: "review",
    ext: ".md",
    isComplete: (text) => text.trim().length > 0,
  },
  {
    rel: join("verification", "proof-report.html"),
    stem: "proof-report",
    ext: ".html",
    // The template ships this placeholder; filling the JSON island removes it.
    isComplete: (text) => !text.includes("<feature name>"),
  },
];

const hashOf = (text) => createHash("sha256").update(text).digest("hex");

const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const readState = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
};

const listSpecDirs = (harnessRoot) => {
  try {
    return readdirSync(harnessRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

const sizeLabel = (path) => `${Math.max(1, Math.round(statSync(path).size / 1024))} KB`;

const stamp = (now) => now.toISOString().slice(0, 16).replace("T", " ");

// A pending snapshot: the artifact changed since its last recorded hash.
const pendingFor = (specDir, state, artifact) => {
  const source = join(specDir, artifact.rel);
  const text = readText(source);
  if (text === null || !artifact.isComplete(text)) return null;

  const hash = hashOf(text);
  const prior = state[artifact.rel];
  if (prior?.hash === hash) return null;

  const version = (prior?.version ?? 0) + 1;
  return { source, hash, version, name: `${artifact.stem}-v${version}${artifact.ext}`, key: artifact.rel };
};

const archive = (specDir, historyDir, pending, now) => {
  const target = join(historyDir, pending.name);
  copyFileSync(pending.source, target);
  appendFileSync(
    join(historyDir, "index.md"),
    `- ${pending.name} — ${stamp(now)} — ${sizeLabel(target)}\n`,
  );
};

const snapshotSpec = (harnessRoot, spec, now, emit) => {
  const specDir = join(harnessRoot, spec);
  const historyDir = join(specDir, "history");
  const statePath = join(historyDir, ".state.json");
  const state = readState(statePath);

  const pending = ARTIFACTS.map((a) => pendingFor(specDir, state, a)).filter(Boolean);
  if (pending.length === 0) return;

  mkdirSync(historyDir, { recursive: true });
  for (const p of pending) {
    archive(specDir, historyDir, p, now);
    state[p.key] = { hash: p.hash, version: p.version };
    emit(`archived ${spec}/history/${p.name}\n`);
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
};

export const run = (argv = [], cwd = process.cwd(), now = new Date()) => {
  let stdout = "";
  const emit = (s) => {
    stdout += s;
  };
  const harnessRoot = join(cwd, ".harness");
  for (const spec of listSpecDirs(harnessRoot)) {
    try {
      snapshotSpec(harnessRoot, spec, now, emit);
    } catch {
      // Archiving is best-effort; it must never fail a turn.
    }
  }
  return { exitCode: 0, stdout };
};

const isMain = () => import.meta.url === `file://${process.argv[1]}`;

if (isMain()) {
  const { exitCode, stdout } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  process.exit(exitCode);
}
