import type { AgentType, HookDeps, RunRef, SessionRef } from "@harness/sdk";

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
