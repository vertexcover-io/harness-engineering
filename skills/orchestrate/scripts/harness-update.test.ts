import assert from "node:assert/strict";
import { test } from "node:test";

import { planUpdate } from "./harness-update.ts";

const PRE_RELEASE_URL =
  "https://raw.githubusercontent.com/vertexcover-io/harness-engineering/main/.claude-plugin/pre-release/marketplace.json";
const stableMarketplace = { name: "main", source: "git", url: "https://github.com/vertexcover-io/harness-engineering.git" };
const preReleaseMarketplace = { name: "harness-pre-release", source: "url", url: PRE_RELEASE_URL };

test("planUpdate on the same channel only refreshes the marketplace and updates the plugin", () => {
  const plan = planUpdate({
    channel: "stable",
    plugins: [{ id: "harness@main", scope: "user" }],
    marketplaces: [stableMarketplace],
  });
  assert.deepEqual(plan, {
    ok: true,
    commands: [
      ["plugin", "marketplace", "update", "main"],
      ["plugin", "update", "harness@main", "--scope", "user"],
    ],
  });
});

test("planUpdate adds the pre-release marketplace once, installs from it, then drops the stable plugin", () => {
  const plan = planUpdate({
    channel: "pre-release",
    plugins: [{ id: "harness@main", scope: "project" }],
    marketplaces: [stableMarketplace],
  });
  assert.deepEqual(plan, {
    ok: true,
    commands: [
      ["plugin", "marketplace", "add", PRE_RELEASE_URL],
      ["plugin", "install", "harness@harness-pre-release", "--scope", "project"],
      ["plugin", "uninstall", "harness@main", "--scope", "project"],
    ],
  });
});

test("planUpdate back to stable reuses the marketplace that is already there", () => {
  const plan = planUpdate({
    channel: "stable",
    plugins: [{ id: "harness@harness-pre-release", scope: "user" }],
    marketplaces: [stableMarketplace, preReleaseMarketplace],
  });
  assert.deepEqual(plan, {
    ok: true,
    commands: [
      ["plugin", "marketplace", "update", "main"],
      ["plugin", "install", "harness@main", "--scope", "user"],
      ["plugin", "uninstall", "harness@harness-pre-release", "--scope", "user"],
    ],
  });
});

test("planUpdate refuses a harness that is not installed as a plugin", () => {
  const plan = planUpdate({ channel: "stable", plugins: [{ id: "notion@claude-plugins-official" }], marketplaces: [] });
  assert.equal(plan.ok, false);
});

test("planUpdate refuses a local checkout, which an install from GitHub would replace", () => {
  const plan = planUpdate({
    channel: "pre-release",
    plugins: [{ id: "harness@harness", scope: "user" }],
    marketplaces: [{ name: "harness", source: "directory", path: "/src/harness-engineering" }],
  });
  assert.equal(plan.ok, false);
  assert.match(plan.ok ? "" : plan.error, /\/src\/harness-engineering/);
});
