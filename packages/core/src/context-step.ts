import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ContextStartedEvent,
  type IAgentProvider,
  type ILogger,
  type ITerminal,
  type JsonValue,
  type LaunchOptions,
  type NodeRun,
  type Result,
  type RunRef,
  readState,
  runDirOf,
  SessionStartCalledEvent,
  sessionEnv,
  type TierModel,
  tierLaunch,
} from "@yok/sdk";
import {
  appendRunEvent,
  foldModelSwitch,
  type IEventStore,
  jsonlEventStore,
  pickTierModel,
  type Registry,
  runLockPath,
  selfArgv,
  writeShim,
} from "@yok/sdk/internal";
import {
  CLAUDE_CLEAR_INPUT_KEY,
  CLAUDE_NOTHING_TO_COMPACT,
  isClaudeBusy,
} from "./agents/claude.ts";
import { typeLine } from "./agents/common.ts";
import { currentTerminal } from "./agents/tmux.ts";
import { completeContextStep, findContextPlanNode, loadSessionEnv } from "./runs.ts";
import { spawnOrchestrateHelper } from "./stage.ts";

const IDLE_TIMEOUT_MS = 30_000;
const IDLE_POLL_MS = 100;
const DONE_POLL_MS = 250;
// how long a new session may take to start, and a compact to finish, before the step fails
const DONE_TIMEOUT_MS = { new: 60_000, compact: 180_000 } as const;

export const startModelStep = async (run: RunRef, sessionId: string, seq: number): Promise<void> =>
  spawnOrchestrateHelper({ command: "model", id: String(seq), run, sessionId });

export const startContextStep = async (
  run: RunRef,
  sessionId: string,
  nodeRunId: string,
): Promise<void> => spawnOrchestrateHelper({ command: "context", id: nodeRunId, run, sessionId });

export type ContextStepOptions = Readonly<{
  run: RunRef;
  nodeRunId: string;
  // the session whose turn just ended, which a new session replaces
  oldSessionId: string;
  // undefined when the helper was not started inside a tmux pane
  terminal: ITerminal | undefined;
  registry: Registry;
  provider: IAgentProvider;
  // how the agent was launched; relaunching adds the session's env and the resume prompt
  launch: Omit<LaunchOptions, "prompt" | "env">;
  home: string;
  log: ILogger;
}>;

// Polls until the probe finds something; it stops at the first error or when time runs out.
const pollUntil = async <T>(
  {
    everyMs,
    timeoutMs,
    timeoutError,
  }: Readonly<{ everyMs: number; timeoutMs: number; timeoutError: string }>,
  probe: () => Promise<Result<T | undefined>>,
): Promise<Result<T>> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await probe();
    if (!found.ok) return found;
    if (found.value !== undefined) return { ok: true, value: found.value };
    if (Date.now() >= deadline) return { ok: false, error: timeoutError };
    await Bun.sleep(everyMs);
  }
};

const waitForIdle = (terminal: ITerminal): Promise<Result<true>> =>
  pollUntil(
    { everyMs: IDLE_POLL_MS, timeoutMs: IDLE_TIMEOUT_MS, timeoutError: "Claude did not go idle" },
    async () => {
      const screen = await terminal.capture();
      if (!screen.ok) return screen;
      return { ok: true, value: isClaudeBusy(screen.value) ? undefined : true };
    },
  );

const resumePrompt = (run: RunRef): string => `/yok:orchestrate --resume ${run.name}`;

// A tmux call can throw (a hung tmux times out) and so can reading a half-written event line. The
// helper runs detached, so a throw would end it silently and leave the node open for good: it
// becomes a failed step, logged with its stack.
const catchThrow = <T>(log: ILogger, step: Promise<Result<T>>): Promise<Result<T>> =>
  step.catch((error: unknown): Result<T> => {
    log.error({ err: error }, "context step threw");
    return { ok: false, error: error instanceof Error ? error.message : "context step threw" };
  });

// The Stop hook starts a helper on every stop while its step is pending; only the first one to
// create the step's lock file goes ahead.
const claimLock = async (run: RunRef, name: string): Promise<boolean> => {
  const lock = runLockPath(runDirOf(run.cwd, run.name), name);
  try {
    await mkdir(dirname(lock), { recursive: true });
    await (await open(lock, "wx")).close();
    return true;
  } catch {
    return false;
  }
};

