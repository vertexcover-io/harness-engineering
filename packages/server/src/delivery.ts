import {
  deliveryMessage,
  findOpenContextRun,
  markDelivered,
  readComments,
  type WorkflowAgent,
  WorkflowAgentSchema,
} from "@harness/core";
import type { IAgentProvider, ILogger, ITerminalHost, State, WorkflowRun } from "@harness/sdk";
import { emitRunEvent, readState, runDirOf } from "@harness/sdk";
import type { Registry } from "@harness/sdk/internal";

export type DeliveryOutcome =
  | Readonly<{ kind: "delivered"; ids: readonly string[] }>
  | Readonly<{ kind: "waiting"; reason: string }>
  | Readonly<{ kind: "nothing" }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type DeliveryDeps = Readonly<{
  providerFor: (agent: WorkflowAgent) => IAgentProvider;
  host: ITerminalHost;
  log: ILogger;
  now: () => Date;
}>;
export type ScheduleDeps = DeliveryDeps & Readonly<{ registry: Registry }>;

const RETRY_MS = 2000;

const waiting = (reason: string): DeliveryOutcome => ({ kind: "waiting", reason });

// A state.json that does not parse reads as no state, so one bad engine write blanks nothing.
export const readStateOrNull = (runDir: string): Promise<State | null> =>
  readState(runDir).catch(() => null);

export const deliverComments = async (
  run: WorkflowRun,
  deps: DeliveryDeps,
): Promise<DeliveryOutcome> => {
  if (run.name === null) return waiting("run has no name yet");
  const runDir = runDirOf(run.cwd, run.name);
  const read = await readComments(runDir);
  if (!read.ok) return { kind: "failed", reason: read.error };
  const sent = read.value.comments.filter((c) => c.status === "sent");
  if (sent.length === 0) return { kind: "nothing" };

  // A session that is gone does not come back, so this is not retried; the next comment or reply
  // on the run tries again.
  const pane = run.terminal === null ? null : deps.host.find(run.terminal);
  if (pane === null || !(await pane.isAlive())) {
    return { kind: "failed", reason: "agent session is not running" };
  }
  const state = await readStateOrNull(runDir);
  if (state !== null && findOpenContextRun(state.nodeRuns) !== undefined) {
    return waiting("agent is clearing its context");
  }

  // The run's agent is the one its first session belongs to; the start hook links it.
  const agent = WorkflowAgentSchema.safeParse(run.sessions[0]?.agent);
  if (!agent.success) return waiting("agent session is not linked yet");
  const provider = deps.providerFor(agent.data);
  const message = deliveryMessage(sent, run.name);
  const typed = await provider.promptWhenReady(pane, message, { whileBusy: true });
  if (!typed.ok) return waiting(typed.error);
  if (typed.value === "not-ready") return waiting("agent has a menu open or text in its input box");
  const ids = sent.map((c) => c.id);
  const marked = await markDelivered(runDir, sent, deps.now());
  if (!marked.ok) return { kind: "failed", reason: marked.error };
  const logged = await emitRunEvent(
    { id: run.id, cwd: run.cwd, name: run.name },
    { type: "artifact.comment.delivered", source: "viewer", payload: { ids } },
  );
  if (!logged.ok)
    deps.log.error({ runId: run.id, error: logged.error }, "delivery event not logged");
  return { kind: "delivered", ids };
};

const outcomes = new Map<string, DeliveryOutcome>();
const retries = new Map<string, Timer>();
const attempts = new Map<string, Promise<void>>();

export const lastDelivery = (runId: string): DeliveryOutcome | undefined => outcomes.get(runId);

const attempt = async (runId: string, deps: ScheduleDeps): Promise<void> => {
  const run = await deps.registry.findRun(runId);
  if (run === undefined) return;
  const outcome = await deliverComments(run, deps);
  outcomes.set(runId, outcome);
  if (outcome.kind === "failed")
    deps.log.error({ runId, reason: outcome.reason }, "delivery failed");
  if (outcome.kind !== "waiting" || retries.has(runId)) return;
  retries.set(
    runId,
    setTimeout(() => {
      retries.delete(runId);
      void scheduleDelivery(runId, deps);
    }, RETRY_MS),
  );
};

// Attempts for one run queue behind each other so a batch posted mid-delivery is not typed twice;
// a run already waiting on a retry needs no second one. The last attempt in line clears the entry.
export const scheduleDelivery = (runId: string, deps: ScheduleDeps): Promise<void> => {
  if (retries.has(runId)) return Promise.resolve();
  const next: Promise<void> = (attempts.get(runId) ?? Promise.resolve())
    .then(() => attempt(runId, deps))
    .catch((error: unknown) => deps.log.error({ runId, err: error }, "delivery threw"))
    .finally(() => {
      if (attempts.get(runId) === next) attempts.delete(runId);
    });
  attempts.set(runId, next);
  return next;
};

export const resumeDeliveries = async (deps: ScheduleDeps): Promise<void> => {
  for (const run of await deps.registry.listRuns()) {
    if (run.name === null) continue;
    const read = await readComments(runDirOf(run.cwd, run.name));
    if (read.ok && read.value.comments.some((c) => c.status === "sent")) {
      void scheduleDelivery(run.id, deps);
    }
  }
};

export const stopDeliveries = (): void => {
  for (const timer of retries.values()) clearTimeout(timer);
  retries.clear();
};
