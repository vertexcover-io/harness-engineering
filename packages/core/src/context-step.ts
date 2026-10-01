import { randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CLAUDE_CLEAR_INPUT_KEY,
  CLAUDE_NOTHING_TO_COMPACT,
  currentPane,
  isClaudeBusy,
  type PaneTarget,
  typeLine,
} from "@harness/agents";
import {
  ContextStartedEvent,
  emitRunEvent,
  type IAgentProvider,
  type ILogger,
  type JsonValue,
  jsonlEventStore,
  type LaunchOptions,
  type NodeRun,
  type Registry,
  type Result,
  type RunRef,
  readState,
  runDirOf,
  runLockPath,
} from "@harness/sdk";
import { completeContextStep, findContextPlanNode } from "./runs.ts";

const IDLE_TIMEOUT_MS = 30_000;
const IDLE_POLL_MS = 100;
const DONE_POLL_MS = 250;
// how long a new session may take to start, and a compact to finish, before the step fails
const DONE_TIMEOUT_MS = { new: 60_000, compact: 180_000 } as const;

export type ContextStepOptions = Readonly<{
  run: RunRef;
  nodeRunId: string;
  // the session whose turn just ended, which a new session replaces
  oldSessionId: string;
  // undefined when the helper was not started inside a tmux pane
  paneTarget: PaneTarget | undefined;
  registry: Registry;
  provider: IAgentProvider;
  // how the agent was launched; relaunching adds the resume prompt
  launch: Omit<LaunchOptions, "prompt">;
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

const waitForIdle = ({ terminal, pane }: PaneTarget): Promise<Result<true>> =>
  pollUntil(
    { everyMs: IDLE_POLL_MS, timeoutMs: IDLE_TIMEOUT_MS, timeoutError: "Claude did not go idle" },
    async () => {
      const screen = await terminal.capture(pane);
      if (!screen.ok) return screen;
      return { ok: true, value: isClaudeBusy(screen.value) ? undefined : true };
    },
  );

const typeInto = ({ terminal, pane }: PaneTarget, text: string) => typeLine(terminal, pane, text);

const resumePrompt = (run: RunRef): string => `/orchestrate-v2 --resume ${run.name}`;

// A tmux call can throw (a hung tmux times out) and so can reading a half-written event line. The
// helper runs detached, so a throw would end it silently and leave the node open for good: it
// becomes a failed step, logged with its stack.
const catchThrow = <T>(log: ILogger, step: Promise<Result<T>>): Promise<Result<T>> =>
  step.catch((error: unknown): Result<T> => {
    log.error({ err: error }, "context step threw");
    return { ok: false, error: error instanceof Error ? error.message : "context step threw" };
  });

// The Stop hook starts a helper on every stop while the node is open; only the first one to
// create this node run's lock file goes ahead.
const claimNode = async ({ run, nodeRunId }: ContextStepOptions): Promise<boolean> => {
  const lock = runLockPath(runDirOf(run.cwd, run.name), `context-${nodeRunId}`);
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
  emitRunEvent(run, {
    type: "workflow.session.replaced",
    source: "orchestrate",
    payload: { agent: "claude", previousSessionId, sessionId },
  });

const recordStarted = (
  { run, nodeRunId }: ContextStepOptions,
  action: "new" | "compact",
  sessionId: string,
): Promise<unknown> =>
  emitRunEvent(run, {
    type: "workflow.context.started",
    source: "orchestrate",
    payload: { nodeRunId, action, sessionId },
  });

// The SessionStart hook records success (completeContextOnSessionStart); the helper only watches
// for failure: no SessionStart in time, or a compact Claude refuses.
const watchForFailure = (
  { run, nodeRunId }: ContextStepOptions,
  paneTarget: PaneTarget,
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
      const screen = await paneTarget.terminal.capture(paneTarget.pane);
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
  paneTarget: PaneTarget,
): Promise<Result<void>> => {
  const { run, registry, provider, oldSessionId, log } = options;
  const idle = await waitForIdle(paneTarget);
  if (!idle.ok) return idle;
  const sessionId = randomUUID();
  await registry.linkSession(run.id, { agent: "claude", sessionId });
  await replaceSession(options, oldSessionId, sessionId);
  await recordStarted(options, "new", sessionId);
  const launch = { ...options.launch, prompt: resumePrompt(run) };
  const relaunched = await catchThrow(log, provider.relaunch(paneTarget.pane, sessionId, launch));
  if (!relaunched.ok) {
    await replaceSession(options, sessionId, oldSessionId);
    return relaunched;
  }
  log.info({ sessionId }, "Claude relaunched on a new session");
  const done = await watchForFailure(options, paneTarget, "new");
  if (!done.ok) return done;
  log.info({ sessionId }, "node completed by the new session's SessionStart");
  return { ok: true, value: undefined };
};

const compact = async (
  options: ContextStepOptions,
  paneTarget: PaneTarget,
  prompt: string | undefined,
): Promise<Result<void>> => {
  const { oldSessionId, log } = options;
  const idle = await waitForIdle(paneTarget);
  if (!idle.ok) return idle;
  await recordStarted(options, "compact", oldSessionId);
  const command = prompt === undefined ? "/compact" : `/compact ${prompt}`;
  const typed = await typeInto(paneTarget, command);
  if (!typed.ok) return typed;
  log.info({ command }, "compact typed");
  const done = await watchForFailure(options, paneTarget, "compact");
  if (!done.ok) return done;
  log.info({}, "node completed by the compact's SessionStart");
  return { ok: true, value: undefined };
};

const findOpenContextRun = (nodeRuns: Readonly<Record<string, NodeRun>>): NodeRun | undefined => {
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
  paneTarget: PaneTarget | undefined = currentPane(),
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
  if (!completed.ok || started.action !== "compact" || paneTarget === undefined) return;
  await typeLine(paneTarget.terminal, paneTarget.pane, resumePrompt(run));
};

// A step that did not happen still completes, and the old session carries on: the input box is
// emptied (a cancelled /compact stays in it and would swallow the prompt) and the run resumed.
const recover = async (
  options: ContextStepOptions,
  paneTarget: PaneTarget,
  action: string,
  reason: string,
): Promise<void> => {
  const { run, log } = options;
  log.error({ action, reason }, "context step not applied");
  const completed = await catchThrow(log, complete(options, { action, applied: false, reason }));
  if (!completed.ok) log.error({ err: completed.error }, "context node not completed");
  const emptied = await catchThrow(
    log,
    paneTarget.terminal.sendKeys(paneTarget.pane, [CLAUDE_CLEAR_INPUT_KEY]),
  );
  if (!emptied.ok) log.warn({ err: emptied.error }, "input box not emptied");
  const idle = await catchThrow(log, waitForIdle(paneTarget));
  if (!idle.ok)
    log.warn({ err: idle.error }, "typing the resume prompt although Claude looks busy");
  const typed = await catchThrow(log, typeInto(paneTarget, resumePrompt(run)));
  if (!typed.ok) log.error({ err: typed.error }, "resume prompt not typed");
};

// Runs after the Stop hook that found a context node open: starts a new session in the agent's
// pane, or compacts the one it has, then lets the run carry on.
export const runContextStep = async (options: ContextStepOptions): Promise<void> => {
  const { run, nodeRunId, paneTarget, log } = options;
  if (!(await claimNode(options))) return log.info({ nodeRunId }, "another helper has this node");
  const planNode = await findContextPlanNode(run, nodeRunId);
  if (!planNode.ok) return log.info({ nodeRunId, reason: planNode.error }, "no open context node");
  const { action, prompt } = planNode.value;
  log.info({ nodeRunId, action }, "context step started");
  if (paneTarget === undefined) {
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
    action === "new" ? startNewSession(options, paneTarget) : compact(options, paneTarget, prompt),
  );
  if (!outcome.ok) await recover(options, paneTarget, action, outcome.error);
};
