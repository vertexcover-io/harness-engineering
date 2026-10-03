import * as z from "zod";
import {
  type Event,
  EventSchema,
  type HookRef,
  HookRefSchema,
  type JsonValue,
  type State,
  StateSchema,
} from "./contracts.ts";
import { jsonlEventStore } from "./event-store.ts";
import {
  buildHookCallId,
  type EmitInput,
  type EventError,
  eventError,
  type RunRef,
  runDirOf,
  stackOf,
} from "./events.ts";
import { loadFunction, runLockPath, withLock } from "./files.ts";
import type { HookInput, RunHook } from "./hooks.ts";
import { spawn, spawnDetached } from "./process.ts";
import { appendRunEvent, readState, syncState } from "./state.ts";

export type Call =
  | Readonly<{ status: "ok"; output?: JsonValue }>
  | Readonly<{ status: "failed"; error: EventError }>;

type ModuleHook = Extract<HookRef, { module: string }>;

const OUTPUT_LIMIT = 10_000;
const SPAWN_OUTPUT_BYTES = 1_000_000;
// This file, which the hook processes run as a script (see the end of the file).
const THIS_FILE = import.meta.path;

// 1. Entry: which hooks an event fires, and how each call is recorded.

// Calls an event's hooks in order: a blocking hook is awaited and recorded before the next; a
// non-blocking one is left to a background runner, which records its own call.
export const triggerHooks = async (run: RunRef, event: Event, state: State): Promise<void> => {
  for (const hook of selectHooks(state, event)) {
    if (hook.blocking) await callAndRecord(run, event, hook, state);
    else startBackgroundRunner(run, event, hook);
  }
};

const CallRecordSchema = z.looseObject({ payload: z.looseObject({ hook: z.string() }) });

const isOwnRecord = (event: Event, hook: HookRef): boolean =>
  event.type === "hooks.hook.called" &&
  CallRecordSchema.safeParse(event).data?.payload.hook === hook.name;

// The hooks that listen to an event, in the order init froze them, minus a hook's own call record.
export const selectHooks = (state: State, event: Event): readonly HookRef[] =>
  (state.hooks[event.type] ?? []).filter((hook) => !isOwnRecord(event, hook));

// A call whose record fails to store is dropped: a hook never breaks the run.
const callAndRecord = async (
  run: RunRef,
  event: Event,
  hook: HookRef,
  state: State,
): Promise<void> => {
  const started = Date.now();
  const call = await callHook(hook, { event, state, run });
  await appendRunEvent(run, buildCallRecord(event, hook, call, Date.now() - started));
};

const buildCallRecord = (
  event: Event,
  hook: HookRef,
  call: Call,
  durationMs: number,
): EmitInput => ({
  id: buildHookCallId(event.id, hook.name),
  type: "hooks.hook.called",
  source: "hooks",
  payload: {
    hook: hook.name,
    eventId: event.id,
    eventSeq: event.seq,
    eventType: event.type,
    blocking: hook.blocking,
    durationMs,
    ...call,
  },
});

// 2. Calling one hook: a command or blocking module in a child process, any other module here.

