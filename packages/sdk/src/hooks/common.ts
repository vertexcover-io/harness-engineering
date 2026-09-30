import type { AgentType } from "../agent.ts";
import type { RunRef } from "../events.ts";
import type { ILogger } from "../logger.ts";
import type { Registry } from "../registry.ts";
import type { PreToolUseHandler } from "./pre-tool-use.ts";
import type { StopHandler } from "./stop.ts";

export type HookDeps = Readonly<{
  registry: Registry;
  env: Readonly<Record<string, string | undefined>>;
  log: ILogger;
}>;

// What one agent answers: each takes the agent's raw hook input and the handler it was registered
// with, and returns the text to print. A hook the agent lacks prints nothing.
export type AgentAdapter = Readonly<{
  stop?: (stdin: string, deps: HookDeps, handler: StopHandler) => Promise<string>;
  preToolUse?: (stdin: string, deps: HookDeps, handler: PreToolUseHandler) => Promise<string>;
}>;

// The run this agent session belongs to, or undefined when it is not a harness run session.
export const findSessionRun = async (
  input: Readonly<{ agent: AgentType; sessionId: string }>,
  deps: HookDeps,
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
