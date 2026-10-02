import {
  type AgentType,
  type HookDeps,
  type HookReply,
  parseJson,
  type Result,
  type RunRef,
  type SessionRef,
  type ToolVerdict,
} from "@harness/sdk";
import * as z from "zod";

// The initialized run that HARNESS_RUN_ID names, whichever session is asking. A session that
// starts before init has no named run yet.
export const findEnvRun = async (
  deps: HookDeps,
): Promise<Readonly<{ ref: RunRef; sessions: readonly SessionRef[] }> | undefined> => {
  const runId = deps.env.HARNESS_RUN_ID;
  if (!runId) return undefined;
  const run = await deps.registry.findRun(runId);
  if (run === undefined || run.name === null) return undefined;
  return { ref: { id: run.id, cwd: run.cwd, name: run.name }, sessions: run.sessions };
};

// The run this agent session belongs to, or undefined when it is not a harness run session.
export const findSessionRun = async (
  input: Readonly<{ agent: AgentType; sessionId: string }>,
  deps: HookDeps,
): Promise<RunRef | undefined> => {
  const run = await findEnvRun(deps);
  const linked = run?.sessions.some(
    (session) => session.agent === input.agent && session.sessionId === input.sessionId,
  );
  return linked ? run?.ref : undefined;
};

export const parseStdin = <T>(stdin: string, schema: z.ZodType<T>): Result<T> => {
  const json = parseJson(stdin);
  if (!json.ok) return { ok: false, error: `hook input: ${json.error}` };
  const parsed = schema.safeParse(json.value);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
};

// The agent ends the turn on empty output, and keeps going with `reason` on a block (Claude and Codex agree).
export const stopReply = (reply: HookReply): string =>
  reply.kind === "allow" ? "" : `${JSON.stringify({ decision: "block", reason: reply.message })}\n`;

type NoReplyHook<AgentInput, HandlerInput> = Readonly<{
  stdin: string;
  deps: HookDeps;
  // the hook's name in log lines
  event: string;
  schema: z.ZodType<AgentInput>;
  toHandlerInput: (parsed: AgentInput) => HandlerInput;
  handler: Readonly<{ name: string; run: (input: HandlerInput, deps: HookDeps) => Promise<void> }>;
}>;

// For hooks that send the agent no reply (SessionStart, StopFailure). Bad input or a failing handler
// is only logged: a hook that throws could break the session.
export const runNoReplyHook = async <AgentInput, HandlerInput>(
  hook: NoReplyHook<AgentInput, HandlerInput>,
): Promise<string> => {
  const { deps, event, handler } = hook;
  const parsed = parseStdin(hook.stdin, hook.schema);
  if (!parsed.ok) {
    deps.log.warn({ error: parsed.error }, `${event} ignored: hook input not understood`);
    return "";
  }
  await handler.run(hook.toHandlerInput(parsed.value), deps).catch((error: unknown) => {
    deps.log.error({ err: error }, `${event}: ${handler.name} failed`);
  });
  return "";
};

// The agent runs its own permission prompt on empty output, so a call is never answered "allow".
export const preToolUseReply = (verdict: ToolVerdict): string =>
  verdict.kind === "allow"
    ? ""
    : `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.message,
        },
      })}\n`;
