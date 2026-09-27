import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { type Event, type State, StateSchema } from "./contracts.ts";
import type { IEventStore } from "./event-store.ts";
import { readIfExists, withLock } from "./files.ts";

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

const readState = async (path: string): Promise<State | null> => {
  const text = await readIfExists(path);
  return text === null ? null : StateSchema.parse(JSON.parse(text));
};

const writeStateAtomically = async (taskDir: string, state: State): Promise<void> => {
  const artifactsDir = join(taskDir, "artifacts");
  const tempPath = join(artifactsDir, `.state.${process.pid}.${crypto.randomUUID()}.tmp`);
  await mkdir(artifactsDir, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tempPath, join(taskDir, "state.json"));
};

export const syncState = async (options: {
  readonly taskDir: string;
  readonly store: IEventStore;
  readonly seed: State;
  readonly handlers: EventHandlers;
}): Promise<State> =>
  withLock(join(options.taskDir, "artifacts", ".state.lock"), async () => {
    const current = (await readState(join(options.taskDir, "state.json"))) ?? options.seed;
    const events = await options.store.read();
    const next = projectEvents({ state: current, events, handlers: options.handlers });
    await writeStateAtomically(options.taskDir, next);
    return next;
  });
