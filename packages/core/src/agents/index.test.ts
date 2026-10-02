import { describe, expect, test } from "bun:test";
import { noopLogger } from "@harness/sdk";
import { agentProvider, findSessionAgent } from "./index.ts";
import { harnessTerminalHost } from "./tmux.ts";

describe("findSessionAgent", () => {
  const sessions = [
    { agent: "claude" as const, sessionId: "c1" },
    { agent: "codex" as const, sessionId: "x1" },
    { agent: "pi" as const, sessionId: "p1" },
  ];

  test("a linked session gives its own agent, codex included", () => {
    expect(findSessionAgent(sessions, "x1")).toBe("codex");
    expect(findSessionAgent(sessions, "c1")).toBe("claude");
  });

  test("an unlinked session, or one whose agent has no provider, gives undefined", () => {
    expect(findSessionAgent(sessions, "nope")).toBeUndefined();
    expect(findSessionAgent(sessions, "p1")).toBeUndefined();
  });
});

describe("agentProvider", () => {
  test("each workflow agent gets a provider of its own type", () => {
    const host = harnessTerminalHost({}, noopLogger);
    for (const agent of ["claude", "codex"] as const) {
      expect(agentProvider({ agent, host, env: {}, log: noopLogger }).type).toBe(agent);
    }
  });
});
