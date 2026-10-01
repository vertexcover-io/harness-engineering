import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type IAgentProvider,
  type ITerminal,
  type LaunchOptions,
  noopLogger,
  type RunRef,
  runDirOf,
  type State,
} from "@harness/sdk";
import { appendRunEvent, createRegistry, jsonlEventStore } from "@harness/sdk/internal";
import { completeContextOnSessionStart, runContextStep } from "./context-step.ts";

const RESUME = "/orchestrate-v2 --resume feat-x";
const IDLE = "❯ ";
const BUSY = "· Vibing… (3s)";

const seed = (runDir: string): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "feat-x",
  runDir,
  version: "2.0.0",
  workflow: { name: "t", path: "workflow.yaml" },
  input: {},
  scope: null,
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/repo",
    repositories: {
      app: { path: "/repo", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  nodeRuns: {
    step: {
      nodeRunId: "nr-1",
      nodeType: "context",
      status: "running",
      startedAt: "2026-09-26T10:00:00Z",
      completedAt: null,
      artifacts: [],
      input: null,
    },
  },
  activeSessions: [{ agent: "claude", sessionId: "A" }],
  eventHandlers: {},
});

// A run whose one open step is a context node with the given fields.
const setUp = async (node: string) => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "context-step-")));
  const run: RunRef = { id: "r-1", cwd, name: "feat-x" };
  const runDir = runDirOf(cwd, "feat-x");
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(join(runDir, "workflow.yaml"), `name: t\nnodes:\n  - { id: step, ${node} }\n`);
  writeFileSync(join(runDir, "state.json"), JSON.stringify(seed(runDir)));
  const registry = createRegistry(join(cwd, "registry.json"));
  await registry.addRun({
    id: "r-1",
    workflow: "t",
    workflowPath: join(runDir, "workflow.yaml"),
    inputs: {},
    cwd,
    sessions: [{ agent: "claude", sessionId: "A" }],
    name: "feat-x",
    terminal: "claude-feat-x-r-1",
    createdAt: new Date().toISOString(),
  });
  return { run, runDir, registry };
};

type Typed = string | readonly string[];

// A terminal whose screen comes from `screen(captures)`; `onSubmit` runs when Enter follows text.
const fakeTerminal = (
  screen: (captures: number) => string,
  onSubmit: (text: string) => Promise<void> = async () => {},
) => {
  const typed: Typed[] = [];
  let captures = 0;
  const done = async () => ({ ok: true as const, value: undefined });
  const terminal: ITerminal = {
    sendText: async (text) => {
      typed.push(text);
      return done();
    },
    sendKeys: async (keys) => {
      typed.push(keys);
      const text = typed.at(-2);
      if (keys[0] === "Enter" && typeof text === "string") await onSubmit(text);
      return done();
    },
    capture: async () => ({ ok: true, value: screen(captures++) }),
    isAlive: async () => true,
    kill: done,
    rename: done,
    respawn: done,
    attachCommand: () => [],
  };
  return { terminal, typed, captureCount: () => captures };
};

type Relaunch = Readonly<{ terminal: ITerminal; sessionId: string; options: LaunchOptions }>;

const fakeProvider = (relaunchOk = true) => {
  const relaunches: Relaunch[] = [];
  const provider: IAgentProvider = {
    type: "claude",
    checks: [],
    launch: async () => ({ ok: true, value: { sessionId: "unused", terminal: fakeTerminal(() => IDLE).terminal } }),
    relaunch: async (terminal, sessionId, options) => {
      relaunches.push({ terminal, sessionId, options });
      return relaunchOk ? { ok: true, value: undefined } : { ok: false, error: "no pane" };
    },
    prompt: async () => ({ ok: true, value: undefined }),
    stop: async () => ({ ok: true, value: undefined }),
    run: async () => ({ ok: false, error: new Error("unused") }),
  };
  return { provider, relaunches };
};

// Waits in the helper run on Bun.sleep and Date.now; faking both lets a 180-second timeout pass
// at once.
beforeEach(() => {
  let now = Date.parse("2026-10-01T00:00:00Z");
  setSystemTime(new Date(now));
  spyOn(Bun, "sleep").mockImplementation(async (ms) => {
    now += Number(ms);
    setSystemTime(new Date(now));
  });
});

afterEach(() => {
  setSystemTime();
  mock.restore();
});

