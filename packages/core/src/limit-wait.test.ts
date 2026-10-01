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
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentType,
  type IAgentProvider,
  type ITerminal,
  noopLogger,
  type ResetWait,
  type RunRef,
  runDirOf,
} from "@harness/sdk";
import { appendRunEvent, jsonlEventStore } from "@harness/sdk/internal";
import { runLimitWait } from "./limit-wait.ts";

const setUp = () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "limit-wait-")));
  const run: RunRef = { id: "r-1", cwd, name: "feat-x" };
  const runDir = runDirOf(cwd, "feat-x");
  mkdirSync(runDir, { recursive: true });
  return { run, runDir };
};

const limitReached = async (
  run: RunRef,
  message: string,
  { sessionId = "s1", agent = "claude" }: Readonly<{ sessionId?: string; agent?: AgentType }> = {},
) => {
  const stored = await appendRunEvent(run, {
    type: "agent.limit.reached",
    source: "hooks",
    payload: { agent, sessionId, error: "rate_limit", message },
  });
  if (!stored.ok) throw new Error(stored.error);
  return stored.value.event.id;
};

const unused = () => Promise.reject(new Error("unused"));

// The wait only hands this to the agent, so its methods are never called.
const TERMINAL: ITerminal = {
  sendText: unused,
  sendKeys: unused,
  capture: unused,
  isAlive: unused,
  kill: unused,
  rename: unused,
  respawn: unused,
  attachCommand: () => [],
};

type Seen = { waits: { terminal: ITerminal; message: string }[]; prompts: string[] };

// An agent whose reset reading and prompt answer are given, recording what it was asked.
const fakeAgent = (
  reset: ResetWait | null,
  answer: "sent" | "not-ready" = "sent",
): { agent: IAgentProvider; seen: Seen } => {
  const seen: Seen = { waits: [], prompts: [] };
  const agent: IAgentProvider = {
    type: "claude",
    checks: [],
    launch: unused,
    relaunch: unused,
    prompt: unused,
    stop: unused,
    run: unused,
    limitResetWait: async (terminal, message) => {
      seen.waits.push({ terminal, message });
      return reset;
    },
    promptWhenReady: async (_terminal, text) => {
      seen.prompts.push(text);
      return { ok: true, value: answer };
    },
  };
  return { agent, seen };
};

let onSleep: () => Promise<void> = async () => {};

beforeEach(() => {
  let now = Date.parse("2026-10-01T13:00:00Z");
  setSystemTime(new Date(now));
  onSleep = async () => {};
  spyOn(Bun, "sleep").mockImplementation(async (ms) => {
    now += Number(ms);
    setSystemTime(new Date(now));
    await onSleep();
  });
});

afterEach(() => {
  setSystemTime();
  mock.restore();
});

const eventsOf = async (runDir: string) => jsonlEventStore(runDir).read();
const payloadOf = async (runDir: string, type: string) =>
  (await eventsOf(runDir)).find((event) => event.type === type)?.payload;

const HOUR = 3_600_000;

const waitWith = (run: RunRef, limitEventId: string, agent: IAgentProvider) =>
  runLimitWait({
    run,
    sessionId: "s1",
    limitEventId,
    agents: { claude: agent },
    terminal: TERMINAL,
    log: noopLogger,
  });

