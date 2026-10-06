import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@harness/sdk";
import { noopLogger, registryPath, runDirOf, type StopFailureInput } from "@harness/sdk";
import { createRegistry, jsonlEventStore } from "@harness/sdk/internal";
import { ORCHESTRATE_SCRIPT } from "../stage.ts";
import { resumeAfterLimit } from "./stop-failure.ts";

const setUp = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hooks-home-")));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "hooks-repo-")));
  const registry = createRegistry(registryPath(home));
  await registry.addRun({
    id: "r-1",
    workflow: "feature",
    workflowPath: join(cwd, "workflow.yaml"),
    inputs: {},
    cwd,
    sessions: [{ agent: "claude", sessionId: "s1" }],
    name: "feat-x",
    terminal: null,
    config: null,
    tiers: null,
    createdAt: "2026-09-26T10:00:00Z",
  });
  const runDir = runDirOf(cwd, "feat-x");
  await mkdir(runDir, { recursive: true });
  const deps = { registry, env: { HARNESS_RUN_ID: "r-1" }, log: noopLogger };
  return { runDir, cwd, deps };
};

const failure = (error: string, sessionId = "s1"): StopFailureInput => ({
  agent: "claude",
  sessionId,
  error,
  usageLimit: error !== "overloaded",
  message: "You've hit your limit · resets 3pm (Asia/Kolkata)",
});

describe("resumeAfterLimit", () => {
  // The wait is a detached orchestrate process, so the spawn is the boundary these tests stop at.
  let spawn: ReturnType<typeof spyOn<typeof sdk, "spawnDetached">>;
  beforeAll(() => {
    spawn = spyOn(sdk, "spawnDetached");
  });
  beforeEach(() => spawn.mockImplementation(() => 0));
  afterEach(() => spawn.mockReset());
  afterAll(() => spawn.mockRestore());

  test("a usage limit in a run session is logged as agent.limit.reached and starts the limit wait for that event", async () => {
    const { runDir, cwd, deps } = await setUp();
    await resumeAfterLimit.run(failure("rate_limit"), deps);
    const [event] = await jsonlEventStore(runDir).read();
    expect(event).toMatchObject({
      type: "agent.limit.reached",
      payload: {
        agent: "claude",
        sessionId: "s1",
        error: "rate_limit",
        message: "You've hit your limit · resets 3pm (Asia/Kolkata)",
      },
    });
    const id = event?.id ?? "";
    expect(spawn.mock.calls).toEqual([
      [
        process.execPath,
        [ORCHESTRATE_SCRIPT, "limit-wait", id, "--run-id", "r-1", "--session-id", "s1"],
        { cwd, output: "ignore" },
      ],
    ]);
  });

  test("the agent's usageLimit flag, not its error name, starts the wait", async () => {
    const { deps } = await setUp();
    await resumeAfterLimit.run(failure("usage_limit_reached"), deps);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["an error that is not a usage limit, such as overloaded", failure("overloaded")],
    ["a session not linked to the run", failure("rate_limit", "other")],
  ])("%s logs nothing and starts no wait", async (_, input) => {
    const { runDir, deps } = await setUp();
    await resumeAfterLimit.run(input, deps);
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  });
});
