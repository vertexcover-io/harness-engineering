#!/usr/bin/env node --experimental-strip-types
// Moves the installed harness plugin to the tag its channel's marketplace pins, switching
// marketplaces when the channel changes.
// Usage: harness-update.ts <stable|pre-release>
// Exits 0 once updated, 1 when a claude command fails, 2 when this install cannot be updated from here.

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Channel = "stable" | "pre-release";

// Must match the names in .claude-plugin/marketplace.json and .claude-plugin/pre-release/marketplace.json.
const CHANNELS: Record<Channel, { readonly marketplace: string; readonly source: string }> = {
  stable: { marketplace: "main", source: "https://github.com/vertexcover-io/harness-engineering.git" },
  "pre-release": {
    marketplace: "harness-pre-release",
    source: "https://raw.githubusercontent.com/vertexcover-io/harness-engineering/main/.claude-plugin/pre-release/marketplace.json",
  },
};

type Installed = {
  readonly channel: Channel;
  readonly plugins: readonly unknown[];
  readonly marketplaces: readonly unknown[];
};

type Plan =
  | { readonly ok: true; readonly commands: readonly (readonly string[])[] }
  | { readonly ok: false; readonly error: string };

const text = (value: unknown, key: string): string | null => {
  if (typeof value !== "object" || value === null) return null;
  const found: unknown = Reflect.get(value, key);
  return typeof found === "string" ? found : null;
};

const parseList = (json: string | null): readonly unknown[] => {
  try {
    const parsed: unknown = JSON.parse(json ?? "");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const isChannel = (value: string | undefined): value is Channel => value === "stable" || value === "pre-release";

export const planUpdate = ({ channel, plugins, marketplaces }: Installed): Plan => {
  const plugin = plugins.find((entry) => text(entry, "id")?.startsWith("harness@") === true);
  const id = text(plugin, "id");
  if (id === null) return { ok: false, error: "harness is not installed as a plugin: run /plugin install harness@main first" };
  const current = id.slice("harness@".length);
  const currentMarketplace = marketplaces.find((entry) => text(entry, "name") === current);
  if (text(currentMarketplace, "source") === "directory") {
    const path = text(currentMarketplace, "path") ?? current;
    return { ok: false, error: `harness loads from the local checkout ${path}: update that checkout instead` };
  }

  const scope = text(plugin, "scope") ?? "user";
  const { marketplace, source } = CHANNELS[channel];
  const refresh = ["plugin", "marketplace", "update", marketplace];
  if (current === marketplace) {
    return { ok: true, commands: [refresh, ["plugin", "update", id, "--scope", scope]] };
  }
  const known = marketplaces.some((entry) => text(entry, "name") === marketplace);
  return {
    ok: true,
    commands: [
      known ? refresh : ["plugin", "marketplace", "add", source],
      // Install before uninstalling, so a failed install leaves the old harness in place.
      ["plugin", "install", `harness@${marketplace}`, "--scope", scope],
      ["plugin", "uninstall", id, "--scope", scope],
    ],
  };
};

const capture = (args: readonly string[]): string | null => {
  try {
    return execFileSync("claude", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};

const step = (args: readonly string[]): boolean => {
  console.log(`$ claude ${args.join(" ")}`);
  try {
    execFileSync("claude", args, { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
};

export const main = (argv: readonly string[]): number => {
  const channel = argv[0];
  if (!isChannel(channel)) {
    console.error("usage: harness-update.ts <stable|pre-release>");
    return 2;
  }
  const plan = planUpdate({
    channel,
    plugins: parseList(capture(["plugin", "list", "--json"])),
    marketplaces: parseList(capture(["plugin", "marketplace", "list", "--json"])),
  });
  if (!plan.ok) {
    console.error(`UPDATE_REFUSED ${plan.error}`);
    return 2;
  }
  for (const args of plan.commands) {
    if (!step(args)) {
      console.error(`UPDATE_FAILED claude ${args.join(" ")}`);
      return 1;
    }
  }
  console.log(`UPDATED harness on ${channel}. Run /reload-plugins, then start orchestrate again.`);
  return 0;
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  process.exitCode = main(process.argv.slice(2));
}
