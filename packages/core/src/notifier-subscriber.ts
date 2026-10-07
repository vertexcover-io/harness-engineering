import {
  NOTIFIER_SUBSCRIBER,
  type Notifier,
  SUBSCRIBER_TIMEOUT_S,
  type SubscriberRefs,
} from "@yok/sdk";
import { NOTIFIER_EVENTS, NOTIFIER_MODULE } from "./notifier.ts";

// A workflow's notifier block replaces the config's whole.
export const pickNotifier = (
  workflow: Notifier | undefined,
  config: Notifier | undefined,
): Notifier | undefined => workflow ?? config;

// One non-blocking `notifier` subscriber under each event type the notifier posts for, or none when off.
export const buildNotifierSubscribers = (notifier: Notifier | undefined): SubscriberRefs => {
  if (notifier?.enabled !== true) return {};
  const subscriber = {
    name: NOTIFIER_SUBSCRIBER,
    blocking: false,
    timeoutSeconds: SUBSCRIBER_TIMEOUT_S.detached,
    module: NOTIFIER_MODULE,
    handler: notifier.type,
  };
  return Object.fromEntries(NOTIFIER_EVENTS.map((type) => [type, [subscriber]]));
};
