import {
  type AgentType,
  type Event,
  type IAgentProvider,
  type ILogger,
  type ITerminal,
  LimitReachedEvent,
  type LimitWaitingEvent,
  type RunRef,
  runDirOf,
} from "@harness/sdk";
import { appendRunEvent, jsonlEventStore } from "@harness/sdk/internal";
import * as z from "zod";
import { spawnOrchestrateHelper } from "./stage.ts";

// With no reset time to read, a retry that hits the limit again schedules the next wait.
const FALLBACK_WAIT_MS = 15 * 60_000;
// 20 fallback waits cover a 5-hour window; past that the limit is one waiting cannot clear,
// such as missing usage credits.
const MAX_LIMITS_IN_A_ROW = 20;
const CHECK_EVERY_MS = 60_000;
const CONTINUE = "continue";

export type LimitWaitOptions = Readonly<{
  run: RunRef;
  sessionId: string;
  // the agent.limit.reached event this wait answers
  limitEventId: string;
  // the agent for each kind the run may use; the limit event says which one stopped
  agents: Readonly<Partial<Record<AgentType, IAgentProvider>>>;
  // the agent's terminal; undefined when the helper cannot reach it
  terminal: ITerminal | undefined;
  log: ILogger;
}>;

type Wait = Readonly<{ ms: number; from: z.infer<typeof LimitWaitingEvent>["payload"]["from"] }>;

const sessionOf = (event: Event): string | undefined =>
  z.looseObject({ payload: z.looseObject({ sessionId: z.string() }) }).safeParse(event).data
    ?.payload.sessionId;

const isActivity = (event: Event): boolean =>
  event.type.startsWith("hooks.") || event.type === "agent.limit.reached";

// The session's hook calls and limit hits, in order.
const sessionActivity = (events: readonly Event[], sessionId: string): readonly Event[] =>
  events.filter((event) => isActivity(event) && sessionOf(event) === sessionId);

const limitsInARow = (activity: readonly Event[]): number =>
  activity.length - 1 - activity.findLastIndex((event) => event.type !== "agent.limit.reached");

// After this wait's limit: the session's own activity, or any session starting, which means the
// terminal may now hold another session, as after /clear.
const movedOn = (events: readonly Event[], sessionId: string, limitEventId: string): boolean =>
  events
    .slice(events.findIndex((event) => event.id === limitEventId) + 1)
    .some(
      (event) =>
        event.type === "hooks.session-start.called" ||
        (isActivity(event) && sessionOf(event) === sessionId),
    );

// False once the session has moved on.
const sleepUnlessMovedOn = async (
  until: number,
  hasMovedOn: () => Promise<boolean>,
): Promise<boolean> => {
  for (let left = until - Date.now(); left > 0; left = until - Date.now()) {
    await Bun.sleep(Math.min(left, CHECK_EVERY_MS));
    if (await hasMovedOn()) return false;
  }
  return !(await hasMovedOn());
};

export const startLimitWait = (run: RunRef, sessionId: string, limitEventId: string): void =>
  spawnOrchestrateHelper({ command: "limit-wait", id: limitEventId, run, sessionId });

// Started detached when an agent hits a usage limit: waits until the limit resets, then has the
// agent continue in its terminal.
export const runLimitWait = async (options: LimitWaitOptions): Promise<void> => {
  const { run, sessionId, limitEventId, terminal, log } = options;
  const store = jsonlEventStore(runDirOf(run.cwd, run.name));
  const activity = sessionActivity(await store.read(), sessionId);
  const limit = LimitReachedEvent.safeParse(activity.find((event) => event.id === limitEventId));
  const agent = limit.success ? options.agents[limit.data.payload.agent] : undefined;
  if (terminal === undefined)
    return log.warn({ sessionId }, "limit wait: no terminal to type into");
  if (agent === undefined) return log.warn({ sessionId }, "limit wait: no provider for the agent");
  if (limitsInARow(activity) > MAX_LIMITS_IN_A_ROW)
    return log.warn({ sessionId }, "limit wait: gave up after too many limits in a row");
  const now = new Date();
  const message = limit.data?.payload.message ?? "";
  const wait: Wait = (await agent.limitResetWait(terminal, message, now)) ?? {
    ms: FALLBACK_WAIT_MS,
    from: "fallback",
  };
  const resumeAt = now.getTime() + wait.ms;
  await appendRunEvent(run, {
    type: "agent.limit.waiting",
    source: "orchestrate",
    payload: {
      sessionId,
      limitEventId,
      resumeAt: new Date(resumeAt).toISOString(),
      from: wait.from,
    },
  });
  log.info({ sessionId, resumeAt, from: wait.from }, "limit wait started");
  const hasMovedOn = async () => movedOn(await store.read(), sessionId, limitEventId);
  if (!(await sleepUnlessMovedOn(resumeAt, hasMovedOn)))
    return log.info({ sessionId }, "limit wait: the session moved on");
  const prompted = await agent.promptWhenReady(terminal, CONTINUE);
  if (!prompted.ok) return log.error({ error: prompted.error }, "limit wait: continue not typed");
  if (prompted.value === "not-ready")
    return log.info({ sessionId }, "limit wait: the agent is not at an empty input");
  await appendRunEvent(run, {
    type: "agent.limit.resumed",
    source: "orchestrate",
    payload: { sessionId, limitEventId },
  });
  log.info({ sessionId }, "limit wait: continue typed");
};
