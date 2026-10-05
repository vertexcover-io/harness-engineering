import { describe, expect, test } from "bun:test";
import { EventSchema, ResolvedTiersSchema, StateSchema, tierLaunch } from "./contracts.ts";

const agentRun = {
  nodeRunId: "plan-1",
  nodeType: "agent",
  status: "running",
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  artifacts: [{ name: "plan", path: "artifacts/plan-1/plan.md" }],
  stage: "planning",
  agentState: { agent: "claude", model: "opus", sessionId: null, tokens: null },
};

const validState = {
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-test",
  runName: "add-login",
  runDir: "/work/.yok/add-login",
  version: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: { prompt: "add login" },
  scope: null,
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/work/add-login",
    repositories: {
      app: { path: "/work/add-login", git: { branch: "b", baseBranch: "main", startSha: "abc" } },
    },
  },
  nodeRuns: { plan: agentRun },
  tiers: null,
};

describe("StateSchema", () => {
  test("a state with one running agent node run parses", () => {
    expect(StateSchema.safeParse(validState).success).toBe(true);
  });

  test("EH3 — a state.json with no custom or eventHandlers parses with no custom and no handlers", () => {
    const parsed = StateSchema.parse(validState);
    expect(parsed.eventHandlers).toEqual({});
    expect(parsed).not.toHaveProperty("custom");
  });

  const skip = { reason: "when-false", proof: { expression: "inputs.quick", value: false } };

  test.each([
    ["a skipped run whose output says why", { status: "skipped", output: skip }],
    [
      "a run skipped because its dependencies were",
      {
        status: "skipped",
        output: { reason: "dependency-skipped", proof: { dependencies: ["lint"] } },
      },
    ],
    [
      "a switch skipped because no case matched its value",
      {
        status: "skipped",
        output: { reason: "no-matching-case", proof: { expression: "inputs.track", value: 3 } },
      },
    ],
    [
      "a failed run whose output is its error",
      { status: "failed", output: { kind: "exit", message: "boom" } },
    ],
    ["a cancelled run with no output", { status: "cancelled" }],
    ["a completed run with any JSON output", { status: "completed", output: [1, "two"] }],
  ])("accepts %s", (_label, run) => {
    const state = { ...validState, nodeRuns: { plan: { ...agentRun, ...run } } };
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  test.each([
    ["a workflow path inside the run folder", "stages/workflow.yaml", true],
    ["a workflow path escaping the run folder", "../workflow.yaml", false],
    ["an absolute workflow path", "/work/workflow.yaml", false],
  ])("%s parses: %p", (_label, path, parses) => {
    const state = { ...validState, workflow: { name: "feature", path } };
    expect(StateSchema.safeParse(state).success).toBe(parses);
  });

  test("EH4 — custom holds any JSON and eventHandlers keeps absolute module paths", () => {
    const eventHandlers = { "custom.review.note": [{ module: "/repo/review.ts", handler: "f" }] };
    const custom = { review: { notes: ["a", 1, null] } };
    expect(StateSchema.parse({ ...validState, custom, eventHandlers })).toMatchObject({
      custom,
      eventHandlers,
    });
  });

  const withRun = (run: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...validState,
    nodeRuns: { plan: { ...agentRun, ...run } },
    ...extra,
  });
  const { stage: _stage, ...runWithoutStage } = agentRun;

  test.each([
    [
      "an artifact path outside artifacts/",
      withRun({ artifacts: [{ name: "p", path: "plan.md" }] }),
    ],
    [
      "an artifact path escaping with ..",
      withRun({ artifacts: [{ name: "p", path: "artifacts/../x" }] }),
    ],
    ["agentState without stage", { ...validState, nodeRuns: { plan: runWithoutStage } }],
    ["a skipped run with no reason", withRun({ status: "skipped" })],
    [
      "a skipped run with an unknown reason",
      withRun({ status: "skipped", output: { reason: "because", proof: {} } }),
    ],
    [
      "a when-false skip whose proof has no expression",
      withRun({ status: "skipped", output: { reason: "when-false", proof: { value: false } } }),
    ],
    ["a failed run with no error output", withRun({ status: "failed" })],
    ["a node run with an unknown nodeType", withRun({ nodeType: "script" })],
    ["a node run with the removed result field", withRun({ result: null })],
    [
      "a skipped run with no reason inside a container",
      withRun({
        nodes: { lint: { ...runWithoutStage, status: "skipped", agentState: undefined } },
      }),
    ],
    ["an empty repository map", { ...validState, workspace: { path: "/w", repositories: {} } }],
    [
      "an event handler module that is not absolute",
      { ...validState, eventHandlers: { "custom.a.b": [{ module: "a.ts", handler: "f" }] } },
    ],
    ["a relative runDir", { ...validState, runDir: ".yok/add-login" }],
    ["a scope other than null", { ...validState, scope: "feature" }],
    ["a null status", { ...validState, status: null }],
    [
      "an unknown workspace type",
      { ...validState, workspace: { ...validState.workspace, type: "poly" } },
    ],
    ["the removed options field", { ...validState, options: {} }],
    ["the removed specName field", { ...validState, specName: "add-login" }],
  ])("rejects %s", (_label, state) => {
    expect(StateSchema.safeParse(state).success).toBe(false);
  });
});

const baseEvent = {
  schemaVersion: 1,
  seq: 1,
  id: "evt-1",
  ts: "2026-09-26T10:00:00Z",
  type: "workflow.started",
  source: "runner",
  runId: "r-test",
  payload: { anything: true },
};
const nodeFields = { nodeId: "plan", nodeRunId: "plan-1" };

describe("EventSchema", () => {
  test.each([
    ["a workflow-wide event", baseEvent],
    [
      "a generic node lifecycle event",
      { ...baseEvent, type: "workflow.node.started", ...nodeFields },
    ],
    ["an artifact event", { ...baseEvent, type: "artifact.registered" }],
    ["a hooks event", { ...baseEvent, type: "hooks.pre_tool.blocked" }],
    ["WS4 — a workspace event", { ...baseEvent, type: "workspace.created" }],
    ["a workspace repository event", { ...baseEvent, type: "workspace.repository.add-failed" }],
    ["a forge event", { ...baseEvent, type: "forge.pr.opened" }],
    ["a learning event", { ...baseEvent, type: "learning.captured" }],
    ["an agent event", { ...baseEvent, type: "agent.tokens" }],
    ["an orchestrate call event", { ...baseEvent, type: "orchestrate.next" }],
    [
      "a stage event",
      { ...baseEvent, type: "stage.planning.question", stage: "planning", ...nodeFields },
    ],
    ["a custom event", { ...baseEvent, type: "custom.acme.ping", payload: "opaque" }],
  ])("accepts %s", (_label, event) => {
    expect(EventSchema.safeParse(event).success).toBe(true);
  });

  test.each([
    ["an unknown namespace", { ...baseEvent, type: "billing.charged" }],
    ["a bare namespace", { ...baseEvent, type: "workflow" }],
    ["a custom event without an event name", { ...baseEvent, type: "custom.acme" }],
    ["nodeId without nodeRunId", { ...baseEvent, nodeId: "plan" }],
    ["stage without node IDs", { ...baseEvent, stage: "planning" }],
    [
      "a stage event whose stage field differs from its type",
      { ...baseEvent, type: "stage.planning.question", stage: "review", ...nodeFields },
    ],
    ["a stage event without node IDs", { ...baseEvent, type: "stage.planning.question" }],
    ["seq 0", { ...baseEvent, seq: 0 }],
    ["an event without a runId", { ...baseEvent, runId: undefined }],
    ["an unknown envelope field", { ...baseEvent, extra: 1 }],
    ["an undefined payload", { ...baseEvent, payload: undefined }],
    ["a BigInt payload", { ...baseEvent, payload: 1n }],
    ["a NaN nested in the payload", { ...baseEvent, payload: { n: Number.NaN } }],
    ["a function payload", { ...baseEvent, payload: () => null }],
  ])("rejects %s", (_label, event) => {
    expect(EventSchema.safeParse(event).success).toBe(false);
  });
});

describe("tierLaunch", () => {
  test("a tier model gives the model and effort a session launches with; none gives neither", () => {
    expect(tierLaunch({ model: "opus", effort: "high" })).toEqual({
      model: "opus",
      effort: "high",
    });
    expect(tierLaunch({ model: "haiku" })).toEqual({ model: "haiku" });
    expect(tierLaunch(null)).toEqual({});
  });
});

describe("ResolvedTiersSchema", () => {
  const OPUS = { model: "opus" };

  test.each([
    ["a camelCase default and tier", { default: "deepThink", models: { deepThink: OPUS } }, true],
    ["a kebab-case default", { default: "deep-think", models: { deep: OPUS } }, false],
    [
      "a kebab-case tier name",
      { default: "deep", models: { deep: OPUS, "deep-think": OPUS } },
      false,
    ],
  ])("%s parses: %p", (_label, tiers, parses) => {
    expect(ResolvedTiersSchema.safeParse(tiers).success).toBe(parses);
  });
});