const LAUNCH = { cwd: "/repo", env: { HARNESS_RUN_ID: "r-1" }, hookCommand: ["hook"] };

type Context = Awaited<ReturnType<typeof setUp>>;

const helper = async (
  context: Context,
  terminal: ITerminal | undefined,
  provider: IAgentProvider = fakeProvider().provider,
) =>
  runContextStep({
    run: context.run,
    nodeRunId: "nr-1",
    oldSessionId: "A",
    terminal,
    registry: context.registry,
    provider,
    launch: LAUNCH,
    log: noopLogger,
  });

const eventsOf = (runDir: string) => jsonlEventStore(runDir).read();
const typesOf = (log: readonly Typed[]) =>
  log.map((entry) => (typeof entry === "string" ? entry : entry[0]));
const typesIn = async (runDir: string) => (await eventsOf(runDir)).map((event) => event.type);
const stepOutput = async (runDir: string) =>
  (await eventsOf(runDir)).find((event) => event.type === "workflow.node.completed")?.payload;

// A provider whose relaunch plays the fresh Claude: its SessionStart hook fires with the new id.
const startingProvider = (context: Context) => {
  const fake = fakeProvider();
  const provider: IAgentProvider = {
    ...fake.provider,
    relaunch: async (terminal, sessionId, options) => {
      const relaunched = await fake.provider.relaunch(terminal, sessionId, options);
      await completeContextOnSessionStart(context.run, sessionId, "startup", undefined);
      return relaunched;
    },
  };
  return { provider, relaunches: fake.relaunches };
};

describe("runContextStep: new", () => {
  test("records the start, relaunches Claude on a new session, and the new session's SessionStart completes the node", async () => {
    const context = await setUp("type: context, action: new");
    let capturesAtRelaunch = -1;
    let typesAtRelaunch: string[] = [];
    const fake = fakeTerminal((captures) => (captures < 2 ? BUSY : IDLE));
    const starting = startingProvider(context);
    const watched: IAgentProvider = {
      ...starting.provider,
      relaunch: async (terminal, sessionId, options) => {
        capturesAtRelaunch = fake.captureCount();
        typesAtRelaunch = await typesIn(context.runDir);
        return starting.provider.relaunch(terminal, sessionId, options);
      },
    };

    await helper(context, fake.terminal, watched);

    expect(capturesAtRelaunch).toBe(3);
    expect(typesAtRelaunch).toEqual(["workflow.session.replaced", "workflow.context.started"]);
    const [relaunch] = starting.relaunches;
    expect(relaunch?.terminal).toBe(fake.terminal);
    expect(relaunch).toMatchObject({ options: { ...LAUNCH, prompt: RESUME } });
    const sessionId = relaunch?.sessionId ?? "";
    expect(fake.typed).toEqual([]);
    expect((await context.registry.findRun("r-1"))?.sessions).toContainEqual({
      agent: "claude",
      sessionId,
    });
    expect(await typesIn(context.runDir)).toEqual([
      "workflow.session.replaced",
      "workflow.context.started",
      "workflow.node.completed",
    ]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: true, sessionId },
    });
  });

  test("a relaunch that fails undoes the swap, completes unapplied and resumes the old session", async () => {
    const context = await setUp("type: context, action: new");
    const fake = fakeTerminal(() => IDLE);

    await helper(context, fake.terminal, fakeProvider(false).provider);

    const replaced = (await eventsOf(context.runDir))
      .filter((event) => event.type === "workflow.session.replaced")
      .map((event) => event.payload as { previousSessionId: string; sessionId: string });
    const newId = replaced[0]?.sessionId ?? "";
    expect(replaced.map((event) => event.previousSessionId)).toEqual(["A", newId]);
    expect(replaced[1]?.sessionId).toBe("A");
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: false, reason: "no pane" },
    });
    expect(typesOf(fake.typed)).toEqual(["C-u", RESUME, "Enter"]);
  });

  test("a new session that never starts completes the node unapplied after the timeout", async () => {
    const context = await setUp("type: context, action: new");

    await helper(context, fakeTerminal(() => IDLE).terminal);

    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: false, reason: expect.stringContaining("SessionStart") },
    });
  });
});

