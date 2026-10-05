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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  type IAgentProvider,
  type ITerminal,
  type LaunchOptions,
  type NodeRun,
  noopLogger,
  type RunRef,
  runDirOf,
  type State,
} from "@yok/sdk";
import { appendRunEvent, createRegistry, jsonlEventStore } from "@yok/sdk/internal";
import {
  completeContextOnSessionStart,
  findOpenContextRun,
  runContextStep,
  runModelStep,
} from "./context-step.ts";

const RESUME = "/yok:orchestrate --resume feat-x";
const IDLE = "❯ ";
const BUSY = "· Vibing… (3s)";

const seed = (runDir: string): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "feat-x",
  runDir,
  config: { path: null, root: runDir },
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
  tiers: null,
  eventHandlers: {},
  hooks: {},
});

// A run whose one open step is a context node with the given fields.
const setUp = async (node: string, header = "") => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "context-step-")));
  const run: RunRef = { id: "r-1", cwd, name: "feat-x" };
  const runDir = runDirOf(cwd, "feat-x");
  mkdirSync(join(runDir, "artifacts"), { recursive: true });
  writeFileSync(
    join(runDir, "workflow.yaml"),
    `name: t\n${header}nodes:\n  - { id: step, ${node} }\n`,
  );
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
    config: null,
    tiers: null,
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
    skillPrefix: "/",
    checks: [],
    launch: async () => ({
      ok: true,
      value: { terminalName: "unused", terminal: fakeTerminal(() => IDLE).terminal },
    }),
    relaunch: async (terminal, sessionId, options) => {
      relaunches.push({ terminal, sessionId, options });
      return relaunchOk ? { ok: true, value: undefined } : { ok: false, error: "no pane" };
    },
    prompt: async () => ({ ok: true, value: undefined }),
    stop: async () => ({ ok: true, value: undefined }),
    run: async () => ({ ok: false, error: new Error("unused") }),
    limitResetWait: async () => null,
    promptWhenReady: async () => ({ ok: true, value: "not-ready" }),
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

