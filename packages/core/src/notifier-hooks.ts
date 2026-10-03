import { HOOK_TIMEOUT_S, type HookRefs, NOTIFIER_HOOK, type Notifier } from "@harness/sdk";
import { NOTIFIER_EVENTS, NOTIFIER_MODULE } from "./notifier.ts";

// A workflow's notifier block replaces the config's whole.
export const pickNotifier = (
  workflow: Notifier | undefined,
  config: Notifier | undefined,
): Notifier | undefined => workflow ?? config;

// One non-blocking `notifier` hook under each event type the notifier posts for, or none when off.
export const buildNotifierHooks = (notifier: Notifier | undefined): HookRefs => {
  if (notifier?.enabled !== true) return {};
  const hook = {
    name: NOTIFIER_HOOK,
    blocking: false,
    timeoutSeconds: HOOK_TIMEOUT_S.detached,
    module: NOTIFIER_MODULE,
    handler: notifier.type,
  };
  return Object.fromEntries(NOTIFIER_EVENTS.map((type) => [type, [hook]]));
};
