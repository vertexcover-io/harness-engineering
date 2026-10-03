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
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "@harness/sdk";
import {
  emitRunEvent,
  type NodeRun,
  noopLogger,
  type RunRef,
  readState,
  registryPath,
  runDirOf,
  type State,
  type StopInput,
  type TranscriptEntry,
} from "@harness/sdk";
import { createRegistry, jsonlEventStore } from "@harness/sdk/internal";
import { ORCHESTRATE_SCRIPT } from "../stage.ts";
import { recordGuard, runPreToolUse } from "./pre-tool-use.ts";
import { decideStop, runStopHook } from "./stop.ts";

const seed: State = {
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "feat-x",
  runDir: "/repo/.harness/feat-x",
  version: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
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
  nodeRuns: {},
  activeSessions: [],
  eventHandlers: {},
  hooks: {},
};

const RUN: RunRef = { id: "r-1", cwd: "/repo", name: "feat-x" };

const nodeRun = (
  nodeRunId: string,
  status: NodeRun["status"],
  nodeType: NodeRun["nodeType"] = "agent",
  nodes?: Record<string, NodeRun>,
): NodeRun => ({
  nodeRunId,
  nodeType,
  status,
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: status === "running" ? null : "2026-09-26T10:01:00Z",
  artifacts: [],
  ...(nodes === undefined ? {} : { nodes }),
});

const planOpen = { plan: nodeRun("plan", "running") };

const decide = (
  overrides: Partial<State>,
  touchedRun: boolean | undefined = true,
  progressSinceCheck = false,
) =>
  decideStop({
    run: RUN,
    state: { ...seed, ...overrides },
    touchedRun,
    progressSinceCheck,
    maxBlocks: 1,
  });

describe("decideStop", () => {
  test("SC1 — a finished run lets the turn end", () => {
    const decision = decide({ status: "completed", nodeRuns: planOpen });
    expect(decision).toMatchObject({ reason: "run-finished" });
  });

  test("SC2 — an open leaf inside a loop blocks with that leaf's done command", () => {
    const loop = nodeRun("fix", "running", "loop", { review: nodeRun("fix/1/review", "running") });
    const decision = decide({ nodeRuns: { fix: loop } });
    expect(decision).toMatchObject({
      reason: "node-not-done",
      blockStreak: 1,
      nodeRunId: "fix/1/review",
    });
    const message = "message" in decision ? decision.message : "";
    expect(message).toContain("node review");
    expect(message).toContain("bun run orchestrate done fix/1/review --run feat-x");
  });

  test("SC3 — a running loop with no running child blocks with the next command", () => {
    const loop = nodeRun("fix", "running", "loop", {
      review: nodeRun("fix/1/review", "completed"),
    });
    const decision = decide({ nodeRuns: { fix: loop } });
    expect(decision).toMatchObject({
      message: expect.stringContaining("bun run orchestrate next --run feat-x"),
      reason: "next-not-run",
    });
  });

  test("an open exec node is sent back with its exec command, never done", () => {
    const decision = decide({ nodeRuns: { lint: nodeRun("lint", "running", "exec") } });
    const message = "message" in decision ? decision.message : "";
    expect(decision).toMatchObject({ reason: "node-not-done", nodeRunId: "lint" });
    expect(message).toContain("bun run orchestrate exec lint --run feat-x");
    expect(message).toContain("background task");
    expect(message).not.toContain("orchestrate done");
  });

  test("SC4 — a chat turn between nodes lets the turn end", () => {
    expect(decide({}, false)).toMatchObject({ reason: "user-chat" });
  });

  test("SC5 — an unknown turn between nodes still blocks", () => {
    expect(decide({}, undefined)).toMatchObject({ reason: "next-not-run" });
  });

  test("SC6 — a chat turn with a node open still blocks", () => {
    const decision = decide({ nodeRuns: planOpen }, false);
    expect(decision).toMatchObject({
      message: expect.stringContaining("orchestrate done plan"),
      reason: "node-not-done",
    });
  });

  test("SC7 — a second stop with no new event lets the turn end", () => {
    const decision = decide({
      nodeRuns: planOpen,
      stopHook: { blockStreak: 1, seq: 12 },
      lastEventSeq: 12,
    });
    expect(decision).toMatchObject({ reason: "max-blocks-reached", blockStreak: 1 });
  });

  test("SC8 — progress since the last stop check restarts the count", () => {
    const decision = decide(
      { nodeRuns: planOpen, stopHook: { blockStreak: 1, seq: 12 }, lastEventSeq: 14 },
      true,
      true,
    );
    expect(decision).toMatchObject({ reason: "node-not-done", blockStreak: 1 });
  });

  test("SC9 — an allowed call keeps the streak it found", () => {
    const decision = decide({ stopHook: { blockStreak: 1, seq: 12 }, lastEventSeq: 12 }, false);
    expect(decision).toMatchObject({ reason: "user-chat", blockStreak: 1 });
  });
});

