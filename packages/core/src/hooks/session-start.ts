import type { SessionStartHandler } from "@harness/sdk";
import { appendRunEvent } from "@harness/sdk/internal";
import { completeContextOnSessionStart } from "../context-step.ts";
import { findEnvRun } from "./common.ts";

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
    await appendRunEvent(run.ref, {
      type: "hooks.session-start.called",
      source: "hooks",
      payload: { agent, sessionId, source },
    });
    await completeContextOnSessionStart(run.ref, sessionId, source);
  },
};

export const sessionStartHandlers: Readonly<Record<string, SessionStartHandler>> =
  Object.fromEntries([linkSession].map((handler) => [handler.name, handler]));