const LAUNCH = { cwd: "/repo", orchestrateArgv: ["/o.ts"], pluginDir: "/plugin-repo" };
const HOME = mkdtempSync(join(tmpdir(), "yok-home-"));

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
    home: HOME,
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

  test("the new session launches with the run's .env and workflow env, under yok's own", async () => {
    const context = await setUp("type: context, action: new", "env: { FROM_WORKFLOW: '1' }\n");
    writeFileSync(join(context.run.cwd, ".env"), "FROM_DOTENV=1\nYOK_RUN_ID=spoofed\n");
    const starting = startingProvider(context);

    await helper(context, fakeTerminal(() => IDLE).terminal, starting.provider);

    expect(starting.relaunches[0]?.options.env).toEqual({
      FROM_DOTENV: "1",
      FROM_WORKFLOW: "1",
      PATH: expect.stringContaining(join(HOME, "shims")),
      YOK_RUN_ID: "r-1",
      YOK_HOME: HOME,
    });
  });

  test("SC67: a context reset relaunches Claude on /yok:orchestrate --resume, with a shim under the home first on PATH and the launch's plugin folder kept", async () => {
    const context = await setUp("type: context, action: new");
    const starting = startingProvider(context);

    await helper(context, fakeTerminal(() => IDLE).terminal, starting.provider);

    const options = starting.relaunches[0]?.options;
    expect(options?.prompt).toBe("/yok:orchestrate --resume feat-x");
    const [shimDir = ""] = (options?.env?.PATH ?? "").split(delimiter);
    expect(dirname(shimDir)).toBe(join(HOME, "shims"));
    expect(options?.pluginDir).toBe("/plugin-repo");
  });

  test("a run env that fails to load completes unapplied and resumes the old session, launching nothing", async () => {
    const context = await setUp("type: context, action: new", "envFile: gone.env\n");
    const fake = fakeTerminal(() => IDLE);
    const { provider, relaunches } = fakeProvider();

    await helper(context, fake.terminal, provider);

    expect(relaunches).toEqual([]);
    expect(await stepOutput(context.runDir)).toMatchObject({
      output: { action: "new", applied: false },
    });
    expect(JSON.stringify(await stepOutput(context.runDir))).toContain("gone.env");
    expect(typesOf(fake.typed)).toEqual(["C-u", RESUME, "Enter"]);
    expect((await context.registry.findRun("r-1"))?.sessions).toEqual([
      { agent: "claude", sessionId: "A" },
    ]);
    expect(await typesIn(context.runDir)).not.toContain("workflow.context.started");
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

// A run with an open model switch to opus-x (and EFFORT); gives back the request's seq.
const setUpSwitch = async (effort?: "high") => {
  const context = await setUp("type: context, action: new");
  const requested = await appendRunEvent(context.run, {
    type: "workflow.model.requested",
    source: "workflow",
    payload: { node: "think", model: "opus-x", ...(effort === undefined ? {} : { effort }) },
  });
  if (!requested.ok) throw new Error(requested.error);
  return { ...context, seq: requested.value.event.seq };
};

const modelHelper = (
  context: Context & Readonly<{ seq: number }>,
  terminal: ITerminal | undefined,
  provider: IAgentProvider = fakeProvider().provider,
  seq = context.seq,
) =>
  runModelStep({
    run: context.run,
    seq,
    sessionId: "s-1",
    terminal,
    provider,
    launch: LAUNCH,
    home: HOME,
    log: noopLogger,
  });

const sessionStarted = (run: RunRef, sessionId: string, source: string) =>
  appendRunEvent(run, {
    type: "hooks.session-start.called",
    source: "hooks",
    payload: { agent: "claude", sessionId, source },
  });

// A provider whose relaunch plays the resumed Claude: its SessionStart hook fires with source resume.
const resumingProvider = (context: Context) => {
  const fake = fakeProvider();
  const provider: IAgentProvider = {
    ...fake.provider,
    relaunch: async (terminal, sessionId, options) => {
      const relaunched = await fake.provider.relaunch(terminal, sessionId, options);
      await sessionStarted(context.run, sessionId, "resume");
      return relaunched;
    },
  };
  return { provider, relaunches: fake.relaunches };
};

const appliedEvents = async (runDir: string) =>
  (await eventsOf(runDir))
    .filter((event) => event.type === "workflow.model.applied")
    .map((event) => event.payload);

describe("runModelStep", () => {
  test("SC25: resumes session s-1 on opus-x at high effort with the resume prompt, records the switch, and types nothing", async () => {
    const context = await setUpSwitch("high");
    const pane = fakeTerminal(() => IDLE);
    const { provider, relaunches } = resumingProvider(context);

    await modelHelper(context, pane.terminal, provider);

    expect(relaunches).toHaveLength(1);
    expect(relaunches[0]?.sessionId).toBe("s-1");
    expect(relaunches[0]?.options).toMatchObject({
      resume: true,
      model: "opus-x",
      effort: "high",
      prompt: RESUME,
    });
    expect(await appliedEvents(context.runDir)).toEqual([
      { requestSeq: context.seq, node: "think", model: "opus-x", effort: "high", applied: true },
    ]);
    expect(pane.typed).toEqual([]);
  });

  test("SC26: a request for opus-x with no effort relaunches with no effort key", async () => {
    const context = await setUpSwitch();
    const { provider, relaunches } = resumingProvider(context);

    await modelHelper(context, fakeTerminal(() => IDLE).terminal, provider);

    expect(relaunches[0]?.options.model).toBe("opus-x");
    expect(relaunches[0]?.options).not.toHaveProperty("effort");
  });

  test("SC27: a relaunch that fails with respawn failed is recorded as failed, the input emptied, and the resume prompt typed", async () => {
    const context = await setUpSwitch("high");
    const pane = fakeTerminal(() => IDLE);
    const provider: IAgentProvider = {
      ...fakeProvider().provider,
      relaunch: async () => ({ ok: false, error: "respawn failed" }),
    };

    await modelHelper(context, pane.terminal, provider);

    expect(await appliedEvents(context.runDir)).toEqual([
      {
        requestSeq: context.seq,
        node: "think",
        model: "opus-x",
        effort: "high",
        applied: false,
        reason: "respawn failed",
      },
    ]);
    expect(typesOf(pane.typed)).toEqual(["C-u", RESUME, "Enter"]);
  });

  test("a resumed session with no SessionStart within 60 seconds, counting none from before the relaunch, is recorded as failed and the run resumed", async () => {
    const context = await setUpSwitch();
    await sessionStarted(context.run, "s-1", "resume");
    const pane = fakeTerminal(() => IDLE);

    await modelHelper(context, pane.terminal);

    expect(await appliedEvents(context.runDir)).toEqual([
      {
        requestSeq: context.seq,
        node: "think",
        model: "opus-x",
        applied: false,
        reason: "no SessionStart within 60 seconds after resuming on opus-x",
      },
    ]);
    expect(typesOf(pane.typed)).toEqual(["C-u", RESUME, "Enter"]);
  });

  test("SC15: of two helpers started for the same switch, only one relaunches and stores the result", async () => {
    const context = await setUpSwitch();
    // a real 50ms pause on each screen check: Bun.sleep is faked in these tests
    const slowPane = () => {
      const pane = fakeTerminal(() => IDLE);
      const capture = async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return pane.terminal.capture();
      };
      return { ...pane.terminal, capture };
    };
    const { provider, relaunches } = fakeProvider();

    await Promise.all([
      modelHelper(context, slowPane(), provider),
      modelHelper(context, slowPane(), provider),
    ]);

    expect(relaunches).toHaveLength(1);
    expect(await appliedEvents(context.runDir)).toHaveLength(1);
  });

  test("a helper for a seq that is not the pending request, or for one already answered, relaunches nothing and stores nothing", async () => {
    const context = await setUpSwitch();
    const pane = fakeTerminal(() => IDLE);
    const { provider, relaunches } = fakeProvider();

    await modelHelper(context, pane.terminal, provider, context.seq + 1);
    const answer = { requestSeq: context.seq, node: "think", model: "opus-x", applied: true };
    await appendRunEvent(context.run, {
      type: "workflow.model.applied",
      source: "t",
      payload: answer,
    });
    await modelHelper(context, pane.terminal, provider);

    expect(relaunches).toEqual([]);
    expect(pane.typed).toEqual([]);
    expect(await appliedEvents(context.runDir)).toEqual([answer]);
  });

  test("a result that cannot be stored releases the switch's lock, so the next stop's helper relaunches again", async () => {
    const context = await setUpSwitch();
    const module = join(context.run.cwd, "refuse.ts");
    writeFileSync(module, 'export const refuse = () => { throw new Error("disk full"); };\n');
    const statePath = join(context.runDir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const eventHandlers = { "workflow.model.applied": [{ module, handler: "refuse" }] };
    writeFileSync(statePath, JSON.stringify({ ...state, eventHandlers }));
    const { provider, relaunches } = fakeProvider();

    await modelHelper(context, fakeTerminal(() => IDLE).terminal, provider);
    await modelHelper(context, fakeTerminal(() => IDLE).terminal, provider);

    expect(relaunches).toHaveLength(2);
    expect(await appliedEvents(context.runDir)).toEqual([]);
  });

  test("outside tmux the switch is recorded as failed: not inside tmux", async () => {
    const context = await setUpSwitch();

    await modelHelper(context, undefined);

    expect(await appliedEvents(context.runDir)).toEqual([
      {
        requestSeq: context.seq,
        node: "think",
        model: "opus-x",
        applied: false,
        reason: "not inside tmux",
      },
    ]);
  });
});

describe("findOpenContextRun", () => {
  const nodeRun = (nodeType: string, status: string, nodes?: Record<string, unknown>) =>
    ({
      nodeRunId: `${nodeType}-${status}`,
      nodeType,
      status,
      startedAt: null,
      completedAt: null,
      artifacts: [],
      ...(nodes === undefined ? {} : { nodes }),
    }) as unknown as NodeRun;

  test("SC15: a running context step is found at the top level and inside a loop, a completed one is not", () => {
    const inLoop = { loop: nodeRun("loop", "running", { c: nodeRun("context", "running") }) };
    const done = { c: nodeRun("context", "completed"), a: nodeRun("agent", "running") };
    expect(findOpenContextRun(inLoop)?.nodeRunId).toBe("context-running");
    expect(findOpenContextRun({ c: nodeRun("context", "running") })).toBeDefined();
    expect(findOpenContextRun(done)).toBeUndefined();
  });
});
