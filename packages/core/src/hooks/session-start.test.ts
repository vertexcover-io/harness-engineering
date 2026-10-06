import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger, registryPath, runDirOf, type WorkflowRun } from "@harness/sdk";
import { createRegistry, jsonlEventStore } from "@harness/sdk/internal";
import { linkSession } from "./session-start.ts";

const setup = async (name: string | null) => {
  const home = mkdtempSync(join(tmpdir(), "harness-session-start-"));
  const cwd = mkdtempSync(join(tmpdir(), "harness-session-start-repo-"));
  const run: WorkflowRun = {
    id: "r-1",
    workflow: "demo",
    workflowPath: join(cwd, "demo.yaml"),
    inputs: {},
    cwd,
    sessions: [],
    name,
    terminal: null,
    config: null,
    tiers: null,
    createdAt: new Date().toISOString(),
  };
  const registry = createRegistry(registryPath(home), noopLogger);
  await registry.addRun(run);
  if (name !== null) mkdirSync(runDirOf(cwd, name), { recursive: true });
  const deps = { registry, env: { HARNESS_RUN_ID: "r-1", HARNESS_HOME: home }, log: noopLogger };
  return { registry, deps, events: () => jsonlEventStore(runDirOf(cwd, name ?? "none")).read() };
};

const input = { agent: "codex", sessionId: "s1", source: "startup" } as const;

describe("link-session", () => {
  test("SC3: a session starting before init is linked to its pending run and records no event", async () => {
    const { registry, deps, events } = await setup(null);

    await linkSession.run(input, deps);

    expect((await registry.findRun("r-1"))?.sessions).toEqual([
      { agent: "codex", sessionId: "s1" },
    ]);
    expect(await events()).toEqual([]);
  });

  test("SC3: a session starting on a named run is linked and records the session-start event", async () => {
    const { registry, deps, events } = await setup("feat-x");

    await linkSession.run(input, deps);

    expect((await registry.findRun("r-1"))?.sessions).toEqual([
      { agent: "codex", sessionId: "s1" },
    ]);
    expect(await events()).toMatchObject([
      { type: "hooks.session-start.called", payload: { agent: "codex", sessionId: "s1" } },
    ]);
  });
});
