import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { run as askUserHook } from "../../skills/orchestrate/dashboard/ask-user-hook.mjs";
import { run as dagUpdate } from "../../skills/orchestrate/dashboard/dag-update.mjs";
import { run as coderE2eGate } from "../../hooks/coder-e2e-gate.mjs";

const BLOCK_EXIT_CODE = 2;

const notifyFailure = (ctx: ExtensionContext, label: string, detail: string): void => {
  ctx.ui.notify(`harness hook ${label} failed: ${detail}`, "warning");
};

const swallow = async (
  ctx: ExtensionContext,
  label: string,
  fn: () => Promise<{ exitCode: number; stderr?: string }>,
): Promise<void> => {
  try {
    const { exitCode, stderr } = await fn();
    if (exitCode !== 0) notifyFailure(ctx, label, stderr ?? `exit ${exitCode}`);
  } catch (err) {
    notifyFailure(ctx, label, err instanceof Error ? err.message : String(err));
  }
};

const runGate = (ctx: ExtensionContext): void => {
  try {
    const { exitCode, stdout } = coderE2eGate([], ctx.cwd);
    if (exitCode === BLOCK_EXIT_CODE) {
      ctx.ui.notify(stdout.trim() || "coder e2e gate blocked", "error");
    }
  } catch (err) {
    notifyFailure(ctx, "coder-e2e-gate", err instanceof Error ? err.message : String(err));
  }
};

export default function registerHarnessHooks(pi: ExtensionAPI): void {
  pi.on("agent_end", async (_event, ctx): Promise<void> => {
    await swallow(ctx, "ask-user:pre", () => askUserHook(["pre"]));
    runGate(ctx);
  });

  pi.on("input", async (_event, ctx): Promise<void> => {
    await swallow(ctx, "ask-user:post", () => askUserHook(["post"]));
  });

  pi.on("session_shutdown", async (_event, ctx): Promise<void> => {
    await swallow(ctx, "dag:finalize", () => dagUpdate(["finalize", "interrupted"]));
  });
}
