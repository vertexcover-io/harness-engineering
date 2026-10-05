import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { AgentType } from "./agent.ts";
import type { EnvLayer } from "./config.ts";
import type { Result } from "./contracts.ts";
import { readIfExists, readText } from "./files.ts";
import { prependPath } from "./process.ts";
import { type CheckoutConfig, findConfigRoot, findRoot } from "./runs.ts";

// The checkout's own .env if it has one, else the main checkout's; the two are never merged.
// A repo inside a meta repo looks in the folder findConfigRoot picks.
const readEnvFile = async (cwd: string): Promise<string | null> => {
  const folder = await findConfigRoot(cwd);
  const own = await readIfExists(join(folder.ok ? folder.value : cwd, ".env"));
  if (own !== null) return own;
  const main = await findRoot(cwd);
  return main.ok ? readIfExists(join(main.value, ".env")) : null;
};

// Read on every call so a long-running process never sees stale values. A key the file sets
// wins; otherwise the process environment supplies it.
export const readProjectEnv = async (cwd: string, key: string): Promise<string | undefined> =>
  parseEnv((await readEnvFile(cwd)) ?? "")[key] ?? process.env[key];

const parseEnvFile = (content: string): Record<string, string> =>
  Object.fromEntries(
    Object.entries(parseEnv(content)).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

const readNamedEnvFile = async (path: string): Promise<Result<Record<string, string>>> => {
  const content = await readText(path);
  return content.ok ? { ok: true, value: parseEnvFile(content.value) } : content;
};

// Variables an agent CLI reads itself. From an app's env file they would swap the user's login
// for the app's key or send the agent's traffic to the app's gateway, so only env sets them.
const AGENT_OWN_PREFIXES: Readonly<Record<AgentType, readonly string[]>> = {
  claude: ["ANTHROPIC_", "CLAUDE_", "NODE_OPTIONS"],
  codex: ["OPENAI_", "CODEX_"],
  pi: [],
  opencode: [],
};

const withoutAgentOwn = (
  file: Readonly<Record<string, string>>,
  agent: AgentType,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(file).filter(
      ([key]) => !AGENT_OWN_PREFIXES[agent].some((prefix) => key.startsWith(prefix)),
    ),
  );

const readLayer = async (
  layer: EnvLayer,
  dir: string,
  agent: AgentType,
): Promise<Result<Record<string, string>>> => {
  if (layer.envFile === undefined) return { ok: true, value: { ...layer.env } };
  const file = await readNamedEnvFile(resolve(dir, layer.envFile));
  return file.ok
    ? { ok: true, value: { ...withoutAgentOwn(file.value, agent), ...layer.env } }
    : file;
};

// The one place a run's env is put together, from the project's .env, then the config's envFile
// and env, then the workflow's: a later layer wins. agent is the one the session launches; the
// config's envFile resolves against its folder, the workflow's against cwd.
export const loadEnv = async (
  checkout: CheckoutConfig,
  workflow: EnvLayer & Readonly<{ agent: AgentType }>,
  cwd: string,
): Promise<Result<Record<string, string>>> => {
  const { agent } = workflow;
  const [project, config, own] = await Promise.all([
    readEnvFile(cwd),
    readLayer(checkout.config, checkout.root, agent),
    readLayer(workflow, cwd, agent),
  ]);
  if (!config.ok) return config;
  if (!own.ok) return own;
  const projectEnv = withoutAgentOwn(parseEnvFile(project ?? ""), agent);
  return { ok: true, value: { ...projectEnv, ...config.value, ...own.value } };
};

// What a run's agent session starts with: the run's env, under yok's own variables, with the
// shim folder first on PATH so the session's `yok` is the program that started the run.
export const sessionEnv = (
  env: Readonly<Record<string, string>>,
  runId: string,
  home: string,
  shimDir: string,
): Record<string, string> => ({
  ...env,
  PATH: prependPath(shimDir, env.PATH ?? process.env.PATH),
  YOK_RUN_ID: runId,
  YOK_HOME: home,
});
