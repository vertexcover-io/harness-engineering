#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, globSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";
import { readJsonSyncOr, withDirLockSync, writeJsonAtomicSync } from "./_lib/io.mjs";

const HISTORY = "history";

const nonEmpty = (text) => text.trim().length > 0;

export const ARTIFACTS = [
  {
    file: "plan.html",
    // plan-shell.html keeps this marker until its last section is written.
    isComplete: (text) => !text.includes("SLOT:content"),
  },
  { file: "design.md", isComplete: nonEmpty },
  { file: "review.md", dir: "review", isComplete: nonEmpty },
  {
    file: "proof-report.html",
    dir: "verification",
    // The report links its evidence report-relative, so the folder travels with it.
    // proof-report-template.html ships this title until the JSON island is filled.
    isComplete: (text) => !text.includes("<feature name>"),
    bundle: true,
  },
];

const hashOf = (text) => createHash("sha256").update(text).digest("hex");

const stemOf = (file) => basename(file, extname(file));

const stamp = (now) => now.toISOString().slice(0, 16).replace("T", " ");

const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const safeReaddir = (path) => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

const bytesOf = (path) => {
  const info = statSync(path);
  if (!info.isDirectory()) return info.size;
  return safeReaddir(path).reduce((total, name) => total + bytesOf(join(path, name)), 0);
};

const sizeLabel = (path) => `${Math.max(1, Math.round(bytesOf(path) / 1024))} KB`;

const nextVersion = (historyDir, prefix, suffix) => {
  const highest = safeReaddir(historyDir).reduce((max, name) => {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) return max;
    const found = Number(name.slice(prefix.length, name.length - suffix.length));
    return found > max ? found : max;
  }, 0);
  return highest + 1;
};

const specRootOf = (parts, artifact) => {
  const dirs = parts.slice(0, -1);
  const owned = artifact.dir && dirs.at(-1) === artifact.dir ? dirs.slice(0, -1) : dirs;
  return owned.join(sep);
};

const findArtifacts = (harnessRoot) => {
  const byFile = new Map(ARTIFACTS.map((a) => [a.file, a]));
  let hits = [];
  try {
    hits = globSync(
      ARTIFACTS.map((a) => `**/${a.file}`),
      { cwd: harnessRoot, exclude: [`**/${HISTORY}/**`] },
    );
  } catch {
    return [];
  }
  return hits.flatMap((rel) => {
    const parts = rel.split(sep);
    // On a platform where the glob is case-insensitive, `**/review.md` also
    // returns REVIEW.md; the exact-name lookup is what keeps it out.
    const artifact = byFile.get(parts.at(-1));
    if (!artifact || parts.includes(HISTORY)) return [];
    const contentFile = join(harnessRoot, rel);
    return {
      artifact,
      specRoot: specRootOf(parts, artifact),
      // The state file already lives in this spec's own history folder, so the
      // path needs no trimming to be unique within it.
      stateKey: rel,
      contentFile,
      // A bundle is archived as the folder it sits in; contentFile stays the
      // file whose content decides whether that folder has changed.
      copyPath: artifact.bundle ? dirname(contentFile) : contentFile,
    };
  });
};

const groupBySpec = (items) => {
  const groups = Map.groupBy(items, (item) => item.specRoot);
  for (const group of groups.values()) {
    group.sort((a, b) => ARTIFACTS.indexOf(a.artifact) - ARTIFACTS.indexOf(b.artifact) || a.stateKey.localeCompare(b.stateKey));
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
};

const pendingFor = (item) => {
  const text = readText(item.contentFile);
  if (text === null || !item.artifact.isComplete(text)) return null;
  return { ...item, hash: hashOf(text) };
};

const archive = (item, historyDir, specRoot, now, emit) => {
  const suffix = extname(item.copyPath);
  const prefix = `${stemOf(item.artifact.file)}-v`;
  const name = `${prefix}${nextVersion(historyDir, prefix, suffix)}${suffix}`;
  const target = join(historyDir, name);
  cpSync(item.copyPath, target, { recursive: true, errorOnExist: true, force: false });
  appendFileSync(join(historyDir, "index.md"), `- ${name} — ${stamp(now)} — ${sizeLabel(target)}\n`);
  emit(`archived ${join(specRoot, HISTORY, name)}\n`);
};

const snapshotSpec = (harnessRoot, specRoot, items, now, emit) => {
  const complete = items.map(pendingFor).filter(Boolean);
  if (complete.length === 0) return;

  const historyDir = join(harnessRoot, specRoot, HISTORY);
  const statePath = join(historyDir, ".state.json");
  const known = readJsonSyncOr(statePath, {});
  const pending = complete.filter((item) => known[item.stateKey]?.hash !== item.hash);
  if (pending.length === 0) return;

  mkdirSync(historyDir, { recursive: true });
  withDirLockSync(join(historyDir, "archive.lock.d"), () => {
    const state = readJsonSyncOr(statePath, {});
    for (const item of pending) {
      if (state[item.stateKey]?.hash === item.hash) continue;
      try {
        archive(item, historyDir, specRoot, now, emit);
        state[item.stateKey] = { hash: item.hash };
        writeJsonAtomicSync(statePath, state);
      } catch {
        // One unarchivable artifact must not block the rest.
      }
    }
  });
};

export const run = (argv = [], cwd = process.cwd(), now = new Date()) => {
  const lines = [];
  const emit = (line) => lines.push(line);
  const harnessRoot = join(cwd, ".harness");
  for (const [specRoot, items] of groupBySpec(findArtifacts(harnessRoot))) {
    try {
      snapshotSpec(harnessRoot, specRoot, items, now, emit);
    } catch {
      // Archiving is best-effort; it must never fail a turn.
    }
  }
  return { exitCode: 0, stdout: lines.join("") };
};

const isMain = () => import.meta.url === `file://${process.argv[1]}`;

if (isMain()) {
  const { exitCode, stdout } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  process.exit(exitCode);
}
