import type { AgentType } from "../agent.ts";
import { emitRunEvent } from "../state.ts";
import { findEnvRun, type HookDeps } from "./common.ts";

export type SessionStartInput = Readonly<{
  agent: AgentType;
  sessionId: string;
  // why the session started: startup, clear, compact or resume
  source: string;
}>;

// One rule for a session starting, shared by every agent: it sees only the parsed input.
export type SessionStartHandler = Readonly<{
  name: string;
  run: (input: SessionStartInput, deps: HookDeps) => Promise<void>;
}>;

// A new session has a new id, so the run's other hooks would stop recognizing it until it is
// linked. This cannot use findSessionRun: the new id is not linked yet. A session starting is
// also the moment an open context node's action is done, so the node is completed here.
export const linkSession: SessionStartHandler = {
  name: "link-session",
  run: async (input, deps) => {
    const run = await findEnvRun(deps);
    if (run === undefined) return;
    const { agent, sessionId, source } = input;
    await deps.registry.linkSession(run.ref.id, { agent, sessionId });
    await emitRunEvent(run.ref, {
      type: "hooks.session-start.called",
      source: "hooks",
      payload: { agent, sessionId, source },
    });
    await deps.completeContextNode?.(run.ref, sessionId, source);
  },
};

export const sessionStartHandlers: Readonly<Record<string, SessionStartHandler>> =
  Object.fromEntries([linkSession].map((handler) => [handler.name, handler]));