describe("runContextStep: compact", () => {
  test("records the start, types /compact with the prompt; the compact's SessionStart completes the node and types the resume prompt", async () => {
    const context = await setUp('type: context, action: compact, prompt: "keep the plan"');
    const fake = fakeTerminal(
      () => IDLE,
      async (text) => {
        if (!text.startsWith("/compact")) return;
        await completeContextOnSessionStart(context.run, "A", "compact", fake.terminal);
      },
    );

    await helper(context, fake.terminal);

    expect(typesOf(fake.typed)).toEqual(["/compact keep the plan", "Enter", RESUME, "Enter"]);
    expect(await typesIn(context.runDir)).toEqual([
      "workflow.context.started",
      "workflow.node.completed",
    ]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: true, sessionId: "A" },
    });
  });

  test("a compact with too little to compact completes unapplied, empties the input and resumes", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = fakeTerminal((captures) =>
      captures < 1 ? IDLE : "⎿  Not enough messages to compact.\n❯ ",
    );

    await helper(context, fake.terminal);

    expect(typesOf(fake.typed)).toEqual(["/compact", "Enter", "C-u", RESUME, "Enter"]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: false, reason: "Not enough messages to compact." },
    });
  });

  test("no SessionStart before the timeout completes unapplied and resumes", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = fakeTerminal(() => IDLE);

    await helper(context, fake.terminal);

    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: false },
    });
    expect(typesOf(fake.typed).slice(-2)).toEqual([RESUME, "Enter"]);
  });
});

describe("completeContextOnSessionStart", () => {
  const started = (context: Context, action: "new" | "compact", sessionId: string) =>
    appendRunEvent(context.run, {
      type: "workflow.context.started",
      source: "orchestrate",
      payload: { nodeRunId: "nr-1", action, sessionId },
    });

  test("only a session start that matches the started action completes the node", async () => {
    const context = await setUp("type: context, action: new");
    const typed = fakeTerminal(() => IDLE);

    await completeContextOnSessionStart(context.run, "s-new", "startup", typed.terminal);
    expect(await stepOutput(context.runDir)).toBeUndefined();

    await started(context, "new", "s-new");
    await completeContextOnSessionStart(context.run, "s-other", "startup", typed.terminal);
    await completeContextOnSessionStart(context.run, "s-new", "compact", typed.terminal);
    expect(await stepOutput(context.runDir)).toBeUndefined();

    await completeContextOnSessionStart(context.run, "s-new", "startup", typed.terminal);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: true, sessionId: "s-new" },
    });
    expect(typed.typed).toEqual([]);
  });
});

describe("runContextStep: guards", () => {
  test("of two helpers started at once for the same node, only one goes ahead", async () => {
    const context = await setUp("type: context, action: new");
    const first = startingProvider(context);
    const second = startingProvider(context);

    // Each helper pauses on its first screen check, so both are past their node lookup before
    // either completes the node: without the lock, both would go ahead.
    const slowTerminal = () => {
      const { terminal } = fakeTerminal(() => IDLE);
      // a real 50ms pause: Bun.sleep is faked in these tests
      const capture = async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return terminal.capture();
      };
      return { ...terminal, capture };
    };
    await Promise.all([
      helper(context, slowTerminal(), first.provider),
      helper(context, slowTerminal(), second.provider),
    ]);

    expect(first.relaunches.length + second.relaunches.length).toBe(1);
    expect(existsSync(join(context.runDir, "locks", "context-nr-1.lock"))).toBe(true);
    expect(await typesIn(context.runDir)).toEqual([
      "workflow.session.replaced",
      "workflow.context.started",
      "workflow.node.completed",
    ]);
  });

  test("outside tmux the node completes unapplied and nothing is relaunched", async () => {
    const context = await setUp("type: context, action: new");
    const { provider, relaunches } = fakeProvider();

    await helper(context, undefined, provider);

    expect(relaunches).toEqual([]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: false, reason: "not inside tmux" },
    });
  });

  test("a tmux call that throws completes the node unapplied and still resumes the run", async () => {
    const context = await setUp("type: context, action: compact");
    const fake = fakeTerminal(() => IDLE);
    let captures = 0;
    const terminal: ITerminal = {
      ...fake.terminal,
      capture: (lines) => {
        captures += 1;
        if (captures === 1) return Promise.reject(new Error("tmux timed out after 10s"));
        return fake.terminal.capture(lines);
      },
    };

    await helper(context, terminal);

    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "compact", applied: false, reason: "tmux timed out after 10s" },
    });
    expect(typesOf(fake.typed)).toEqual(["C-u", RESUME, "Enter"]);
  });
});
