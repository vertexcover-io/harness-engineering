import type { AgentType, StopHook } from "@harness/sdk";
import { claudeStopHook } from "./claude-hooks.ts";

export {
  type ClaudeArgOptions,
  type ClaudeProviderOptions,
  claudeArgs,
  claudeProvider,
} from "./claude.ts";
export { claudeHookSettings, claudeStopHook, readClaudeTranscript } from "./claude-hooks.ts";

// Each agent's hook functions live in that agent's own file; this table is the one list of them.
export const HOOK_AGENTS = ["claude"] as const satisfies readonly AgentType[];
export type HookAgent = (typeof HOOK_AGENTS)[number];
export const stopHooks: Readonly<Record<HookAgent, StopHook>> = { claude: claudeStopHook };
