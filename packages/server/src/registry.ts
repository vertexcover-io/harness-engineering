import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { readIfExists, withLock } from "@harness/core";
import type { ILogger } from "@harness/sdk";
import { noopLogger } from "@harness/sdk";
import * as z from "zod";
import { type SessionRef, type WorkflowRun, WorkflowRunSchema } from "./protocol.ts";

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

const initRun =
  (runId: string, name: string): Change =>
  (registry) => {
    const run = registry.runs[runId];
    return run === undefined ? registry : withRun(registry, { ...run, name });
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

export type Registry = Readonly<{
  findRun: (runId: string) => Promise<WorkflowRun | undefined>;
  addRun: (run: WorkflowRun) => Promise<void>;
  initRun: (runId: string, name: string) => Promise<void>;
  // Resolves true when the session was new, false when it was already linked.
  linkSession: (runId: string, session: SessionRef) => Promise<boolean>;
}>;

export const createRegistry = (path: string, parentLog: ILogger = noopLogger): Registry => {
  const log = parentLog.child({ component: "registry", path });

  const read = async (): Promise<RegistryFile> => {
    const text = await readIfExists(path);
    return text === null ? EMPTY_REGISTRY : RegistryFileSchema.parse(JSON.parse(text));
  };

  // One change at a time: the lock is held from reading the file until the new one is renamed
  // in, so two requests cannot both change the same old copy. The rename means the file is
  // never half-written.
  const update = (change: Change): Promise<boolean> =>
    withLock(`${path}.lock`, async () => {
      const current = await read();
      const next = change(current);
      if (next === current) return false;
      const tempPath = `${path}.tmp-${randomUUID()}`;
      await writeFile(tempPath, JSON.stringify(next, null, 2));
      await rename(tempPath, path);
      log.debug({ runs: Object.keys(next.runs).length }, "registry written");
      return true;
    });

  return {
    findRun: async (runId) => (await read()).runs[runId],
    addRun: async (run) => {
      await update(addRun(run));
    },
    initRun: async (runId, name) => {
      await update(initRun(runId, name));
    },
    linkSession: (runId, session) => update(linkSession(runId, session)),
  };
};
