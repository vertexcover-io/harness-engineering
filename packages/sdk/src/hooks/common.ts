import type { AgentType } from "../agent.ts";
import type { RunRef } from "../events.ts";
import type { ILogger } from "../logger.ts";
import type { Registry, SessionRef } from "../registry.ts";
import type { PreToolUseHandler } from "./pre-tool-use.ts";
import type { SessionStartHandler } from "./session-start.ts";
import type { StopHandler } from "./stop.ts";

export type HookDeps = Readonly<{
  registry: Registry;
  env: Readonly<Record<string, string | undefined>>;
  log: ILogger;
  // starts the detached helper that carries out the open context node once the turn is over
  startContextStep?: (run: RunRef, sessionId: string, nodeRunId: string) => Promise<void>;
  // completes an open context node once a session start shows its action is done
  completeContextNode?: (run: RunRef, sessionId: string, source: string) => Promise<void>;
}>;

// What one agent answers: each takes the agent's raw hook input and the handler it was registered
// with, and returns the text to print. A hook the agent lacks prints nothing.
export type AgentAdapter = Readonly<{
  stop?: (stdin: string, deps: HookDeps, handler: StopHandler) => Promise<string>;
  sessionStart?: (stdin: string, deps: HookDeps, handler: SessionStartHandler) => Promise<string>;
  preToolUse?: (stdin: string, deps: HookDeps, handler: PreToolUseHandler) => Promise<string>;
}>;

// The initialized run that HARNESS_RUN_ID names, whichever session is asking. A session that
// starts before init has no named run yet.
export const findEnvRun = async (
  deps: HookDeps,
): Promise<Readonly<{ ref: RunRef; sessions: readonly SessionRef[] }> | undefined> => {
  const runId = deps.env.HARNESS_RUN_ID;
  if (!runId) return undefined;
  const run = await deps.registry.findRun(runId);
  if (run === undefined || run.name === null) return undefined;
  return { ref: { id: run.id, cwd: run.cwd, name: run.name }, sessions: run.sessions };
};

// The run this agent session belongs to, or undefined when it is not a harness run session.
export const findSessionRun = async (
  input: Readonly<{ agent: AgentType; sessionId: string }>,
  deps: HookDeps,
): Promise<RunRef | undefined> => {
  const run = await findEnvRun(deps);
  const linked = run?.sessions.some(
    (session) => session.agent === input.agent && session.sessionId === input.sessionId,
  );
  return linked ? run?.ref : undefined;
};
