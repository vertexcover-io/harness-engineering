import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createGit } from "@harness/sdk";
import * as z from "zod";
import corePackage from "../package.json";
import {
  type Event,
  type GitState,
  type Result,
  SlugSchema,
  type State,
  StateSchema,
} from "./contracts.ts";
import { type IEventStore, jsonlEventStore } from "./event-store.ts";
import { coreHandlers, type EmitInput, emitEvent, type RunRef, runDirOf } from "./events.ts";
import { parseYaml, readIfExists, readText, withLock } from "./files.ts";

export type EventHandler = (state: State, event: Event) => State;
export type EventHandlers = Readonly<Record<string, EventHandler>>;

// custom.* events are opaque by contract, so they can never reach a reducer.
const handlerFor = (handlers: EventHandlers, event: Event): EventHandler | undefined =>
  event.type.startsWith("custom.") ? undefined : handlers[event.type];

const applyEvent =
  (handlers: EventHandlers) =>
  (state: State, event: Event): State => {
    if (event.seq <= state.lastEventSeq) return state;
    const handler = handlerFor(handlers, event);
    const next = { ...(handler ? handler(state, event) : state), lastEventSeq: event.seq };
    const parsed = StateSchema.safeParse(next);
    if (!parsed.success) {
      throw new Error(`Event ${event.seq} (${event.type}): ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  };

export const projectEvents = (options: {
  readonly state: State;
  readonly events: readonly Event[];
  readonly handlers: EventHandlers;
}): State => options.events.reduce(applyEvent(options.handlers), options.state);

export const readState = async (runDir: string): Promise<State | null> => {
  const text = await readIfExists(join(runDir, "state.json"));
  return text === null ? null : StateSchema.parse(JSON.parse(text));
};

const writeStateAtomically = async (runDir: string, state: State): Promise<void> => {
  const artifactsDir = join(runDir, "artifacts");
  const tempPath = join(artifactsDir, `.state.${process.pid}.${crypto.randomUUID()}.tmp`);
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tempPath, join(runDir, "state.json"));
};

const lockOf = (runDir: string): string => join(runDir, "artifacts", ".state.lock");

const git = createGit();

export const readGit = async (cwd: string): Promise<GitState> => {
  const [branch, sha, defaultBranch] = await Promise.all([
    git.currentBranch(cwd),
    git.headSha(cwd),
    git.defaultBranch(cwd),
  ]);
  const branchName = branch.ok ? branch.value : "HEAD";
  return {
    branch: branchName,
    startSha: sha.ok ? sha.value : "",
    baseBranch: defaultBranch ?? branchName,
  };
};

// Repository keys in state.json are slugs, but package names are camelCase and mono repos use their folder name.
export const toRepoId = (name: string): string => {
  const slug = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "repo" : slug;
};

const workflowNameOf = async (runDir: string): Promise<string> => {
  const path = join(runDir, "workflow.yaml");
  const text = await readText(path);
  if (!text.ok) throw new Error(text.error);
  const yaml = parseYaml(text.value, path);
  if (!yaml.ok) throw new Error(yaml.error);
  return z.object({ name: SlugSchema }).parse(yaml.value).name;
};

// Writes a run's first state.json from the run folder alone: a run folder is CWD/.harness/NAME,
// holding the workflow.yaml init copied in. Events then fill in the rest (inputs, startedAt).
export const createState = async (runDir: string): Promise<State> => {
  const cwd = dirname(dirname(runDir));
  const state: State = {
    schemaVersion: 1,
    lastEventSeq: 0,
    specName: basename(runDir),
    harnessVersion: String(corePackage.version),
    workflow: { name: await workflowNameOf(runDir), path: "workflow.yaml" },
    input: {},
    scope: "workflow",
    options: {},
    startedAt: new Date().toISOString(),
    completedAt: null,
    outcome: null,
    currentFile: null,
    workspace: {
      path: cwd,
      repositories: { [toRepoId(basename(cwd))]: { path: cwd, git: await readGit(cwd) } },
    },
    activeNodeRuns: [],
    nodeRuns: {},
  };
  await withLock(lockOf(runDir), () => writeStateAtomically(runDir, state));
  return state;
};

// Applies the log's new events to state.json with the core reducers, under the state lock. A
// folder with no state.json yet is left alone and gives null: only createState writes the first.
export const syncState = (
  runDir: string,
  store: IEventStore = jsonlEventStore(runDir),
): Promise<State | null> =>
  withLock(lockOf(runDir), async () => {
    const current = await readState(runDir);
    if (current === null) return null;
    const events = await store.read();
    const next = projectEvents({ state: current, events, handlers: coreHandlers });
    await writeStateAtomically(runDir, next);
    return next;
  });

// Stores an event in a run's own folder, CWD/.harness/NAME/event.jsonl, then brings its
// state.json up to date, so every reader of the state sees the change.
export const emitRunEvent = async (run: RunRef, input: EmitInput): Promise<Result<Event>> => {
  const runDir = runDirOf(run.cwd, run.name);
  const store = jsonlEventStore(runDir);
  const stored = await emitEvent(store, run.id, input);
  if (!stored.ok) return stored;
  const synced = await syncState(runDir, store).catch((error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
  );
  if (synced instanceof Error) {
    return { ok: false, error: `event stored, but state.json not updated: ${synced.message}` };
  }
  return stored;
};
