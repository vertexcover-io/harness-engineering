import * as z from "zod";
import {
  type Event,
  EventSchema,
  type JsonValue,
  type State,
  StateSchema,
  type SubscriberRef,
  SubscriberRefSchema,
} from "./contracts.ts";
import { jsonlEventStore } from "./event-store.ts";
import {
  buildSubscriberCallId,
  type EmitInput,
  type EventError,
  eventError,
  type RunRef,
  runDirOf,
  stackOf,
} from "./events.ts";
import { loadFunction, runLockPath, withLock } from "./files.ts";
import { selfArgv, spawn, spawnDetached } from "./process.ts";
import { appendRunEvent, readState, syncState } from "./state.ts";

export type Call =
  | Readonly<{ status: "ok"; output?: JsonValue }>
  | Readonly<{ status: "failed"; error: EventError }>;

// What a subscriber receives: the event it listens to, the run's state once the event is applied,
// and the run itself, to store events of its own (custom.state.updated keeps values between calls).
export type SubscriberInput = Readonly<{ event: Event; state: State; run: RunRef }>;

// A subscriber module's export. What it returns, as JSON, is recorded as the call's output.
export type Subscriber = (input: SubscriberInput) => unknown;

type ModuleSubscriber = Extract<SubscriberRef, { module: string }>;

const OUTPUT_LIMIT = 10_000;
const SPAWN_OUTPUT_BYTES = 1_000_000;
// The program again, with the hidden orchestrate subcommand that calls one subscriber (section 4).
const runSubscriberArgv = (mode: "call" | "run"): readonly [string, ...string[]] => [
  ...selfArgv(),
  "orchestrate",
  "run-subscriber",
  mode,
];

// 1. Entry: which subscribers an event fires, and how each call is recorded.

// Calls an event's subscribers in order: a blocking subscriber is awaited and recorded before the next; a
// non-blocking one is left to a background runner, which records its own call.
export const triggerSubscribers = async (
  run: RunRef,
  event: Event,
  state: State,
): Promise<void> => {
  for (const subscriber of selectSubscribers(state, event)) {
    if (subscriber.blocking) await callAndRecord(run, event, subscriber, state);
    else startBackgroundRunner(run, event, subscriber);
  }
};

const CallRecordSchema = z.looseObject({ payload: z.looseObject({ subscriber: z.string() }) });

const isOwnRecord = (event: Event, subscriber: SubscriberRef): boolean =>
  event.type === "subscriber.called" &&
  CallRecordSchema.safeParse(event).data?.payload.subscriber === subscriber.name;

// The subscribers that listen to an event, in the order init froze them, minus a subscriber's own call record.
export const selectSubscribers = (state: State, event: Event): readonly SubscriberRef[] =>
  (state.subscribers[event.type] ?? []).filter((subscriber) => !isOwnRecord(event, subscriber));

// A call whose record fails to store is dropped: a subscriber never breaks the run.
const callAndRecord = async (
  run: RunRef,
  event: Event,
  subscriber: SubscriberRef,
  state: State,
): Promise<void> => {
  const started = Date.now();
  const call = await callSubscriber(subscriber, { event, state, run });
  await appendRunEvent(run, buildCallRecord(event, subscriber, call, Date.now() - started));
};

const buildCallRecord = (
  event: Event,
  subscriber: SubscriberRef,
  call: Call,
  durationMs: number,
): EmitInput => ({
  id: buildSubscriberCallId(event.id, subscriber.name),
  type: "subscriber.called",
  source: "subscriber",
  payload: {
    subscriber: subscriber.name,
    eventId: event.id,
    eventSeq: event.seq,
    eventType: event.type,
    blocking: subscriber.blocking,
    durationMs,
    ...call,
  },
});

// 2. Calling one subscriber: a command or blocking module in a child process, any other module here.

// A subscriber that throws is a failed call, never an error of the caller. A blocking module runs in
// `run-subscriber call`, so one that never settles dies with that process instead of holding the
// caller's open.
export const callSubscriber = async (
  subscriber: SubscriberRef,
  input: SubscriberInput,
): Promise<Call> => {
  const seconds = subscriber.timeoutSeconds;
  try {
    if ("command" in subscriber) {
      return await runProcess("sh", ["-c", subscriber.command], subscriber.cwd, input, seconds);
    }
    if (subscriber.blocking) {
      const [program, ...args] = runSubscriberArgv("call");
      return await runProcess(program, args, process.cwd(), { subscriber, input }, seconds);
    }
    return await callModuleHere(subscriber, input);
  } catch (error) {
    return failWithError("threw", error);
  }
};

const runProcess = async (
  command: string,
  args: readonly string[],
  cwd: string,
  stdin: unknown,
  seconds: number,
): Promise<Call> => {
  const result = await spawn(command, args, {
    cwd,
    input: JSON.stringify(stdin),
    timeoutMs: seconds * 1000,
    maxOutputBytes: SPAWN_OUTPUT_BYTES,
  });
  if (result.stopped !== null) return failCall("timeout", `timed out after ${seconds}s`);
  if (result.code !== 0) {
    return failCall("exit", `exit ${result.code}: ${result.stderr.trim().slice(-500)}`);
  }
  const text = result.stdout.trim();
  if (text === "") return { status: "ok" };
  try {
    return toOutput(JSON.parse(text));
  } catch {
    return toOutput(text);
  }
};

