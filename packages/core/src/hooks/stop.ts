import {
  type EmitInput,
  type HookDeps,
  type HookReply,
  type NodeRun,
  type RunRef,
  runDirOf,
  type State,
  type StopHandler,
  type StopInput,
  type StopReason,
  type TranscriptEntry,
} from "@harness/sdk";
import { appendRunEvent, jsonlEventStore, readState } from "@harness/sdk/internal";
import { startContextStep } from "../context-step.ts";
import { orchestrateCommand } from "../runs.ts";
import { findSessionRun } from "./common.ts";

export const DEFAULT_STOP_MAX_BLOCKS = 1;
// `bun run orchestrate next` or `bun …/orchestrate.ts done`, but not a path like orchestrate-v2/SKILL.md
const ORCHESTRATE = /\borchestrate(?:\.ts)?\s+(?:init|link-session|emit|baseline|next|exec|done)\b/;
const ASK_RULE = "If you need the user's input, ask with AskUserQuestion.";

const ALLOW: HookReply = { kind: "allow" };

type ActiveLeaf = Readonly<{ nodeId: string; nodeRunId: string; nodeType: NodeRun["nodeType"] }>;

export type StopCheck = Readonly<{
  run: RunRef;
  state: State;
  touchedRun: boolean | undefined;
  // whether anything but a hook's own log happened since the last Stop check
  progressSinceCheck: boolean;
  maxBlocks: number;
}>;

// `blockStreak` is the blocks in a row at this spot, counting this call when it blocks. A decision
// with a message sends the agent back to work; one without lets the turn end.
export type StopDecision =
  | Readonly<{
      reason: Extract<StopReason, "run-finished" | "user-chat" | "max-blocks-reached">;
      blockStreak: number;
    }>
  | Readonly<{ reason: "context-node"; blockStreak: number; nodeRunId: string }>
  | Readonly<{ reason: "next-not-run"; blockStreak: number; message: string }>
  | Readonly<{ reason: "node-not-done"; blockStreak: number; message: string; nodeRunId: string }>;

type Position =
  | Readonly<{ kind: "finished" }>
  | Readonly<{ kind: "open-node"; leaf: ActiveLeaf }>
  | Readonly<{ kind: "between-nodes" }>;

// A loop, switch or include stays running while it waits between children, so the node being
// worked on is the running entry of any other type.
const CONTAINERS: ReadonlySet<NodeRun["nodeType"]> = new Set(["loop", "switch", "include"]);

const findActiveLeaf = (nodeRuns: Readonly<Record<string, NodeRun>>): ActiveLeaf | undefined => {
  for (const [nodeId, run] of Object.entries(nodeRuns)) {
    if (run.status !== "running") continue;
    if (!CONTAINERS.has(run.nodeType)) {
      return { nodeId, nodeRunId: run.nodeRunId, nodeType: run.nodeType };
    }
    if (run.nodes === undefined) continue;
    const child = findActiveLeaf(run.nodes);
    if (child !== undefined) return child;
  }
  return undefined;
};

const touchedRunSinceLastPrompt = (
  entries: readonly TranscriptEntry[] | undefined,
): boolean | undefined => {
  if (entries === undefined) return undefined;
  const last = entries.findLastIndex((entry) => entry.kind === "prompt");
  if (last === -1) return undefined;
  return entries
    .slice(last + 1)
    .some((entry) => entry.kind === "command" && ORCHESTRATE.test(entry.command));
};

const maxBlocksOf = (env: HookDeps["env"]): number => {
  const maxBlocks = Number(env.HARNESS_STOP_MAX_BLOCKS);
  return Number.isInteger(maxBlocks) && maxBlocks > 0 ? maxBlocks : DEFAULT_STOP_MAX_BLOCKS;
};

const priorBlocks = (state: State, progressSinceCheck: boolean): number =>
  state.stopHook === undefined || progressSinceCheck ? 0 : state.stopHook.blockStreak;

// Progress is any event after the last check except the hooks' own logs, which only observe the run.
const progressSince = async (runDir: string, seq: number | undefined): Promise<boolean> => {
  if (seq === undefined) return false;
  const events = await jsonlEventStore(runDir).read();
  return events.some((event) => event.seq > seq && !event.type.startsWith("hooks."));
};

const nextMessage = (run: RunRef): string =>
  `Harness run ${run.name} is not finished. Run \`${orchestrateCommand({ verb: "next", run })}\` ` +
  `and do the step it prints, as the orchestrate-v2 skill says. ${ASK_RULE}`;

// next hands out an exec or wait node for the agent to run with exec, and an agent node for it to
// do and then record with done; done refuses an exec node, so each gets its own command.
const openNodeMessage = (run: RunRef, leaf: ActiveLeaf): string => {
  const { nodeId, nodeRunId } = leaf;
  if (leaf.nodeType === "agent") {
    const done = orchestrateCommand({ verb: "done", run, nodeRunId });
    return (
      `Harness run ${run.name}: node ${nodeId} is still open. Finish the node's work and record ` +
      `it with \`${done} --output -\` (or \`--error -\`). ${ASK_RULE}`
    );
  }
  const exec = orchestrateCommand({ verb: "exec", run, nodeRunId });
  return (
    `Harness run ${run.name}: step ${nodeId} is still open. If you have not run it yet, run ` +
    `\`${exec}\`. If it is already running as a background task, wait for that task to finish. ` +
    ASK_RULE
  );
};