const complete = async (options: ContextStepOptions, output: JsonValue): Promise<Result<void>> => {
  const completed = await completeContextStep(options.run, options.nodeRunId, output);
  return completed.ok ? { ok: true, value: undefined } : completed;
};

const replaceSession = (
  { run }: ContextStepOptions,
  previousSessionId: string,
  sessionId: string,
): Promise<unknown> =>
  appendRunEvent(run, {
    type: "workflow.session.replaced",
    source: "orchestrate",
    payload: { agent: "claude", previousSessionId, sessionId },
  });

const recordStarted = (
  { run, nodeRunId }: ContextStepOptions,
  action: "new" | "compact",
  sessionId: string,
): Promise<unknown> =>
  appendRunEvent(run, {
    type: "workflow.context.started",
    source: "orchestrate",
    payload: { nodeRunId, action, sessionId },
  });

// The SessionStart hook records success (completeContextOnSessionStart); the helper only watches
// for failure: no SessionStart in time, or a compact Claude refuses.
const watchForFailure = (
  { run, nodeRunId }: ContextStepOptions,
  terminal: ITerminal,
  action: keyof typeof DONE_TIMEOUT_MS,
): Promise<Result<true>> =>
  pollUntil(
    {
      everyMs: DONE_POLL_MS,
      timeoutMs: DONE_TIMEOUT_MS[action],
      timeoutError: `no SessionStart for the ${action} within ${DONE_TIMEOUT_MS[action] / 1000} seconds`,
    },
    async (): Promise<Result<true | undefined>> => {
      if (!(await findContextPlanNode(run, nodeRunId)).ok) return { ok: true, value: true };
      if (action !== "compact") return { ok: true, value: undefined };
      const screen = await terminal.capture();
      if (screen.ok && screen.value.includes(CLAUDE_NOTHING_TO_COMPACT)) {
        return { ok: false, error: CLAUDE_NOTHING_TO_COMPACT };
      }
      return { ok: true, value: undefined };
    },
  );

// The new session is linked and swapped in before the relaunch, so the run's hooks recognize it
// from its first moment. A relaunch that fails leaves the old session in the pane, so the swap is
// undone and the step fails, which resumes the old session.
const startNewSession = async (
  options: ContextStepOptions,
  terminal: ITerminal,
): Promise<Result<void>> => {
  const { run, registry, provider, oldSessionId, log } = options;
  const env = await loadSessionEnv(run, provider.type);
  if (!env.ok) return env;
  const idle = await waitForIdle(terminal);
  if (!idle.ok) return idle;
  const sessionId = randomUUID();
  await registry.linkSession(run.id, { agent: "claude", sessionId });
  await replaceSession(options, oldSessionId, sessionId);
  await recordStarted(options, "new", sessionId);
  const launch = {
    ...options.launch,
    env: sessionEnv(env.value, run.id, options.home, writeShim(selfArgv(), options.home)),
    prompt: resumePrompt(run),
  };
  const relaunched = await catchThrow(log, provider.relaunch(terminal, sessionId, launch));
  if (!relaunched.ok) {
    await replaceSession(options, sessionId, oldSessionId);
    return relaunched;
  }
  log.info({ sessionId }, "Claude relaunched on a new session");
  const done = await watchForFailure(options, terminal, "new");
  if (!done.ok) return done;
  log.info({ sessionId }, "node completed by the new session's SessionStart");
  return { ok: true, value: undefined };
};

const compact = async (
  options: ContextStepOptions,
  terminal: ITerminal,
  prompt: string | undefined,
): Promise<Result<void>> => {
  const { oldSessionId, log } = options;
  const idle = await waitForIdle(terminal);
  if (!idle.ok) return idle;
  await recordStarted(options, "compact", oldSessionId);
  const command = prompt === undefined ? "/compact" : `/compact ${prompt}`;
  const typed = await typeLine(terminal, command);
  if (!typed.ok) return typed;
  log.info({ command }, "compact typed");
  const done = await watchForFailure(options, terminal, "compact");
  if (!done.ok) return done;
  log.info({}, "node completed by the compact's SessionStart");
  return { ok: true, value: undefined };
};

export const findOpenContextRun = (
  nodeRuns: Readonly<Record<string, NodeRun>>,
): NodeRun | undefined => {
  for (const nodeRun of Object.values(nodeRuns)) {
    if (nodeRun.status !== "running") continue;
    if (nodeRun.nodeType === "context") return nodeRun;
    const inside = nodeRun.nodes === undefined ? undefined : findOpenContextRun(nodeRun.nodes);
    if (inside !== undefined) return inside;
  }
  return undefined;
};