// In this process, so only where the process exits once the call ends: the background runner, and
// `run-subscriber call`.
const callModuleHere = async (
  subscriber: ModuleSubscriber,
  input: SubscriberInput,
): Promise<Call> => {
  const loaded = await loadFunction<Subscriber>(subscriber.module, subscriber.handler);
  if (!loaded.ok) return failCall(loaded.error.kind, loaded.error.message);
  const handler = loaded.value;
  return withTimeout(
    Promise.resolve().then(() => handler(input)),
    subscriber.timeoutSeconds,
  )
    .then(toOutput)
    .catch((error: unknown) => failWithError("threw", error));
};

const withTimeout = async <T>(work: Promise<T>, seconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${seconds}s`)), seconds * 1000);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
};

// A value that is not JSON, or too long to keep, is recorded as text.
const toOutput = (value: unknown): Call => {
  if (value === undefined) return { status: "ok" };
  const json = typeof value === "string" ? undefined : JSON.stringify(value);
  const text = json ?? String(value);
  if (text.length > OUTPUT_LIMIT) return { status: "ok", output: text.slice(0, OUTPUT_LIMIT) };
  return { status: "ok", output: json === undefined ? text : JSON.parse(json) };
};

const failCall = (kind: string, message: string, stack?: string): Call => ({
  status: "failed",
  error: eventError(kind, message, stack),
});

const failWithError = (kind: string, error: unknown): Call =>
  error instanceof Error
    ? failCall(kind, error.message, stackOf(error))
    : failCall(kind, String(error));

// 3. Background runner: one non-blocking subscriber, called for each of its waiting events in turn.

// A runner that cannot start is dropped, like a call whose record fails.
const startBackgroundRunner = (run: RunRef, event: Event, subscriber: SubscriberRef): void => {
  try {
    const [program, ...args] = runSubscriberArgv("run");
    spawnDetached(program, [...args, run.cwd, run.name, run.id, event.id, subscriber.name], {
      cwd: run.cwd,
      output: "ignore",
    });
  } catch {}
};

const findBackgroundSubscriber = (
  state: State,
  event: Event,
  subscriberName: string,
): SubscriberRef | undefined =>
  selectSubscribers(state, event).find(
    (subscriber) => subscriber.name === subscriberName && !subscriber.blocking,
  );

// Runners race for the lock, so each first calls the subscriber for the earlier events still waiting;
// one subscriber's calls thus never overlap, run in seq order, and each reads the state the one before
// it left.
export const runInBackground = async (
  run: RunRef,
  eventId: string,
  subscriberName: string,
): Promise<void> => {
  const runDir = runDirOf(run.cwd, run.name);
  await withLock(runLockPath(runDir, `subscriber-${subscriberName}`), async () => {
    const events = await jsonlEventStore(runDir).read();
    const target = events.find((stored) => stored.id === eventId);
    const frozen = await syncState(runDir);
    if (target === undefined || frozen === null) return;
    const recorded = new Set(events.map((event) => event.id));
    const waiting = events.filter(
      (event) =>
        event.seq <= target.seq &&
        findBackgroundSubscriber(frozen, event, subscriberName) !== undefined &&
        !recorded.has(buildSubscriberCallId(event.id, subscriberName)),
    );
    for (const event of waiting) {
      const state = (await syncState(runDir)) ?? frozen;
      const subscriber = findBackgroundSubscriber(state, event, subscriberName);
      if (subscriber !== undefined) await callAndRecord(run, event, subscriber, state);
    }
  }).catch((error: unknown) => recordLockFailure(run, eventId, subscriberName, error));
};

// A runner that cannot take the subscriber's lock, such as one a killed runner left, says so in the
// call's record instead of leaving no trace.
const recordLockFailure = async (
  run: RunRef,
  eventId: string,
  subscriberName: string,
  error: unknown,
): Promise<void> => {
  const runDir = runDirOf(run.cwd, run.name);
  const event = (await jsonlEventStore(runDir).read()).find((stored) => stored.id === eventId);
  const state = await readState(runDir);
  if (event === undefined || state === null) return;
  const subscriber = findBackgroundSubscriber(state, event, subscriberName);
  if (subscriber === undefined) return;
  await appendRunEvent(run, buildCallRecord(event, subscriber, failWithError("lock", error), 0));
};

// 4. Entries for `yok orchestrate run-subscriber call|run`.

const CallRequestSchema = z.object({
  // the module variant of a subscriber
  subscriber: SubscriberRefSchema.options[0],
  input: z.object({
    event: EventSchema,
    state: StateSchema,
    run: z.object({ id: z.string(), cwd: z.string(), name: z.string() }),
  }),
});

// `call`: reads { subscriber, input } on stdin and answers like a command subscriber: the output as JSON on
// stdout and exit 0, or the error on stderr and exit 1.
export const callMode = async (): Promise<number> => {
  const { subscriber, input } = CallRequestSchema.parse(await Bun.stdin.json());
  const call = await callModuleHere(subscriber, input);
  if (call.status === "failed") {
    await Bun.write(Bun.stderr, call.error.message);
    return 1;
  }
  if (call.output !== undefined) await Bun.write(Bun.stdout, JSON.stringify(call.output));
  return 0;
};

// Runs and records one non-blocking subscriber for one stored event.
export const runMode = async ({
  eventId,
  subscriber,
  ...run
}: Readonly<{
  cwd: string;
  name: string;
  id: string;
  eventId: string;
  subscriber: string;
}>): Promise<number> => {
  await runInBackground(run, eventId, subscriber).catch(() => undefined);
  return 0;
};
