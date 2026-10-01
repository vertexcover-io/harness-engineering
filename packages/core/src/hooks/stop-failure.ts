import type { StopFailureHandler } from "@harness/sdk";
import { appendRunEvent } from "@harness/sdk/internal";
import { startLimitWait } from "../limit-wait.ts";
import { findSessionRun } from "./common.ts";

export const resumeAfterLimit: StopFailureHandler = {
  name: "resume-after-limit",
  run: async (input, deps) => {
    if (!input.usageLimit) return;
    const run = await findSessionRun(input, deps);
    if (run === undefined) return;
    const { agent, sessionId, error, message } = input;
    const stored = await appendRunEvent(run, {
      type: "agent.limit.reached",
      source: "hooks",
      payload: { agent, sessionId, error, ...(message === undefined ? {} : { message }) },
    });
    if (!stored.ok) {
      deps.log.warn({ error: stored.error }, "stop-failure: the limit was not recorded");
      return;
    }
    startLimitWait(run, sessionId, stored.value.event.id);
  },
};

export const stopFailureHandlers: Readonly<Record<string, StopFailureHandler>> = Object.fromEntries(
  [resumeAfterLimit].map((handler) => [handler.name, handler]),
);
