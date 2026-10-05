import type { PostToolUseHandler } from "@yok/sdk";
import { recordSessionEvent } from "./common.ts";

// Records the person's answers to the agent's questions.
export const answerNotice: PostToolUseHandler = {
  name: "answer-notice",
  run: async (input, deps) => {
    if (input.result.kind !== "answers") return;
    const { agent, sessionId, toolUseId } = input;
    const payload = {
      agent,
      sessionId,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      answers: input.result.answers.map(({ notes, ...answer }) =>
        notes === undefined ? answer : { ...answer, notes },
      ),
    };
    await recordSessionEvent(input, { type: "agent.question.answered", payload }, deps);
  },
};

// The handlers an agent can register, by the name `orchestrate hook post-tool-use --handler` takes.
export const postToolUseHandlers: Readonly<Record<string, PostToolUseHandler>> = Object.fromEntries(
  [answerNotice].map((handler) => [handler.name, handler]),
);
