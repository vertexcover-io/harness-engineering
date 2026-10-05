import { notifierHooks } from "@yok/core";
import * as sdk from "@yok/sdk";
import { plugin } from "bun";
import * as zod from "zod";

// A project's schemas, verifiers and hooks import these, often from a folder with no
// node_modules: the program answers with its own copies, so they share its one zod.
export const SERVED_MODULES: Readonly<Record<string, Record<string, unknown>>> = {
  "@yok/sdk": sdk,
  zod,
  "yok:notifier": notifierHooks,
};

export const serveModules = (): void => {
  plugin({
    name: "yok-served-modules",
    setup: (build) => {
      for (const [name, exports] of Object.entries(SERVED_MODULES)) {
        build.module(name, () => ({ exports, loader: "object" }));
      }
    },
  });
};
