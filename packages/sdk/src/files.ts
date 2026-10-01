import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
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

// ROOT/.env is read on every call so a long-running process never sees stale inherited values.
// A key the file sets wins; otherwise the process environment supplies it.
export const readProjectEnv = async (root: string, key: string): Promise<string | undefined> => {
  const text = await readIfExists(join(root, ".env"));
  return parseEnv(text ?? "")[key] ?? process.env[key];
};

export const parseYaml = (text: string, path: string): Result<unknown> => {
  try {
    return { ok: true, value: parse(text) };
  } catch (error) {
    return { ok: false, error: `${path}: invalid YAML: ${String(error)}` };
  }
};

export const parseFrontmatter = (text: string, path: string): Result<unknown> => {
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") {
    return { ok: false, error: `${path}: no frontmatter; expected a first line of ---` };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return { ok: false, error: `${path}: frontmatter is not closed with ---` };
  return parseYaml(lines.slice(1, end).join("\n"), path);
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

// Every lock a run takes lives in its own folder, .harness/NAME/locks, away from the artifacts.
export const runLockPath = (runDir: string, name: string): string =>
  join(runDir, "locks", `${name}.lock`);

export const withLock = async <T>(lockDir: string, action: () => Promise<T>): Promise<T> => {
  await mkdir(dirname(lockDir), { recursive: true });
  await acquireLock(lockDir);
  try {
    return await action();
  } finally {
    await releaseLock(lockDir);
  }
};

export type ModuleError = Readonly<{
  kind: "missing-module" | "load-failed" | "missing-export";
  message: string;
  cause?: unknown;
}>;

type AnyFunction = (...args: never[]) => unknown;

export const importModule = async (
  file: string,
): Promise<Result<Record<string, unknown>, ModuleError>> => {
  if (!existsSync(file)) {
    return { ok: false, error: { kind: "missing-module", message: `module not found: ${file}` } };
  }
  try {
    return { ok: true, value: await import(pathToFileURL(file).href) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: { kind: "load-failed", message: `${file} failed to load: ${reason}` },
    };
  }
};

// Only callability can be checked at runtime; the signature is the caller's contract with the module.
const isFunction = <F extends AnyFunction>(value: unknown): value is F =>
  typeof value === "function";

export const loadFunction = async <F extends AnyFunction>(
  file: string,
  name: string,
): Promise<Result<F, ModuleError>> => {
  const loaded = await importModule(file);
  if (!loaded.ok) return loaded;
  const exported = loaded.value[name];
  if (!isFunction<F>(exported)) {
    return {
      ok: false,
      error: { kind: "missing-export", message: `${file} has no callable export "${name}"` },
    };
  }
  return { ok: true, value: exported };
};