const setUp = async (nodeRuns: State["nodeRuns"], agent: "claude" | "codex" = "claude") => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "hooks-home-")));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "hooks-repo-")));
  const registry = createRegistry(registryPath(home));
  await registry.addRun({
    id: "r-1",
    workflow: "feature",
    workflowPath: join(cwd, "workflow.yaml"),
    inputs: {},
    cwd,
    sessions: [{ agent, sessionId: "s1" }],
    name: "feat-x",
    terminal: null,
    config: null,
    tier: null,
    createdAt: "2026-09-26T10:00:00Z",
  });
  const runDir = runDirOf(cwd, "feat-x");
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "state.json"), JSON.stringify({ ...seed, nodeRuns }));
  return { runDir, cwd, deps: { registry, env: { HARNESS_RUN_ID: "r-1" }, log: noopLogger } };
};

const input = (
  entries: readonly TranscriptEntry[] | undefined,
  agent: "claude" | "codex" = "claude",
): StopInput => ({
  agent,
  sessionId: "s1",
  contextSteps: agent === "claude",
  readTranscript: async () => entries,
});

const orchestrateAfterPrompt: TranscriptEntry[] = [
  { kind: "prompt", text: "why?" },
  { kind: "command", command: "ls" },
  { kind: "prompt", text: "go" },
  { kind: "command", command: "bun run orchestrate next --run feat-x" },
];

describe("runStopHook", () => {
  test("SC10 — HARNESS_STOP_MAX_BLOCKS sets how many blocks in a row, and a bad value keeps the default of 1", async () => {
    const replies = async (maxBlocks: string | undefined) => {
      const { deps } = await setUp(planOpen);
      const env = { ...deps.env, HARNESS_STOP_MAX_BLOCKS: maxBlocks };
      const kinds: string[] = [];
      for (const _ of [1, 2, 3, 4]) {
        kinds.push((await runStopHook(input(undefined), { ...deps, env })).kind);
      }
      return kinds;
    };
    expect(await replies("3")).toEqual(["continue", "continue", "continue", "allow"]);
    expect(await replies("0")).toEqual(["continue", "allow", "allow", "allow"]);
    expect(await replies("abc")).toEqual(["continue", "allow", "allow", "allow"]);
    expect(await replies(undefined)).toEqual(["continue", "allow", "allow", "allow"]);
  });

  test("SC11 — an orchestrate command after the last prompt marks the turn as run work", async () => {
    const { deps } = await setUp({});
    expect(await runStopHook(input(orchestrateAfterPrompt), deps)).toMatchObject({
      kind: "continue",
    });
  });

  test("SC12 — commands only before the last prompt do not count", async () => {
    const { deps } = await setUp({});
    const entries: TranscriptEntry[] = [
      { kind: "prompt", text: "go" },
      { kind: "command", command: "bun run orchestrate next --run feat-x" },
      { kind: "prompt", text: "why did lint fail?" },
      { kind: "command", command: "cat lint.log" },
    ];
    expect(await runStopHook(input(entries), deps)).toEqual({ kind: "allow" });
  });

  test("reading or grepping orchestrate files is chat, and a direct call to the script is run work", async () => {
    const reads: TranscriptEntry[] = [
      { kind: "prompt", text: "how does next work?" },
      { kind: "command", command: "grep -n decideNext packages/core/src/orchestrate.ts" },
      { kind: "command", command: "cat skills/orchestrate/SKILL.md" },
      { kind: "command", command: "grep -rn orchestrate packages/core" },
    ];
    const direct: TranscriptEntry[] = [
      { kind: "prompt", text: "go" },
      { kind: "command", command: "bun /h/packages/core/src/orchestrate.ts done n1 --run feat-x" },
    ];
    expect(await runStopHook(input(reads), (await setUp({})).deps)).toEqual({ kind: "allow" });
    expect(await runStopHook(input(direct), (await setUp({})).deps)).toMatchObject({
      kind: "continue",
    });
  });

  test("SC13 — no prompt, or no transcript, is unknown, so the turn still blocks", async () => {
    const onlyCommands: TranscriptEntry[] = [{ kind: "command", command: "ls" }];
    for (const entries of [onlyCommands, undefined]) {
      const { deps } = await setUp({});
      expect(await runStopHook(input(entries), deps)).toMatchObject({ kind: "continue" });
    }
  });

  test("the transcript is read only when no node is open, and every call is logged", async () => {
    const { deps, runDir } = await setUp(planOpen);
    let reads = 0;
    const counted: StopInput = {
      ...input(orchestrateAfterPrompt),
      readTranscript: async () => {
        reads += 1;
        return orchestrateAfterPrompt;
      },
    };
    await runStopHook(counted, deps);
    await runStopHook(counted, deps);
    expect(reads).toBe(0);
    const events = await jsonlEventStore(runDir).read();
    expect(events.map((event) => event.payload)).toEqual([
      expect.objectContaining({
        decision: "continue",
        reason: "node-not-done",
        blockStreak: 1,
        touchedRun: null,
      }),
      expect.objectContaining({ decision: "allow", reason: "max-blocks-reached", blockStreak: 1 }),
      { agent: "claude", sessionId: "s1" },
    ]);
    expect((await readState(runDir))?.stopHook).toEqual({ blockStreak: 1, seq: 2 });
  });

  test("a stop that gives up records agent.stuck for the session, which is not progress, so the next stop also lets the turn end", async () => {
    const { deps, runDir } = await setUp(planOpen);

    const kinds = [];
    for (const _ of [1, 2, 3]) kinds.push((await runStopHook(input(undefined), deps)).kind);

    expect(kinds).toEqual(["continue", "allow", "allow"]);
    const stuck = (await jsonlEventStore(runDir).read()).filter((e) => e.type === "agent.stuck");
    expect(stuck.map((event) => [event.source, event.payload])).toEqual([
      ["hooks", { agent: "claude", sessionId: "s1" }],
      ["hooks", { agent: "claude", sessionId: "s1" }],
    ]);
  });

  test("a tool call between two stops is not progress, and any other event is", async () => {
    const { deps, runDir } = await setUp(planOpen);
    const cwd = join(runDir, "..", "..");
    const ls = { agent: "claude" as const, sessionId: "s1", toolName: "Bash", cwd };

    expect(await runStopHook(input(undefined), deps)).toMatchObject({ kind: "continue" });
    await runPreToolUse({ ...ls, call: { kind: "shell", command: "ls" } }, recordGuard, deps);
    expect(await runStopHook(input(undefined), deps)).toEqual({ kind: "allow" });

    const run = { id: "r-1", cwd, name: "feat-x" };
    await emitRunEvent(run, { type: "custom.test.progress", source: "test", payload: {} });
    expect(await runStopHook(input(undefined), deps)).toMatchObject({ kind: "continue" });
  });

  test("a block that cannot be logged lets the turn end, so an unsaved count can't trap the session", async () => {
    const { deps, runDir } = await setUp(planOpen);
    const log = join(runDir, "event.jsonl");
    await writeFile(log, "");
    await chmod(log, 0o444);

    expect(await runStopHook(input(undefined), deps)).toEqual({ kind: "allow" });
    expect(await readFile(log, "utf8")).toBe("");
  });

  test("a session the run does not own is never blocked and nothing is logged", async () => {
    const { deps, runDir } = await setUp(planOpen);
    const other = { ...input(undefined), sessionId: "other" };
    expect(await runStopHook(other, deps)).toEqual({ kind: "allow" });
    expect(await runStopHook(input(undefined), { ...deps, env: {} })).toEqual({ kind: "allow" });
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
  });
});

