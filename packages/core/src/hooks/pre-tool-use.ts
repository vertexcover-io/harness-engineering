import { homedir } from "node:os";
import { join } from "node:path";
import {
  type EmitInput,
  type HookDeps,
  harnessHome,
  type PreToolUseHandler,
  registryPath,
  spawn,
  type ToolCall,
  type ToolUse,
  type ToolVerdict,
} from "@harness/sdk";
import { appendRunEvent } from "@harness/sdk/internal";
import { findSessionRun, recordSessionEvent } from "./common.ts";
import { expandPath, type PathBase, shellWriteTargets } from "./write-targets.ts";

export type ProtectedRecord =
  | Readonly<{ kind: "state" | "events"; runName: string; path: string }>
  | Readonly<{ kind: "registry"; path: string }>;

const ALLOW: ToolVerdict = { kind: "allow" };
const RUN_RECORD = /[\\/]\.harness[\\/]([^\\/]+)[\\/](state\.json|event\.jsonl)$/;
const BASH_ANTIPATTERNS = join(import.meta.dir, "..", "..", "vendor", "bash-antipatterns.sh");
const BASH_ANTIPATTERNS_TIMEOUT_MS = 10_000;

export const protectedRecordOf = (path: string, base: PathBase): ProtectedRecord | undefined => {
  const abs = expandPath(path, base);
  if (abs === undefined) return undefined;
  if (abs === registryPath(base.harnessHome)) return { kind: "registry", path: abs };
  const match = RUN_RECORD.exec(abs);
  const runName = match?.[1];
  if (runName === undefined) return undefined;
  return { kind: match?.[2]?.startsWith("state") ? "state" : "events", runName, path: abs };
};

const recordMessage = (record: ProtectedRecord): string => {
  if (record.kind === "registry") {
    return (
      `${record.path} is the harness registry, so this call was refused. It changes only ` +
      "through `bun run orchestrate init NAME` and " +
      "`bun run orchestrate link-session --run NAME --agent AGENT --session-id ID`. " +
      "Reading it is fine."
    );
  }
  const run = record.runName;
  return (
    `${record.path} is written only by the orchestrate script, so this call was refused. ` +
    `Move the run with \`bun run orchestrate next --run ${run}\`, record a node with ` +
    `\`bun run orchestrate exec|done NODE_RUN_ID --run ${run}\`, and add an event with ` +
    `\`bun run orchestrate emit TYPE --run ${run} --source SKILL\`. Reading the file is fine.`
  );
};

const callTargets = (call: ToolCall, base: PathBase): readonly string[] => {
  if (call.kind === "file-write") return [call.path];
  return call.kind === "shell" ? shellWriteTargets(call.command, base) : [];
};

// Refuses a call that writes, moves or deletes a run's state.json or event.jsonl, or the registry.
export const recordGuard: PreToolUseHandler = {
  name: "record-guard",
  run: async ({ cwd, call }, { env }) => {
    const base = { cwd, home: homedir(), harnessHome: harnessHome(env) };
    const record = callTargets(call, base)
      .map((target) => protectedRecordOf(target, base))
      .find((found) => found !== undefined);
    return record === undefined
      ? ALLOW
      : { kind: "deny", message: recordMessage(record), path: record.path };
  },
};

// The vendored script reads a Claude-shaped Bash payload and refuses with exit 2, so any agent's
// shell command is handed to it in that shape. Any other failure allows the call, with a warning.
export const bashAntipatterns: PreToolUseHandler = {
  name: "bash-antipatterns",
  run: async ({ cwd, call }, { log }) => {
    if (call.kind !== "shell") return ALLOW;
    const input = JSON.stringify({ tool_name: "Bash", tool_input: { command: call.command } });
    const result = await spawn("bash", [BASH_ANTIPATTERNS], {
      cwd,
      input,
      timeoutMs: BASH_ANTIPATTERNS_TIMEOUT_MS,
    });
    if (result.code === 2 && result.stopped === null) {
      return { kind: "deny", message: result.stderr.trim() || "Refused by bash-antipatterns.sh" };
    }
    if (result.code !== 0 || result.stopped !== null) {
      const { code, stopped, stderr } = result;
      log.warn(
        { code, stopped, stderr: stderr.slice(0, 500) },
        "bash-antipatterns.sh failed; allowed",
      );
    }
    return ALLOW;
  },
};

// Records the questions an agent puts to the person, so the notifier can post them.
export const questionNotice: PreToolUseHandler = {
  name: "question-notice",
  run: async ({ agent, sessionId, toolUseId, call }, deps) => {
    if (call.kind !== "question") return ALLOW;
    const payload = {
      agent,
      sessionId,
      ...(toolUseId === undefined ? {} : { toolUseId }),
      questions: call.questions.map(({ header, ...question }) =>
        header === undefined ? question : { ...question, header },
      ),
    };
    await recordSessionEvent({ agent, sessionId }, { type: "agent.question.asked", payload }, deps);
    return ALLOW;
  },
};

// The handlers an agent can register, by the name `orchestrate hook pre-tool-use --handler` takes.
export const preToolUseHandlers: Readonly<Record<string, PreToolUseHandler>> = Object.fromEntries(
  [recordGuard, bashAntipatterns, questionNotice].map((handler) => [handler.name, handler]),
);

const calledEvent = (use: ToolUse, handler: string, verdict: ToolVerdict): EmitInput => ({
  type: "hooks.pre-tool-use.called",
  source: "hooks",
  payload: {
    agent: use.agent,
    sessionId: use.sessionId,
    tool: use.toolName,
    handler,
    decision: verdict.kind,
    ...(verdict.kind === "deny" ? { message: verdict.message } : {}),
    ...(verdict.kind === "deny" && verdict.path !== undefined ? { path: verdict.path } : {}),
  },
});

const logCall = async (
  use: ToolUse,
  handler: string,
  verdict: ToolVerdict,
  deps: HookDeps,
): Promise<void> => {
  try {
    const run = await findSessionRun(use, deps);
    if (run === undefined) return;
    const stored = await appendRunEvent(run, calledEvent(use, handler, verdict));
    if (!stored.ok) deps.log.warn({ error: stored.error }, "pre-tool-use call not recorded");
  } catch (error) {
    deps.log.warn({ err: error }, "pre-tool-use call not recorded");
  }
};

// A handler that fails lets the call through, or it could trap the session.
export const runPreToolUse = async (
  use: ToolUse,
  handler: PreToolUseHandler,
  deps: HookDeps,
): Promise<ToolVerdict> => {
  const verdict = await handler.run(use, deps).catch((error: unknown): ToolVerdict => {
    deps.log.error({ err: error }, `pre-tool-use allowed: ${handler.name} failed`);
    return ALLOW;
  });
  if (verdict.kind === "allow") return verdict;
  await logCall(use, handler.name, verdict, deps);
  return verdict;
};