// A hook that throws is a failed call, never an error of the caller. A blocking module runs in this
// file's call mode, so one that never settles dies with that process instead of holding the
// caller's open.
export const callHook = async (hook: HookRef, input: HookInput): Promise<Call> => {
  const seconds = hook.timeoutSeconds;
  try {
    if ("command" in hook) {
      return await runProcess("sh", ["-c", hook.command], hook.cwd, input, seconds);
    }
    if (hook.blocking) {
      return await runProcess(
        process.execPath,
        [THIS_FILE, "call"],
        process.cwd(),
        { hook, input },
        seconds,
      );
    }
    return await callModuleHere(hook, input);
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
// this file's call mode.
const callModuleHere = async (hook: ModuleHook, input: HookInput): Promise<Call> => {
  const loaded = await loadFunction<RunHook>(hook.module, hook.handler);
  if (!loaded.ok) return failCall(loaded.error.kind, loaded.error.message);
  const handler = loaded.value;
  return withTimeout(
    Promise.resolve().then(() => handler(input)),
    hook.timeoutSeconds,
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

// 3. Background runner: one non-blocking hook, called for each of its waiting events in turn.

// A runner that cannot start is dropped, like a call whose record fails.
const startBackgroundRunner = (run: RunRef, event: Event, hook: HookRef): void => {
  try {
    spawnDetached(process.execPath, [THIS_FILE, run.cwd, run.name, run.id, event.id, hook.name], {
      cwd: run.cwd,
      output: "ignore",
    });
  } catch {}
};

const findBackgroundHook = (state: State, event: Event, hookName: string): HookRef | undefined =>
  selectHooks(state, event).find((hook) => hook.name === hookName && !hook.blocking);

// Runners race for the lock, so each first calls the hook for the earlier events still waiting;
// one hook's calls thus never overlap, run in seq order, and each reads the state the one before
// it left.
export const runInBackground = async (
  run: RunRef,
  eventId: string,
  hookName: string,
): Promise<void> => {
  const runDir = runDirOf(run.cwd, run.name);
  await withLock(runLockPath(runDir, `hook-${hookName}`), async () => {
    const events = await jsonlEventStore(runDir).read();
    const target = events.find((stored) => stored.id === eventId);
    const frozen = await syncState(runDir);
    if (target === undefined || frozen === null) return;
    const recorded = new Set(events.map((event) => event.id));
    const waiting = events.filter(
      (event) =>
        event.seq <= target.seq &&
        findBackgroundHook(frozen, event, hookName) !== undefined &&
        !recorded.has(buildHookCallId(event.id, hookName)),
    );
    for (const event of waiting) {
      const state = (await syncState(runDir)) ?? frozen;
      const hook = findBackgroundHook(state, event, hookName);
      if (hook !== undefined) await callAndRecord(run, event, hook, state);
    }
  }).catch((error: unknown) => recordLockFailure(run, eventId, hookName, error));
};

// A runner that cannot take the hook's lock, such as one a killed runner left, says so in the
// call's record instead of leaving no trace.
const recordLockFailure = async (
  run: RunRef,
  eventId: string,
  hookName: string,
  error: unknown,
): Promise<void> => {
  const runDir = runDirOf(run.cwd, run.name);
  const event = (await jsonlEventStore(runDir).read()).find((stored) => stored.id === eventId);
  const state = await readState(runDir);
  if (event === undefined || state === null) return;
  const hook = findBackgroundHook(state, event, hookName);
  if (hook === undefined) return;
  await appendRunEvent(run, buildCallRecord(event, hook, failWithError("lock", error), 0));
};

// 4. Script entry: `call` for callHook's blocking modules, else the background runner.

const CallRequestSchema = z.object({
  // the module variant of a hook
  hook: HookRefSchema.options[0],
  input: z.object({
    event: EventSchema,
    state: StateSchema,
    run: z.object({ id: z.string(), cwd: z.string(), name: z.string() }),
  }),
});

// `call`: reads { hook, input } on stdin and answers like a command hook: the output as JSON on
// stdout and exit 0, or the error on stderr and exit 1.
const callMode = async (): Promise<number> => {
  const { hook, input } = CallRequestSchema.parse(await Bun.stdin.json());
  const call = await callModuleHere(hook, input);
  if (call.status === "failed") {
    await Bun.write(Bun.stderr, call.error.message);
    return 1;
  }
  if (call.output !== undefined) await Bun.write(Bun.stdout, JSON.stringify(call.output));
  return 0;
};

// CWD NAME RUN_ID EVENT_ID HOOK: runs and records one non-blocking hook for one stored event.
const runMode = async (args: readonly string[]): Promise<number> => {
  const [cwd, name, id, eventId, hook] = args;
  if (cwd && name && id && eventId && hook) {
    await runInBackground({ cwd, name, id }, eventId, hook).catch(() => undefined);
  }
  return 0;
};

// Only when bun runs this file itself, never when a process imports it. process.exit, because a
// hook that outlived its timeout may still hold the event loop open.
if (import.meta.main) {
  const args = process.argv.slice(2);
  (args[0] === "call" ? callMode() : runMode(args)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error);
      process.exit(1);
    },
  );
}
