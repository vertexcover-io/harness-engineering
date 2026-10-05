import { claudeProvider } from "@yok/core";
import type { IAgentProvider, ITerminal, ITerminalHost } from "@yok/sdk";
import { noopLogger } from "@yok/sdk";

export const RULE = "─".repeat(40);
export const EMPTY_BOX = `${RULE}\n❯\n${RULE}\n  Model: Opus`;

export const fakeHost = (screen: string | (() => string), alive = true) => {
  const calls: string[] = [];
  const pane: ITerminal = {
    sendText: async (text) => {
      calls.push(`text:${text}`);
      return { ok: true, value: undefined };
    },
    sendKeys: async (keys) => {
      calls.push(`keys:${keys.join("+")}`);
      return { ok: true, value: undefined };
    },
    capture: async () => ({ ok: true, value: typeof screen === "string" ? screen : screen() }),
    isAlive: async () => alive,
    kill: async () => ({ ok: true, value: undefined }),
    rename: async () => ({ ok: true, value: undefined }),
    respawn: async () => ({ ok: true, value: undefined }),
    attachCommand: () => ["true"],
  };
  const host: ITerminalHost = {
    checks: [],
    create: async () => ({ ok: true, value: pane }),
    find: () => pane,
    list: async () => [],
  };
  return { host, calls };
};

// The real Claude provider over a fake pane, so delivery runs the same screen checks as in a run.
export const claudeOver = (host: ITerminalHost): IAgentProvider =>
  claudeProvider({ host, binary: "claude", log: noopLogger });
