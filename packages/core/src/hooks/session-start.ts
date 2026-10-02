import { harnessHome, registryPath, type SessionStartHandler } from "@harness/sdk";
import { appendRunEvent, createRegistry } from "@harness/sdk/internal";
import { completeContextOnSessionStart } from "../context-step.ts";

// Links by HARNESS_RUN_ID even before `init` names the run: an agent's first SessionStart comes
// before it runs `init`.
export const linkSession: SessionStartHandler = {
  name: "link-session",
  run: async (input, deps) => {
    const runId = deps.env.HARNESS_RUN_ID;
    if (!runId) return;
    const run = await deps.registry.findRun(runId);
    if (run === undefined) return;
    const { agent, sessionId, source } = input;
    // HookDeps only reads the registry; linking a session is this hook's own write.
    const registry = createRegistry(registryPath(harnessHome(deps.env)), deps.log);
    await registry.linkSession(run.id, { agent, sessionId });
    if (run.name === null) return;
    const ref = { id: run.id, cwd: run.cwd, name: run.name };
    await appendRunEvent(ref, {
      type: "hooks.session-start.called",
      source: "hooks",
      payload: { agent, sessionId, source },
    });
    await completeContextOnSessionStart(ref, sessionId, source);
  },
};

export const sessionStartHandlers: Readonly<Record<string, SessionStartHandler>> =
  Object.fromEntries([linkSession].map((handler) => [handler.name, handler]));
