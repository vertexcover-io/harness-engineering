import type {
  AgentAdapter,
  IAgentProvider,
  ILogger,
  ITerminalHost,
  SessionRef,
} from "@harness/sdk";
import { type WorkflowAgent, WorkflowAgentSchema } from "../workflow/types.ts";
import { claudeProvider } from "./claude.ts";
import { claudeAdapter } from "./claude-hooks.ts";
import { codexProvider } from "./codex.ts";
import { codexAdapter } from "./codex-hooks.ts";

export const HOOK_AGENTS = WorkflowAgentSchema.options;
export type HookAgent = WorkflowAgent;
export const agentAdapters: Readonly<Record<WorkflowAgent, AgentAdapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

export type AgentProviderOptions = Readonly<{
  agent: WorkflowAgent;
  host: ITerminalHost;
  env: Readonly<Record<string, string | undefined>>;
  log: ILogger;
}>;

type ProviderBuild = (options: Omit<AgentProviderOptions, "agent">) => IAgentProvider;

const providers: Readonly<Record<WorkflowAgent, ProviderBuild>> = {
  claude: ({ host, env, log }) =>
    claudeProvider({ host, binary: env.HARNESS_CLAUDE_BIN ?? "claude", log }),
  codex: ({ host, env, log }) =>
    codexProvider({ host, binary: env.HARNESS_CODEX_BIN ?? "codex", log }),
};

export const agentProvider = ({ agent, ...options }: AgentProviderOptions): IAgentProvider =>
  providers[agent](options);

export const findSessionAgent = (
  sessions: readonly SessionRef[],
  sessionId: string,
): WorkflowAgent | undefined => {
  const agent = sessions.find((session) => session.sessionId === sessionId)?.agent;
  const parsed = WorkflowAgentSchema.safeParse(agent);
  return parsed.success ? parsed.data : undefined;
};
