import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { type Event, EventSchema, type Result } from "./contracts.ts";
import { readIfExists, runLockPath, withLock } from "./files.ts";

export type EventDraft = Omit<z.input<typeof EventSchema>, "schemaVersion" | "seq">;

export interface IEventStore {
  read(): Promise<readonly Event[]>;
  append(draft: EventDraft): Promise<Result<Event>>;
}

const parseLine = (line: string, index: number): Event => {
  const lineNumber = index + 1;
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new Error(`event.jsonl line ${lineNumber} is not valid JSON`);
  }
  const parsed = EventSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`event.jsonl line ${lineNumber}: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.seq !== lineNumber) {
    throw new Error(`event.jsonl line ${lineNumber} has seq ${parsed.data.seq}`);
  }
  return parsed.data;
};

const readJsonl = async (runDir: string): Promise<readonly Event[]> => {
  const text = await readIfExists(join(runDir, "event.jsonl"));
  if (!text) return [];
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return lines.map(parseLine);
};

const buildEvent = (draft: EventDraft, seq: number): Result<Event> => {
  const parsed = EventSchema.safeParse({ schemaVersion: 1, seq, ...draft });
  if (!parsed.success) {
    return { ok: false, error: `Event ${draft.id} is invalid: ${z.prettifyError(parsed.error)}` };
  }
  return { ok: true, value: parsed.data };
};

const appendOnce = async (options: {
  readonly events: readonly Event[];
  readonly draft: EventDraft;
  readonly persist: (event: Event) => Promise<void> | void;
}): Promise<Result<Event>> => {
  const existing = options.events.find((event) => event.id === options.draft.id);
  if (existing) return { ok: true, value: existing };
  const event = buildEvent(options.draft, options.events.length + 1);
  if (event.ok) await options.persist(event.value);
  return event;
};

const appendJsonl = (runDir: string, draft: EventDraft): Promise<Result<Event>> =>
  withLock(runLockPath(runDir, "event-log"), async () =>
    appendOnce({
      events: await readJsonl(runDir),
      draft,
      persist: (event) => appendFile(join(runDir, "event.jsonl"), `${JSON.stringify(event)}\n`),
    }),
  );

export const jsonlEventStore = (runDir: string): IEventStore => ({
  read: () => readJsonl(runDir),
  append: (draft) => appendJsonl(runDir, draft),
});

export const memoryEventStore = (): IEventStore => {
  let events: readonly Event[] = [];
  return {
    read: async () => events,
    append: (draft) =>
      appendOnce({
        events,
        draft,
        persist: (event) => {
          events = [...events, event];
        },
      }),
  };
};
