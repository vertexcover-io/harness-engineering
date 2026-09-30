import type { AgentAdapter, AgentType } from "@harness/sdk";
import { claudeAdapter } from "./claude-hooks.ts";

export {
  type ClaudeArgOptions,
  type ClaudeProviderOptions,
  claudeArgs,
  claudeProvider,
} from "./claude.ts";
export { claudeAdapter, claudeHookSettings, readClaudeTranscript } from "./claude-hooks.ts";

// Each agent's hooks live in that agent's own file; this table is the one list of them.
export const HOOK_AGENTS = ["claude"] as const satisfies readonly AgentType[];
export type HookAgent = (typeof HOOK_AGENTS)[number];
export const agentAdapters: Readonly<Record<HookAgent, AgentAdapter>> = { claude: claudeAdapter };
