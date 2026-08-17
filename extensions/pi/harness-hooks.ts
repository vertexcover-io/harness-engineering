import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { run as askUserHook } from "../../skills/orchestrate/dashboard/ask-user-hook.mjs";
import { run as dagUpdate } from "../../skills/orchestrate/dashboard/dag-update.mjs";


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

export default function registerHarnessHooks(pi: ExtensionAPI): void {
  pi.on("agent_end", async (_event, ctx): Promise<void> => {
    await swallow(ctx, "ask-user:pre", () => askUserHook(["pre"]));
  });

  pi.on("input", async (_event, ctx): Promise<void> => {
    await swallow(ctx, "ask-user:post", () => askUserHook(["post"]));
  });

  pi.on("session_shutdown", async (_event, ctx): Promise<void> => {
    await swallow(ctx, "dag:finalize", () => dagUpdate(["finalize", "interrupted"]));
  });
}
