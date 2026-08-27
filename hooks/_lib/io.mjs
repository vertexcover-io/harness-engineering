import { readFile, writeFile, rename, mkdir, rmdir, stat } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const fileExists = (p) => existsSync(p);

export const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

export const readJsonSync = (p) => JSON.parse(readFileSync(p, "utf8"));

export const writeJsonAtomic = async (p, obj) => {
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2));
  await rename(tmp, p);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const withDagLock = async (dagFile, mutate) => {
  const lockDir = join(dirname(dagFile), "dag.lock.d");
  let acquired = false;
  for (let i = 0; i < 50; i++) {
    try {
      await mkdir(lockDir);
      acquired = true;
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!acquired) {
    try { await rmdir(lockDir); } catch {}
    try { await mkdir(lockDir); } catch {}
  }
  try {
    const current = await readJson(dagFile);
    const next = await mutate(current);
    await writeJsonAtomic(dagFile, next ?? current);
  } finally {
    try { await rmdir(lockDir); } catch {}
  }
};

export const mtimeMs = async (p) => {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
};

// --- sync variants, for hooks that must stay synchronous ---------------------

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export const readJsonSyncOr = (p, fallback) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
};

export const writeJsonAtomicSync = (p, obj) => {
  // The pid keeps two concurrent writers off each other's temp file.
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, p);
};

// mkdir is the lock: it is atomic, and it fails when the directory exists.
// After the retries are spent we break the lock and proceed, matching
// withDagLock — a holder that has been silent for five seconds is dead.
export const withDirLockSync = (lockDir, fn) => {
  let held = false;
  for (let i = 0; i < 50 && !held; i++) {
    try {
      mkdirSync(lockDir, { recursive: false });
      held = true;
    } catch {
      sleepSync(100);
    }
  }
  if (!held) {
    try { rmdirSync(lockDir); } catch {}
    try { mkdirSync(lockDir); } catch {}
  }
  try {
    return fn();
  } finally {
    try { rmdirSync(lockDir); } catch {}
  }
};
