import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parse } from "yaml";
import type { Result } from "./contracts.ts";

const LOCK_RETRY_MS = 10;

const isErrorCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const ifExists = async <T>(read: () => Promise<T>): Promise<T | null> => {
  try {
    return await read();
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
};

export const readIfExists = (path: string): Promise<string | null> =>
  ifExists(() => readFile(path, "utf8"));

export const readText = async (path: string): Promise<Result<string>> => {
  try {
    return { ok: true, value: await readFile(path, "utf8") };
  } catch (error) {
    return { ok: false, error: `${path}: cannot read file: ${String(error)}` };
  }
};

export const parseYaml = (text: string, path: string): Result<unknown> => {
  try {
    return { ok: true, value: parse(text) };
  } catch (error) {
    return { ok: false, error: `${path}: invalid YAML: ${String(error)}` };
  }
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
};

const isLockHeldError = (error: unknown): boolean =>
  ["EEXIST", "ENOTEMPTY", "ENOTDIR"].some((code) => isErrorCode(error, code));

const tempPathFor = (lockDir: string): string => `${lockDir}.TMP-${crypto.randomUUID()}`;

// Legitimate locks appear and disappear whole via rename, so a lock dir without an owner was tampered with.
const assertOwnerAlive = async (lockDir: string): Promise<void> => {
  const owner = await readIfExists(join(lockDir, "owner"));
  if (owner !== null && isProcessAlive(Number(owner))) return;
  if (owner !== null) {
    throw new Error(`Stale lock held by dead process ${owner}; remove ${lockDir}`);
  }
  const entries = await ifExists(() => readdir(lockDir));
  if (entries === null || entries.includes("owner")) return;
  throw new Error(`Stale lock has no owner file; remove ${lockDir}`);
};

const tryAcquireLock = async (lockDir: string): Promise<boolean> => {
  const tempDir = tempPathFor(lockDir);
  try {
    await mkdir(tempDir);
    await writeFile(join(tempDir, "owner"), String(process.pid));
    await rename(tempDir, lockDir);
    return true;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    if (isLockHeldError(error)) return false;
    throw error;
  }
};

const acquireLock = async (lockDir: string): Promise<void> => {
  if (await tryAcquireLock(lockDir)) return;
  await assertOwnerAlive(lockDir);
  await sleep(LOCK_RETRY_MS);
  return acquireLock(lockDir);
};

const releaseLock = async (lockDir: string): Promise<void> => {
  const tempDir = tempPathFor(lockDir);
  await rename(lockDir, tempDir);
  await rm(tempDir, { recursive: true, force: true });
};

export const withLock = async <T>(lockDir: string, action: () => Promise<T>): Promise<T> => {
  await mkdir(dirname(lockDir), { recursive: true });
  await acquireLock(lockDir);
  try {
    return await action();
  } finally {
    await releaseLock(lockDir);
  }
};