const positionOf = (state: State): Position => {
  if (state.status !== "running") return { kind: "finished" };
  const leaf = findActiveLeaf(state.nodeRuns);
  return leaf === undefined ? { kind: "between-nodes" } : { kind: "open-node", leaf };
};

export const decideStop = ({
  run,
  state,
  touchedRun,
  progressSinceCheck,
  maxBlocks,
}: StopCheck): StopDecision => {
  const prior = priorBlocks(state, progressSinceCheck);
  const position = positionOf(state);
  if (position.kind === "finished") return { reason: "run-finished", blockStreak: prior };
  // A context node's work starts once the turn is over, so the stop is the cue, not a lapse.
  if (position.kind === "open-node" && position.leaf.nodeType === "context") {
    return { reason: "context-node", blockStreak: prior, nodeRunId: position.leaf.nodeRunId };
  }
  if (position.kind === "between-nodes" && touchedRun === false)
    return { reason: "user-chat", blockStreak: prior };
  if (prior >= maxBlocks) return { reason: "max-blocks-reached", blockStreak: prior };
  if (position.kind === "between-nodes") {
    return { reason: "next-not-run", blockStreak: prior + 1, message: nextMessage(run) };
  }
  const { leaf } = position;
  return {
    reason: "node-not-done",
    blockStreak: prior + 1,
    message: openNodeMessage(run, leaf),
    nodeRunId: leaf.nodeRunId,
  };
};

const replyOf = (decision: StopDecision): HookReply =>
  "message" in decision ? { kind: "continue", message: decision.message } : ALLOW;

const stopCalledEvent = (
  input: StopInput,
  check: StopCheck,
  decision: StopDecision,
): EmitInput => ({
  type: "hooks.stop.called",
  source: "hooks",
  payload: {
    agent: input.agent,
    sessionId: input.sessionId,
    touchedRun: check.touchedRun ?? null,
    decision: replyOf(decision).kind,
    reason: decision.reason,
    blockStreak: decision.blockStreak,
    ...("message" in decision ? { message: decision.message } : {}),
    ...("nodeRunId" in decision ? { nodeRunId: decision.nodeRunId } : {}),
  },
});

// Only a turn between nodes reads touchedRun, so only then is the transcript worth reading.
const readTouchedRun = async (input: StopInput, state: State): Promise<boolean | undefined> =>
  positionOf(state).kind === "between-nodes"
    ? touchedRunSinceLastPrompt(await input.readTranscript())
    : undefined;

// A helper that cannot start is logged, and the stop is still allowed: a hook must not trap the session.
const startHelper = async (
  run: RunRef,
  input: StopInput,
  nodeRunId: string,
  deps: HookDeps,
): Promise<void> => {
  try {
    await startContextStep(run, input.sessionId, nodeRunId);
  } catch (error) {
    deps.log.error({ err: error }, "context step helper not started");
  }
};

// Decides whether the agent may end its turn and logs the call as hooks.stop.called. It never
// throws: a hook that fails must let the turn end, or it could trap the session.
export const runStopHook = async (input: StopInput, deps: HookDeps): Promise<HookReply> => {
  try {
    const run = await findSessionRun(input, deps);
    if (run === undefined) {
      deps.log.debug({ sessionId: input.sessionId }, "stop allowed: not a harness run session");
      return ALLOW;
    }
    const runDir = runDirOf(run.cwd, run.name);
    const state = await readState(runDir);
    if (state === null) return ALLOW;
    const [touchedRun, progressSinceCheck] = await Promise.all([
      readTouchedRun(input, state),
      progressSince(runDir, state.stopHook?.seq),
    ]);
    const check = { run, state, touchedRun, progressSinceCheck, maxBlocks: maxBlocksOf(deps.env) };
    const decision = decideStop(check);
    const stored = await appendRunEvent(run, stopCalledEvent(input, check, decision));
    if (!stored.ok) {
      // An unrecorded block would reset the count, so it could block forever.
      deps.log.warn({ error: stored.error }, "stop allowed: the hook call was not recorded");
      return ALLOW;
    }
    if (decision.reason === "context-node") {
      await startHelper(run, input, decision.nodeRunId, deps);
    }
    return replyOf(decision);
  } catch (error) {
    deps.log.error({ err: error }, "stop allowed: the stop hook failed");
    return ALLOW;
  }
};

// Keeps a workflow run moving: sends the agent back when it stops with work still owed.
export const continueWorkflow: StopHandler = { name: "continue-workflow", run: runStopHook };

// The handlers an agent can register, by the name `orchestrate hook stop --handler` takes.
export const stopHandlers: Readonly<Record<string, StopHandler>> = Object.fromEntries(
  [continueWorkflow].map((handler) => [handler.name, handler]),
);

// Runs one Stop handler. It never throws: a handler that fails lets the turn end, or it could
// trap the session.
export const runStop = (
  input: StopInput,
  handler: StopHandler,
  deps: HookDeps,
): Promise<HookReply> =>
  handler.run(input, deps).catch((error: unknown): HookReply => {
    deps.log.error({ err: error }, `stop allowed: ${handler.name} failed`);
    return ALLOW;
  });
