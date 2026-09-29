import type { AgentType } from "./agent.ts";
import type { NodeRun, State } from "./contracts.ts";
import { type EmitInput, type RunRef, runDirOf, type StopReason } from "./events.ts";
import type { ILogger } from "./logger.ts";
import type { Registry } from "./registry.ts";
import { orchestrateCommand } from "./runs.ts";
import { emitRunEvent, readState } from "./state.ts";

export const DEFAULT_STOP_MAX_BLOCKS = 1;
// `bun run orchestrate next` or `bun …/orchestrate.ts done`, but not a path like orchestrate-v2/SKILL.md
const ORCHESTRATE = /\borchestrate(?:\.ts)?\s+(?:init|link-session|emit|baseline|next|exec|done)\b/;
const ASK_RULE = "If you need the user's input, ask with AskUserQuestion.";

export type HookReply =
  | { readonly kind: "allow" }
  | { readonly kind: "continue"; readonly message: string };
const ALLOW: HookReply = { kind: "allow" };

// One step of a session, in order: a message the user typed, or a shell command the agent ran.
export type TranscriptEntry =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "command"; readonly command: string };

export type StopInput = Readonly<{
  agent: AgentType;
  sessionId: string;
  // undefined when the transcript is missing or cannot be read
  readTranscript: () => Promise<readonly TranscriptEntry[] | undefined>;
}>;

export type StopHookDeps = Readonly<{
  registry: Registry;
  env: Readonly<Record<string, string | undefined>>;
  log: ILogger;
}>;

// One per agent: takes the agent's raw hook input and returns the text to print for it.
export type StopHook = (stdin: string, deps: StopHookDeps) => Promise<string>;

type ActiveLeaf = Readonly<{ nodeId: string; nodeRunId: string; nodeType: NodeRun["nodeType"] }>;

export type StopCheck = Readonly<{
  run: RunRef;
  state: State;
  touchedRun: boolean | undefined;
  maxBlocks: number;
}>;

// `blockStreak` is the blocks in a row at this spot, counting this call when it blocks. A decision
// with a message sends the agent back to work; one without lets the turn end.
export type StopDecision =
  | Readonly<{
      reason: Extract<StopReason, "run-finished" | "user-chat" | "max-blocks-reached">;
      blockStreak: number;
    }>
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

const maxBlocksOf = (env: StopHookDeps["env"]): number => {
  const maxBlocks = Number(env.HARNESS_STOP_MAX_BLOCKS);
  return Number.isInteger(maxBlocks) && maxBlocks > 0 ? maxBlocks : DEFAULT_STOP_MAX_BLOCKS;
};

// Every call is logged, so nothing happened since the last call exactly when that call's own
// event is still the newest one.
const priorBlocks = (state: State): number =>
  state.stopHook?.seq === state.lastEventSeq ? state.stopHook.blockStreak : 0;

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

export const decideStop = ({ run, state, touchedRun, maxBlocks }: StopCheck): StopDecision => {
  const prior = priorBlocks(state);
  const position = positionOf(state);
  if (position.kind === "finished") return { reason: "run-finished", blockStreak: prior };
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

const findSessionRun = async (
  input: StopInput,
  deps: StopHookDeps,
): Promise<RunRef | undefined> => {
  const runId = deps.env.HARNESS_RUN_ID;
  if (!runId) return undefined;
  const run = await deps.registry.findRun(runId);
  if (run === undefined || run.name === null) return undefined;
  const linked = run.sessions.some(
    (session) => session.agent === input.agent && session.sessionId === input.sessionId,
  );
  return linked ? { id: run.id, cwd: run.cwd, name: run.name } : undefined;
};

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

// Decides whether the agent may end its turn and logs the call as hooks.stop.called. It never
// throws: a hook that fails must let the turn end, or it could trap the session.
export const runStopHook = async (input: StopInput, deps: StopHookDeps): Promise<HookReply> => {
  try {
    const run = await findSessionRun(input, deps);
    if (run === undefined) {
      deps.log.debug({ sessionId: input.sessionId }, "stop allowed: not a harness run session");
      return ALLOW;
    }
    const state = await readState(runDirOf(run.cwd, run.name));
    if (state === null) return ALLOW;
    const touchedRun = await readTouchedRun(input, state);
    const check = { run, state, touchedRun, maxBlocks: maxBlocksOf(deps.env) };
    const decision = decideStop(check);
    const stored = await emitRunEvent(run, stopCalledEvent(input, check, decision));
    if (!stored.ok) {
      // An unrecorded block would reset the count, so it could block forever.
      deps.log.warn({ error: stored.error }, "stop allowed: the hook call was not recorded");
      return ALLOW;
    }
    return replyOf(decision);
  } catch (error) {
    deps.log.error({ err: error }, "stop allowed: the stop hook failed");
    return ALLOW;
  }
};
