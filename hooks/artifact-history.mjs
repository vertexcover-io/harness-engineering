#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  appendFileSync,
  constants,
  copyFileSync,
  cpSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, extname, join, sep } from "node:path";
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

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const nextVersion = (historyDir, stem, suffix) => {
  const pattern = new RegExp(`^${escapeRe(stem)}-v(\\d+)${escapeRe(suffix)}$`);
  const highest = safeReaddir(historyDir).reduce((max, name) => {
    const found = Number(pattern.exec(name)?.[1]);
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
    hits = globSync(ARTIFACTS.map((a) => `**/${a.file}`), { cwd: harnessRoot });
  } catch {
    return [];
  }
  return hits
    .map((rel) => ({ rel, parts: rel.split(sep) }))
    .filter(({ parts }) => !parts.includes(HISTORY) && byFile.has(parts.at(-1)))
    .map(({ rel, parts }) => {
      const artifact = byFile.get(parts.at(-1));
      const specRoot = specRootOf(parts, artifact);
      return {
        specRoot,
        key: rel.slice(specRoot ? specRoot.length + 1 : 0),
        source: join(harnessRoot, rel),
        stem: artifact.file.slice(0, -extname(artifact.file).length),
        ext: extname(artifact.file),
        bundle: artifact.bundle === true,
        isComplete: artifact.isComplete,
        order: ARTIFACTS.indexOf(artifact),
      };
    });
};

const groupBySpec = (items) => {
  const groups = new Map();
  for (const item of items) {
    groups.set(item.specRoot, [...(groups.get(item.specRoot) ?? []), item]);
  }
  for (const [, group] of groups) {
    group.sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
};

const pendingFor = (item) => {
  const text = readText(item.source);
  if (text === null || !item.isComplete(text)) return null;
  return { ...item, hash: hashOf(text) };
};

const copyInto = (item, target) => {
  if (item.bundle) {
    cpSync(dirname(item.source), target, { recursive: true, errorOnExist: true, force: false });
    return;
  }
  copyFileSync(item.source, target, constants.COPYFILE_EXCL);
};

const snapshotSpec = (harnessRoot, specRoot, items, now, emit) => {
  const pending = items.map(pendingFor).filter(Boolean);
  if (pending.length === 0) return;

  const historyDir = join(harnessRoot, specRoot, HISTORY);
  const statePath = join(historyDir, ".state.json");
  mkdirSync(historyDir, { recursive: true });

  withDirLockSync(join(historyDir, "archive.lock.d"), () => {
    const state = readJsonSyncOr(statePath, {});
    for (const item of pending) {
      if (state[item.key]?.hash === item.hash) continue;
      try {
        const suffix = item.bundle ? "" : item.ext;
        const name = `${item.stem}-v${nextVersion(historyDir, item.stem, suffix)}${suffix}`;
        const target = join(historyDir, name);
        copyInto(item, target);
        appendFileSync(join(historyDir, "index.md"), `- ${name} — ${stamp(now)} — ${sizeLabel(target)}\n`);
        state[item.key] = { hash: item.hash };
        writeJsonAtomicSync(statePath, state);
        emit(`archived ${join(specRoot, HISTORY, name)}\n`);
      } catch {
        }
    }
  });
};

export const run = (argv = [], cwd = process.cwd(), now = new Date()) => {
  let stdout = "";
  const emit = (s) => {
    stdout += s;
  };
  const harnessRoot = join(cwd, ".harness");
  for (const [specRoot, items] of groupBySpec(findArtifacts(harnessRoot))) {
    try {
      snapshotSpec(harnessRoot, specRoot, items, now, emit);
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