// The action the helper began for this node run, from its workflow.context.started event.
const findStartedAction = async (runDir: string, nodeRunId: string) => {
  const events = await jsonlEventStore(runDir).read();
  const started = events
    .filter((event) => event.type === "workflow.context.started")
    .map((event) => ContextStartedEvent.safeParse(event))
    .findLast((parsed) => parsed.success && parsed.data.payload.nodeRunId === nodeRunId);
  return started?.success ? started.data.payload : undefined;
};

// Claude runs its SessionStart hooks once a new session has started or a compact has finished,
// and before it handles its next prompt: the moment an open context node's action is done. It
// counts only when it matches the action the helper began. After a compact, the session gets the
// resume prompt here; typed while Claude runs its hooks, it is queued and sent when they finish.
// A new session needs none: it was launched with the resume prompt.
export const completeContextOnSessionStart = async (
  run: RunRef,
  sessionId: string,
  source: string,
  terminal: ITerminal | undefined = currentTerminal(),
): Promise<void> => {
  const runDir = runDirOf(run.cwd, run.name);
  const state = await readState(runDir);
  const open = state === null ? undefined : findOpenContextRun(state.nodeRuns);
  if (open === undefined) return;
  const started = await findStartedAction(runDir, open.nodeRunId);
  if (started === undefined || started.sessionId !== sessionId) return;
  const matches =
    (started.action === "new" && source === "startup") ||
    (started.action === "compact" && source === "compact");
  if (!matches) return;
  const output = { action: started.action, applied: true, sessionId };
  const completed = await completeContextStep(run, open.nodeRunId, output);
  if (!completed.ok || started.action !== "compact" || terminal === undefined) return;
  await typeLine(terminal, resumePrompt(run));
};

// The session in the pane carries on after a step that did not happen: the input box is emptied
// (a cancelled /compact stays in it and would swallow the prompt) and the run resumed.
const resumeRun = async (run: RunRef, terminal: ITerminal, log: ILogger): Promise<void> => {
  const emptied = await catchThrow(log, terminal.sendKeys([CLAUDE_CLEAR_INPUT_KEY]));
  if (!emptied.ok) log.warn({ err: emptied.error }, "input box not emptied");
  const idle = await catchThrow(log, waitForIdle(terminal));
  if (!idle.ok)
    log.warn({ err: idle.error }, "typing the resume prompt although Claude looks busy");
  const typed = await catchThrow(log, typeLine(terminal, resumePrompt(run)));
  if (!typed.ok) log.error({ err: typed.error }, "resume prompt not typed");
};

// A context step that did not happen still completes, and the old session carries on.
const recover = async (
  options: ContextStepOptions,
  terminal: ITerminal,
  action: string,
  reason: string,
): Promise<void> => {
  const { run, log } = options;
  log.error({ action, reason }, "context step not applied");
  const completed = await catchThrow(log, complete(options, { action, applied: false, reason }));
  if (!completed.ok) log.error({ err: completed.error }, "context node not completed");
  await resumeRun(run, terminal, log);
};

// Runs after the Stop hook that found a context node open: starts a new session in the agent's
// pane, or compacts the one it has, then lets the run carry on.
export const runContextStep = async (options: ContextStepOptions): Promise<void> => {
  const { run, nodeRunId, terminal, log } = options;
  if (!(await claimLock(run, `context-${nodeRunId}`))) {
    return log.info({ nodeRunId }, "another helper has this node");
  }
  const planNode = await findContextPlanNode(run, nodeRunId);
  if (!planNode.ok) return log.info({ nodeRunId, reason: planNode.error }, "no open context node");
  const { action, prompt } = planNode.value;
  log.info({ nodeRunId, action }, "context step started");
  if (terminal === undefined) {
    const completed = await complete(options, {
      action,
      applied: false,
      reason: "not inside tmux",
    });
    if (!completed.ok) log.error({ err: completed.error }, "context node not completed");
    return;
  }
  const outcome = await catchThrow(
    log,
    action === "new" ? startNewSession(options, terminal) : compact(options, terminal, prompt),
  );
  if (!outcome.ok) await recover(options, terminal, action, outcome.error);
};

