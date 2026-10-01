import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import {
  JsonObjectSchema,
  NonEmptyStringSchema,
  type Result,
  SessionRefSchema,
  SlugSchema,
} from "./contracts.ts";
import { readIfExists, withLock } from "./files.ts";
import { type ILogger, noopLogger } from "./logger.ts";
import { resolveRun } from "./runs.ts";

export const harnessHome = (env: NodeJS.ProcessEnv = process.env): string =>
  env.HARNESS_HOME ?? join(homedir(), ".harness");

export const registryPath = (home: string = harnessHome()): string => join(home, "registry.json");

export const WorkflowRunSchema = z.strictObject({
  id: NonEmptyStringSchema,
  workflow: SlugSchema,
  workflowPath: NonEmptyStringSchema,
  inputs: JsonObjectSchema,
  cwd: NonEmptyStringSchema,
  // agent sessions of this run, first = the one start run launched
  sessions: z.array(SessionRefSchema),
  // Set by init; the run's folder is CWD/.harness/NAME.
  name: SlugSchema.nullable(),
  // tmux session the run's agent lives in; null until the server launches it
  terminal: NonEmptyStringSchema.nullable().default(null),
  createdAt: z.iso.datetime(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;
export type SessionRef = z.infer<typeof SessionRefSchema>;

export const RegistryFileSchema = z.strictObject({
  version: z.literal(1),
  runs: z.record(z.string(), WorkflowRunSchema),
});
export type RegistryFile = z.infer<typeof RegistryFileSchema>;

const EMPTY_REGISTRY: RegistryFile = { version: 1, runs: {} };

type Change = (registry: RegistryFile) => RegistryFile;

const withRun = (registry: RegistryFile, run: WorkflowRun): RegistryFile => ({
  ...registry,
  runs: { ...registry.runs, [run.id]: run },
});

// Each change returns the registry it was given when there is nothing to do, so update
// can skip the write and tell the caller nothing changed.
const addRun =
  (run: WorkflowRun): Change =>
  (registry) =>
    withRun(registry, run);

const removeRun =
  (runId: string): Change =>
  (registry) => {
    if (registry.runs[runId] === undefined) return registry;
    const { [runId]: _removed, ...runs } = registry.runs;
    return { ...registry, runs };
  };

const initRun =
  (runId: string, name: string): Change =>
  (registry) => {
    const run = registry.runs[runId];
    return run === undefined ? registry : withRun(registry, { ...run, name });
  };

const setTerminal =
  (runId: string, terminal: string): Change =>
  (registry) => {
    const run = registry.runs[runId];
    return run === undefined ? registry : withRun(registry, { ...run, terminal });
  };

const linkSession =
  (runId: string, session: SessionRef): Change =>
  (registry) => {
    const run = registry.runs[runId];
    if (run === undefined) return registry;
    const linked = run.sessions.some(
      (existing) => existing.agent === session.agent && existing.sessionId === session.sessionId,
    );
    return linked ? registry : withRun(registry, { ...run, sessions: [...run.sessions, session] });
  };

// A name is reused only after its run folder was deleted, so the newest run holds the folder.
const namedNewestFirst = (registry: RegistryFile, name: string): readonly WorkflowRun[] =>
  Object.values(registry.runs)
    .filter((run) => run.name === name)
    .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt));

export type RegistryReader = Readonly<{
  findRun: (runId: string) => Promise<WorkflowRun | undefined>;
  findRunsByName: (name: string) => Promise<readonly WorkflowRun[]>;
}>;

export type Registry = RegistryReader &
  Readonly<{
    addRun: (run: WorkflowRun) => Promise<void>;
    removeRun: (runId: string) => Promise<void>;
    initRun: (runId: string, name: string) => Promise<void>;
    setTerminal: (runId: string, terminal: string) => Promise<void>;
    linkSession: (runId: string, session: SessionRef) => Promise<void>;
  }>;

const readRegistry = async (path: string): Promise<RegistryFile> => {
  const text = await readIfExists(path);
  return text === null ? EMPTY_REGISTRY : RegistryFileSchema.parse(JSON.parse(text));
};

// What a script needs to find its run; changing the registry is the engine's job.
export const createRegistryReader = (path: string): RegistryReader => ({
  findRun: async (runId) => (await readRegistry(path)).runs[runId],
  findRunsByName: async (name) => namedNewestFirst(await readRegistry(path), name),
});

// A run id is unique everywhere; a run name only within a repo, so it comes with that repo's root.
export type RunTarget = Readonly<{ runId: string } | { name: string; root: string }>;

const findRunById = async (
  registry: RegistryReader,
  runId: string,
): Promise<Result<WorkflowRun>> => {
  const run = await registry.findRun(runId);
  return run === undefined
    ? { ok: false, error: `no run with id "${runId}"` }
    : { ok: true, value: run };
};

// A name resolves the way orchestrate resolves it (resolveRun), so a run started in a linked
// worktree or a sub-repo of `root` is found too.
export const findRunByIdOrName = async (
  registry: RegistryReader,
  target: RunTarget,
): Promise<Result<WorkflowRun>> => {
  if ("runId" in target) return findRunById(registry, target.runId);
  const found = await resolveRun({ registry, root: target.root, name: target.name });
  return found.ok ? findRunById(registry, found.value.id) : found;
};

export const createRegistry = (path: string, parentLog: ILogger = noopLogger): Registry => {
  const log = parentLog.child({ component: "registry", path });

  // One change at a time: the lock is held from reading the file until the new one is renamed
  // in, so two requests cannot both change the same old copy. The rename means the file is
  // never half-written.
  const update = (change: Change): Promise<boolean> =>
    withLock(`${path}.lock`, async () => {
      const current = await readRegistry(path);
      const next = change(current);
      if (next === current) return false;
      const tempPath = `${path}.tmp-${randomUUID()}`;
      await writeFile(tempPath, JSON.stringify(next, null, 2));
      await rename(tempPath, path);
      log.debug({ runs: Object.keys(next.runs).length }, "registry written");
      return true;
    });

  return {
    ...createRegistryReader(path),
    addRun: async (run) => {
      await update(addRun(run));
    },
    removeRun: async (runId) => {
      await update(removeRun(runId));
    },
    initRun: async (runId, name) => {
      await update(initRun(runId, name));
    },
    setTerminal: async (runId, terminal) => {
      await update(setTerminal(runId, terminal));
    },
    linkSession: async (runId, session) => {
      await update(linkSession(runId, session));
    },
  };
};