describe("runLimitWait", () => {
  test.each<[string, ResetWait | null, string]>([
    ["message", { ms: 2 * HOUR, from: "message" }, "2026-10-01T15:00:00.000Z"],
    ["screen", { ms: 3 * HOUR, from: "screen" }, "2026-10-01T16:00:00.000Z"],
    ["fallback", null, "2026-10-01T13:15:00.000Z"],
  ])(
    "a reset read from the %s sets resumeAt, and the agent is prompted to continue once it passes",
    async (from, reset, resumeAt) => {
      const { run, runDir } = setUp();
      const limitEventId = await limitReached(run, "You've hit your limit");
      const { agent, seen } = fakeAgent(reset);

      await waitWith(run, limitEventId, agent);

      expect(seen.waits).toEqual([{ terminal: TERMINAL, message: "You've hit your limit" }]);
      expect(await payloadOf(runDir, "agent.limit.waiting")).toEqual({
        sessionId: "s1",
        limitEventId,
        resumeAt,
        from,
      });
      expect(Date.now()).toBeGreaterThanOrEqual(Date.parse(resumeAt));
      expect(seen.prompts).toEqual(["continue"]);
      expect(await payloadOf(runDir, "agent.limit.resumed")).toEqual({
        sessionId: "s1",
        limitEventId,
      });
    },
  );

  test("an agent that is not ready for input gets no resumed event", async () => {
    const { run, runDir } = setUp();
    const limitEventId = await limitReached(run, "limit");
    const { agent, seen } = fakeAgent({ ms: HOUR, from: "message" }, "not-ready");
    await waitWith(run, limitEventId, agent);
    expect(seen.prompts).toEqual(["continue"]);
    expect(await payloadOf(runDir, "agent.limit.resumed")).toBeUndefined();
  });

  test("a newer limit for the session ends the wait within a minute, prompting nothing", async () => {
    const { run, runDir } = setUp();
    const limitEventId = await limitReached(run, "limit");
    onSleep = async () => void (await limitReached(run, "limit"));
    const { agent, seen } = fakeAgent({ ms: 2 * HOUR, from: "message" });
    await waitWith(run, limitEventId, agent);
    expect(seen.prompts).toEqual([]);
    expect(Date.now()).toBeLessThanOrEqual(Date.parse("2026-10-01T13:01:00Z"));
    expect(await payloadOf(runDir, "agent.limit.resumed")).toBeUndefined();
  });

  test.each([
    [
      "any later hook call from the session, such as a tool call after a manual resume",
      {
        type: "hooks.pre-tool-use.called",
        payload: {
          agent: "claude",
          sessionId: "s1",
          tool: "Bash",
          handler: "h",
          decision: "allow",
        },
      },
    ],
    [
      "a new session starting, such as after /clear in the same terminal",
      {
        type: "hooks.session-start.called",
        payload: { agent: "claude", sessionId: "s2", source: "clear" },
      },
    ],
  ] as const)("%s ends the wait, prompting nothing", async (_, event) => {
    const { run } = setUp();
    const limitEventId = await limitReached(run, "limit");
    onSleep = async () => void (await appendRunEvent(run, { ...event, source: "hooks" }));
    const { agent, seen } = fakeAgent({ ms: 2 * HOUR, from: "message" });
    await waitWith(run, limitEventId, agent);
    expect(seen.prompts).toEqual([]);
  });

  test("a limit in another session leaves this session's wait to prompt continue", async () => {
    const { run } = setUp();
    const limitEventId = await limitReached(run, "limit");
    onSleep = async () => void (await limitReached(run, "limit", { sessionId: "s2" }));
    const { agent, seen } = fakeAgent({ ms: 2 * HOUR, from: "message" });
    await waitWith(run, limitEventId, agent);
    expect(seen.prompts).toEqual(["continue"]);
  });

  test("after 20 limits in a row with nothing else from the session, it gives up instead of retrying forever", async () => {
    const { run, runDir } = setUp();
    for (const _ of Array.from({ length: 20 })) await limitReached(run, "credits");
    const limitEventId = await limitReached(run, "credits");
    const { agent, seen } = fakeAgent(null);
    await waitWith(run, limitEventId, agent);
    expect(seen.prompts).toEqual([]);
    expect(await payloadOf(runDir, "agent.limit.waiting")).toBeUndefined();
  });

  test("an agent with no provider, or no terminal to reach, gets no wait", async () => {
    const { run, runDir } = setUp();
    const { agent, seen } = fakeAgent({ ms: HOUR, from: "message" });
    const codexLimit = await limitReached(run, "limit", { agent: "codex" });
    await waitWith(run, codexLimit, agent);
    const claudeLimit = await limitReached(run, "limit");
    await runLimitWait({
      run,
      sessionId: "s1",
      limitEventId: claudeLimit,
      agents: { claude: agent },
      terminal: undefined,
      log: noopLogger,
    });
    expect(seen.waits).toEqual([]);
    expect(await payloadOf(runDir, "agent.limit.waiting")).toBeUndefined();
  });
});
