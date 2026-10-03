import type { StopFailureHandler, StopFailureInput } from "@harness/sdk";
import { startLimitWait } from "../limit-wait.ts";
import { recordSessionEvent } from "./common.ts";

const buildErrorPayload = ({ agent, sessionId, error, message }: StopFailureInput) => ({
  agent,
  sessionId,
  error,
  ...(message === undefined ? {} : { message }),
});

export const resumeAfterLimit: StopFailureHandler = {
  name: "resume-after-limit",
  run: async (input, deps) => {
    if (!input.usageLimit) return;
    const event = { type: "agent.limit.reached", payload: buildErrorPayload(input) };
    const recorded = await recordSessionEvent(input, event, deps);
    if (recorded === undefined) return;
    startLimitWait(recorded.run, input.sessionId, recorded.event.id);
  },
};

// A usage limit is resume-after-limit's; any other error stops the agent until a person acts.
export const recordAgentError: StopFailureHandler = {
  name: "record-agent-error",
  run: async (input, deps) => {
    if (input.usageLimit) return;
    await recordSessionEvent(
      input,
      { type: "agent.stopped", payload: buildErrorPayload(input) },
      deps,
    );
  },
};

export const stopFailureHandlers: Readonly<Record<string, StopFailureHandler>> = Object.fromEntries(
  [resumeAfterLimit, recordAgentError].map((handler) => [handler.name, handler]),
);
