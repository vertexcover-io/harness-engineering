import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import * as z from "zod";
import { type Event, EventSchema, type Result } from "./contracts.ts";
import { readIfExists, withLock } from "./files.ts";

export type EventDraft = Omit<z.input<typeof EventSchema>, "schemaVersion" | "seq">;

export type EventLog = {
  readonly read: () => Promise<readonly Event[]>;
  readonly append: (draft: EventDraft) => Promise<Result<Event>>;
};

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

const readJsonl = async (taskDir: string): Promise<readonly Event[]> => {
  const text = await readIfExists(join(taskDir, "event.jsonl"));
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

const appendJsonl = (taskDir: string, draft: EventDraft): Promise<Result<Event>> =>
  withLock(join(taskDir, "artifacts", ".event-log.lock"), async () => {
    const events = await readJsonl(taskDir);
    const existing = events.find((event) => event.id === draft.id);
    if (existing) return { ok: true, value: existing };
    const event = buildEvent(draft, events.length + 1);
    if (event.ok)
      await appendFile(join(taskDir, "event.jsonl"), `${JSON.stringify(event.value)}\n`);
    return event;
  });

export const jsonlEventLog = (taskDir: string): EventLog => ({
  read: () => readJsonl(taskDir),
  append: (draft) => appendJsonl(taskDir, draft),
});
