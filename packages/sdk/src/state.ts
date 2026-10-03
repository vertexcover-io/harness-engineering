import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import * as z from "zod";
import {
  type Event,
  type EventHandlerRef,
  type EventHandlerRefs,
  EventSchema,
  type GitState,
  type HookRefs,
  type Result,
  SlugSchema,
  type State,
  StateSchema,
} from "./contracts.ts";
import { type IEventStore, jsonlEventStore } from "./event-store.ts";
import { builtInHandlers, type EmitInput, emitEvent, type RunRef, runDirOf } from "./events.ts";
import { loadFunction, parseYaml, readIfExists, readText, runLockPath, withLock } from "./files.ts";
import { createGit } from "./git.ts";
import { triggerHooks } from "./run-hooks.ts";

export type EventHandler = (state: State, event: Event) => State;
export type EventHandlers = Readonly<Record<string, EventHandler>>;
export type ExtensionHandlers = Readonly<Record<string, readonly EventHandler[]>>;

type Projection = Readonly<{
  state: State;
  events: readonly Event[];
  handlers: EventHandlers;
  extensions?: ExtensionHandlers;
}>;

const applyEvent = (state: State, event: Event, projection: Projection): State => {
  if (event.seq <= state.lastEventSeq) return state;
  const builtIn = projection.handlers[event.type];
  const chain = [...(builtIn ? [builtIn] : []), ...(projection.extensions?.[event.type] ?? [])];
  const handled = chain.reduce((current, handler) => handler(current, event), state);
  const parsed = StateSchema.safeParse({ ...handled, lastEventSeq: event.seq });
  if (!parsed.success) {
    throw new Error(`Event ${event.seq} (${event.type}): ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};

export const projectEvents = (projection: Projection): State =>
  projection.events.reduce(
    (state, event) => applyEvent(state, event, projection),
    projection.state,
  );

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

const lockOf = (runDir: string): string => runLockPath(runDir, "state");

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

// Writes a run's first state.json from the run folder: a run folder is CWD/.harness/NAME,
// holding the workflow.yaml init copied in. Events then fill in the rest (inputs, startedAt).
export const createState = async ({
  runId,
  runDir,
  version,
  eventHandlers,
  hooks,
  config,
}: Readonly<{
  runId: string;
  runDir: string;
  version: string;
  eventHandlers: EventHandlerRefs;
  hooks?: HookRefs;
  config?: State["config"];
}>): Promise<State> => {
  const cwd = dirname(dirname(runDir));
  const state: State = {
    schemaVersion: 1,
    lastEventSeq: 0,
    runId,
    runName: basename(runDir),
    runDir,
    version,
    workflow: { name: await workflowNameOf(runDir), path: "workflow.yaml" },
    input: {},
    scope: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "running",
    workspace: {
      type: "mono",
      path: cwd,
      repositories: { [toRepoId(basename(cwd))]: { path: cwd, git: await readGit(cwd) } },
    },
    nodeRuns: {},
    activeSessions: [],
    eventHandlers,
    hooks: hooks ?? {},
    ...(config === undefined ? {} : { config }),
  };
  await withLock(lockOf(runDir), () => writeStateAtomically(runDir, state));
  return state;
};

const loadHandler = async (ref: EventHandlerRef): Promise<Result<EventHandler>> => {
  const loaded = await loadFunction<EventHandler>(ref.module, ref.handler);
  if (loaded.ok) return loaded;
  return {
    ok: false,
    error: `event handler "${ref.handler}" in ${ref.module}: ${loaded.error.message}`,
  };
};

const loadEventHandlers = async (refs: EventHandlerRefs): Promise<Result<ExtensionHandlers>> => {
  const chains = await Promise.all(
    Object.entries(refs).map(
      async ([type, list]) => [type, await Promise.all(list.map(loadHandler))] as const,
    ),
  );
  const errors = chains.flatMap(([, loaded]) => loaded.flatMap((r) => (r.ok ? [] : [r.error])));
  if (errors.length > 0) return { ok: false, error: errors.join("; ") };
  const handlers = chains.map(([type, loaded]) => [
    type,
    loaded.flatMap((r) => (r.ok ? [r.value] : [])),
  ]);
  return { ok: true, value: Object.fromEntries(handlers) };
};

const projectLog = async (
  runDir: string,
  store: IEventStore,
  current: State,
  extensions: ExtensionHandlers,
): Promise<State> => {
  const events = await store.read();
  const next = projectEvents({ state: current, events, handlers: builtInHandlers, extensions });
  if (next.lastEventSeq === current.lastEventSeq) return next;
  await writeStateAtomically(runDir, next);
  return next;
};

// Applies the log's new events to state.json with the built-in handlers, then the run's own
// handlers listed in state.json, under the state lock. A folder with no state.json yet is left
// alone and gives null: only createState writes the first.
export const syncState = (
  runDir: string,
  store: IEventStore = jsonlEventStore(runDir),
): Promise<State | null> =>
  withLock(lockOf(runDir), async () => {
    const current = await readState(runDir);
    if (current === null) return null;
    const extensions = await loadEventHandlers(current.eventHandlers);
    if (!extensions.ok) throw new Error(extensions.error);
    return projectLog(runDir, store, current, extensions.value);
  });

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// A stored event that a handler cannot apply would stall state.json for good, since every later
// sync replays it; so the event is applied to a copy of the state before it is stored.
const tryEvent = async (
  store: IEventStore,
  runId: string,
  draft: EmitInput & { id: string },
  current: State,
  extensions: ExtensionHandlers,
): Promise<Result<void>> => {
  const events = await store.read();
  if (events.some((event) => event.id === draft.id)) return { ok: true, value: undefined };
  const ts = new Date().toISOString();
  const seq = events.length + 1;
  const candidate = EventSchema.safeParse({ schemaVersion: 1, seq, runId, ts, ...draft });
  if (!candidate.success) return { ok: true, value: undefined };
  try {
    projectEvents({
      state: current,
      events: [...events, candidate.data],
      handlers: builtInHandlers,
      extensions,
    });
    return { ok: true, value: undefined };
  } catch (error) {
    return {
      ok: false,
      error: `event not stored, a handler could not apply it: ${errorMessage(error)}`,
    };
  }
};

type Appended = Readonly<{ event: Event; state: State | null; fresh: boolean }>;

// Stores the event and brings state.json up to date under the state lock, so the event is checked
// against the same state it is then applied to. fresh: the event was not already in the log.
const appendUnderLock = (
  run: RunRef,
  input: EmitInput,
  allowed: (state: State | null) => boolean,
): Promise<Result<Appended>> => {
  const runDir = runDirOf(run.cwd, run.name);
  const store = jsonlEventStore(runDir);
  return withLock(lockOf(runDir), async () => {
    const current = await readState(runDir);
    if (current === null) {
      if (!allowed(null)) return { ok: false, error: "condition-failed" };
      const stored = await emitEvent(store, run.id, input);
      return stored.ok
        ? { ok: true, value: { event: stored.value, state: null, fresh: true } }
        : stored;
    }
    const extensions = await loadEventHandlers(current.eventHandlers);
    if (!extensions.ok) return extensions;
    const latest = await projectLog(runDir, store, current, extensions.value).catch(
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    if (latest instanceof Error) {
      return { ok: false, error: `state.json not synchronized: ${latest.message}` };
    }
    if (!allowed(latest)) return { ok: false, error: "condition-failed" };
    const draft = { ...input, id: input.id ?? crypto.randomUUID() };
    const tried = await tryEvent(store, run.id, draft, latest, extensions.value);
    if (!tried.ok) return tried;
    const stored = await emitEvent(store, run.id, draft);
    if (!stored.ok) return stored;
    const synced = await projectLog(runDir, store, latest, extensions.value).catch(
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    if (synced instanceof Error) {
      return { ok: false, error: `event stored, but state.json not updated: ${synced.message}` };
    }
    const fresh = stored.value.seq > latest.lastEventSeq;
    return { ok: true, value: { event: stored.value, state: synced, fresh } };
  });
};

// Stores an event in a run's own folder, CWD/.harness/NAME/event.jsonl, brings its state.json up
// to date, then calls the hooks that listen to it, outside the lock. It hands back the state.json
// it wrote (null when the folder has none yet), so a caller storing many events need not read
// the log again after each one.
export const appendRunEventIf = async (
  run: RunRef,
  input: EmitInput,
  allowed: (state: State | null) => boolean,
): Promise<Result<Readonly<{ event: Event; state: State | null }>>> => {
  const appended = await appendUnderLock(run, input, allowed);
  if (!appended.ok) return appended;
  const { event, state, fresh } = appended.value;
  if (fresh && state !== null) await triggerHooks(run, event, state);
  return { ok: true, value: { event, state } };
};

export const appendRunEvent = (
  run: RunRef,
  input: EmitInput,
): Promise<Result<Readonly<{ event: Event; state: State | null }>>> =>
  appendRunEventIf(run, input, () => true);

// The event families the engine writes and then trusts: workflow.* moves the run's nodes,
// orchestrate.done counts a node's rejected attempts, and a context node completes on
// hooks.session-start.called. Extension code may record anything else.
const ENGINE_OWNED: readonly (readonly [prefix: string, reason: string])[] = [
  ["workflow.", "is engine-owned; use next, exec, or done for workflow lifecycle"],
  ["orchestrate.", "is written only by the orchestrate script"],
  ["hooks.", "is written only by the agent's hooks and the run's hooks"],
];

export const emitRunEvent = async (run: RunRef, input: EmitInput): Promise<Result<Event>> => {
  const owned = ENGINE_OWNED.find(([prefix]) => input.type.startsWith(prefix));
  if (owned !== undefined) return { ok: false, error: `${input.type} ${owned[1]}` };
  const appended = await appendRunEvent(run, input);
  return appended.ok ? { ok: true, value: appended.value.event } : appended;
};