describe("an open context node", () => {
  const contextOpen = { fresh: nodeRun("nr-1", "running", "context") };

  // The helper is a detached orchestrate process, so the spawn is the boundary these tests stop at.
  let spawn: ReturnType<typeof spyOn<typeof sdk, "spawnDetached">>;
  beforeAll(() => {
    spawn = spyOn(sdk, "spawnDetached");
  });
  beforeEach(() => spawn.mockImplementation(() => 0));
  afterEach(() => spawn.mockReset());
  afterAll(() => spawn.mockRestore());

  test("lets the turn end, records context-node and starts the helper for that node", async () => {
    const { deps, runDir, cwd } = await setUp(contextOpen);

    expect(await runStopHook(input(orchestrateAfterPrompt), deps)).toEqual({ kind: "allow" });

    expect(spawn.mock.calls).toEqual([
      [
        process.execPath,
        [ORCHESTRATE_SCRIPT, "context", "nr-1", "--run-id", "r-1", "--session-id", "s1"],
        { cwd, output: "ignore" },
      ],
    ]);
    expect((await jsonlEventStore(runDir).read()).map((e) => e.payload)).toEqual([
      expect.objectContaining({ decision: "allow", reason: "context-node", nodeRunId: "nr-1" }),
    ]);
  });

  test("SC15: a codex session's context node completes as not applied, the helper never starts, and the turn is sent to next", async () => {
    const { deps, runDir } = await setUp(contextOpen, "codex");
    await writeFile(
      join(runDir, "workflow.yaml"),
      "name: w\nnodes:\n  - id: fresh\n    type: context\n    action: new\n",
    );

    const reply = await runStopHook(input(orchestrateAfterPrompt, "codex"), deps);

    expect(reply).toMatchObject({ kind: "continue", message: expect.stringContaining("next") });
    expect(spawn).not.toHaveBeenCalled();
    const state = await readState(runDir);
    expect(state?.nodeRuns.fresh).toMatchObject({
      status: "completed",
      output: {
        applied: false,
        reason: "context steps are not supported on codex",
      },
    });
  });

  test("an open agent node still blocks and starts no helper", async () => {
    const { deps } = await setUp(planOpen);
    expect(await runStopHook(input(orchestrateAfterPrompt), deps)).toMatchObject({
      kind: "continue",
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  test("a helper that cannot start still lets the stop through", async () => {
    const { deps } = await setUp(contextOpen);
    spawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    expect(await runStopHook(input(orchestrateAfterPrompt), deps)).toEqual({ kind: "allow" });
  });
});
