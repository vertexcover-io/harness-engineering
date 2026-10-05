import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComments, readComments } from "@yok/core";
import type { WorkflowRun } from "@yok/sdk";
import { noopLogger, runDirOf } from "@yok/sdk";
import { createRegistry } from "@yok/sdk/internal";
import { deliverComments, lastDelivery, scheduleDelivery, stopDeliveries } from "./delivery.ts";
import { claudeOver, EMPTY_BOX, fakeHost } from "./fake-host.ts";

const MENU = `${EMPTY_BOX}\nEnter to select · ↑/↓ to navigate · Esc to cancel`;
const NOW = new Date("2026-01-01T00:00:00.000Z");

const setup = async (overrides: Partial<WorkflowRun> = {}) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-delivery-")));
  const run: WorkflowRun = {
    id: "r-1",
    workflow: "w",
    workflowPath: "/w.yaml",
    inputs: {},
    cwd,
    sessions: [{ agent: "claude", sessionId: "s1" }],
    name: "demo",
    terminal: "s1",
    config: null,
    tiers: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
  const runDir = runDirOf(cwd, "demo");
  mkdirSync(runDir, { recursive: true });
  await addComments(
    runDir,
    [
      { file: "artifacts/a.md", kind: "global", text: "one" },
      { file: "artifacts/a.md", kind: "global", text: "two" },
    ],
    NOW,
  );
  return { run, runDir };
};

const statuses = async (runDir: string): Promise<string[]> => {
  const read = await readComments(runDir);
  return read.ok ? read.value.comments.map((c) => c.status) : [];
};

describe("deliverComments", () => {
  test("SC23: two sent comments are typed once, submitted once, marked delivered and logged", async () => {
    const { run, runDir } = await setup();
    const { host, calls } = fakeHost(EMPTY_BOX);

    const outcome = await deliverComments(run, {
      providerFor: () => claudeOver(host),
      host,
      log: noopLogger,
      now: () => NOW,
    });

    expect(outcome).toEqual({ kind: "delivered", ids: ["c1", "c2"] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("2 new comments");
    expect(calls[1]).toBe("keys:Enter");
    const read = await readComments(runDir);
    expect(read.ok && read.value.comments.map((c) => [c.status, c.deliveredAt])).toEqual([
      ["delivered", NOW.toISOString()],
      ["delivered", NOW.toISOString()],
    ]);
    const events = readFileSync(join(runDir, "event.jsonl"), "utf8").trim().split("\n");
    const delivered = events
      .map((e) => JSON.parse(e))
      .filter((e) => e.type === "artifact.comment.delivered");
    expect(delivered.map((e) => e.payload)).toEqual([{ ids: ["c1", "c2"] }]);
  });

  test("SC24: delivery waits with its own reason and changes nothing when typing is unsafe", async () => {
    const contextRunning = async () => {
      const made = await setup();
      writeFileSync(
        join(made.runDir, "state.json"),
        JSON.stringify({
          schemaVersion: 1,
          lastEventSeq: 0,
          runId: "r-1",
          runName: "demo",
          runDir: made.runDir,
          version: "1",
          workflow: { name: "w", path: "artifacts/w.yaml" },
          input: {},
          scope: null,
          startedAt: NOW.toISOString(),
          completedAt: null,
          status: "running",
          workspace: {
            type: "mono",
            path: made.run.cwd,
            repositories: {
              r: { path: made.run.cwd, git: { branch: "b", baseBranch: "main", startSha: "s" } },
            },
          },
          tiers: null,
          nodeRuns: {
            c: {
              nodeRunId: "n1",
              nodeType: "context",
              status: "running",
              startedAt: null,
              completedAt: null,
              artifacts: [],
            },
          },
        }),
      );
      return made;
    };
    const cases = [
      [await setup({ name: null }), EMPTY_BOX, true, "run has no name yet"],
      [await contextRunning(), EMPTY_BOX, true, "agent is clearing its context"],
      [await setup(), MENU, true, "agent has a menu open or text in its input box"],
    ] as const;

    for (const [{ run, runDir }, screen, alive, reason] of cases) {
      const { host, calls } = fakeHost(screen, alive);
      const outcome = await deliverComments(run, {
        providerFor: () => claudeOver(host),
        host,
        log: noopLogger,
        now: () => NOW,
      });
      expect(outcome).toEqual({ kind: "waiting", reason });
      expect(calls).toEqual([]);
      expect(await statuses(runDir)).toEqual(["sent", "sent"]);
    }
  });

  test("a session that is gone fails delivery without retrying, and changes nothing", async () => {
    for (const [made, alive] of [
      [await setup({ terminal: null }), true],
      [await setup(), false],
    ] as const) {
      const { host, calls } = fakeHost(EMPTY_BOX, alive);
      const deps = { providerFor: () => claudeOver(host), host, log: noopLogger, now: () => NOW };
      const outcome = await deliverComments(made.run, deps);
      expect(outcome).toEqual({ kind: "failed", reason: "agent session is not running" });
      expect(calls).toEqual([]);
      expect(await statuses(made.runDir)).toEqual(["sent", "sent"]);
    }
  });
});

describe("scheduleDelivery", () => {
  afterEach(stopDeliveries);

  const scheduled = async (screen: () => string) => {
    const made = await setup();
    const registry = createRegistry(join(made.run.cwd, "registry.json"), noopLogger);
    await registry.addRun(made.run);
    const { host, calls } = fakeHost(screen);
    const deps = {
      registry,
      providerFor: () => claudeOver(host),
      host,
      log: noopLogger,
      now: () => NOW,
    };
    return { ...made, deps, calls };
  };

  test("a batch held back by a menu is typed once the menu closes, without a new request", async () => {
    let screen = MENU;
    const { run, runDir, deps, calls } = await scheduled(() => screen);

    await scheduleDelivery(run.id, deps);
    expect(lastDelivery(run.id)?.kind).toBe("waiting");
    expect(calls).toEqual([]);

    screen = EMPTY_BOX;
    for (let i = 0; i < 40 && (await statuses(runDir))[0] !== "delivered"; i++)
      await Bun.sleep(100);
    expect(await statuses(runDir)).toEqual(["delivered", "delivered"]);
    expect(calls.filter((c) => c.startsWith("text:"))).toHaveLength(1);
  });

  test("two deliveries started at once type the batch only once", async () => {
    const { run, runDir, deps, calls } = await scheduled(() => EMPTY_BOX);

    await Promise.all([scheduleDelivery(run.id, deps), scheduleDelivery(run.id, deps)]);

    expect(calls.filter((c) => c.startsWith("text:"))).toHaveLength(1);
    expect(await statuses(runDir)).toEqual(["delivered", "delivered"]);
  });
});