export type ModelStepOptions = Readonly<{
  run: RunRef;
  // seq of the workflow.model.requested event this helper carries out
  seq: number;
  // the session whose turn just ended; it is resumed on the new model
  sessionId: string;
  terminal: ITerminal | undefined;
  provider: IAgentProvider;
  // how the agent was launched; the relaunch adds the model, the session's env and the resume prompt
  launch: Omit<LaunchOptions, "prompt" | "env" | "model" | "effort" | "resume">;
  home: string;
  log: ILogger;
}>;

// Restarts the same session in its pane on the target model: flags apply to this session only,
// where /model and /effort would also become the user's default for every new session.
const resumeOnModel = async (
  options: ModelStepOptions,
  terminal: ITerminal,
  target: TierModel,
): Promise<Result<void>> => {
  const { run, provider, sessionId, launch, home, log } = options;
  const env = await loadSessionEnv(run, provider.type);
  if (!env.ok) return env;
  const idle = await waitForIdle(terminal);
  if (!idle.ok) return idle;
  const store = jsonlEventStore(runDirOf(run.cwd, run.name));
  const before = (await store.read()).at(-1)?.seq ?? 0;
  const relaunched = await catchThrow(
    log,
    provider.relaunch(terminal, sessionId, {
      ...launch,
      ...tierLaunch(target),
      resume: true,
      env: sessionEnv(env.value, run.id, home, writeShim(selfArgv(), home)),
      prompt: resumePrompt(run),
    }),
  );
  if (!relaunched.ok) return relaunched;
  const resumed = await waitForResume(store, sessionId, before, target.model);
  return resumed.ok ? { ok: true, value: undefined } : resumed;
};

// A relaunch only proves tmux respawned the pane: the switch happened once the resumed session's
// SessionStart arrives, which a Claude that rejects the model never sends.
const waitForResume = (
  store: IEventStore,
  sessionId: string,
  afterSeq: number,
  model: string,
): Promise<Result<true>> =>
  pollUntil(
    {
      everyMs: DONE_POLL_MS,
      timeoutMs: DONE_TIMEOUT_MS.new,
      timeoutError: `no SessionStart within ${DONE_TIMEOUT_MS.new / 1000} seconds after resuming on ${model}`,
    },
    async () => {
      const events = await store.read();
      const resumed = events.some((event) => {
        if (event.seq <= afterSeq || event.type !== "hooks.session-start.called") return false;
        const parsed = SessionStartCalledEvent.safeParse(event);
        const payload = parsed.success ? parsed.data.payload : undefined;
        return payload?.sessionId === sessionId && payload.source === "resume";
      });
      return { ok: true, value: resumed ? true : undefined };
    },
  );

const recordModelApplied = (run: RunRef, payload: JsonValue) =>
  appendRunEvent(run, { type: "workflow.model.applied", source: "orchestrate", payload });

// Runs after the Stop hook that found a model switch requested: switches the session's model,
// records how it went, and resumes the run. A failed switch is recorded, and next fails the stage.
export const runModelStep = async (options: ModelStepOptions): Promise<void> => {
  const { run, seq, terminal, log } = options;
  const lock = `model-${seq}`;
  if (!(await claimLock(run, lock))) return log.info({ seq }, "another helper has this switch");
  const runDir = runDirOf(run.cwd, run.name);
  const [state, events] = await Promise.all([readState(runDir), jsonlEventStore(runDir).read()]);
  const { pending } = foldModelSwitch(events, state?.tiers ?? null);
  if (pending?.seq !== seq) return log.info({ seq }, "no open model switch");
  const target = pickTierModel(pending);
  const switched: Result<void> =
    terminal === undefined
      ? { ok: false, error: "not inside tmux" }
      : await catchThrow(log, resumeOnModel(options, terminal, target));
  const request = { requestSeq: seq, node: pending.node, ...target };
  const stored = await recordModelApplied(
    run,
    switched.ok
      ? { ...request, applied: true }
      : { ...request, applied: false, reason: switched.error },
  );
  // Unstored, the request stays open; without its lock, the next stop's helper tries again.
  if (!stored.ok) {
    log.error({ err: stored.error, seq }, "model switch result not stored");
    await rm(runLockPath(runDir, lock), { force: true });
  }
  if (switched.ok) {
    return log.info({ target, sessionId: options.sessionId }, "session resumed on the new model");
  }
  log.error({ err: switched.error, target }, "model switch failed");
  if (terminal !== undefined) await resumeRun(run, terminal, log);
};
