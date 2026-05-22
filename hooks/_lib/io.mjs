import { readFile, writeFile, rename, mkdir, rmdir, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
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
