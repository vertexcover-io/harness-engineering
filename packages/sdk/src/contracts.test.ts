import { describe, expect, test } from "bun:test";
import { EventSchema, StateSchema } from "./contracts.ts";

const agentRun = {
  nodeRunId: "plan-1",
  status: "running",
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  result: null,
  artifacts: [{ name: "plan", path: "artifacts/plan-1/plan.md" }],
  stage: "planning",
  agentState: { agent: "claude", model: "opus", sessionId: null, tokens: null },
};

const validState = {
  schemaVersion: 1,
  lastEventSeq: 0,
  specName: "add-login",
  harnessVersion: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: { prompt: "add login" },
  scope: "feature",
  options: {},
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  outcome: null,
  currentFile: null,
  workspace: {
    path: "/work/add-login",
    repositories: {
      app: { path: "/work/add-login", git: { branch: "b", baseBranch: "main", startSha: "abc" } },
    },
  },
  nodeRuns: { plan: agentRun },
};

describe("StateSchema", () => {
  test("a state with one running agent node run parses", () => {
    expect(StateSchema.safeParse(validState).success).toBe(true);
  });

  test("EH3 — a state.json written before custom and eventHandlers existed parses with both empty", () => {
    expect(StateSchema.parse(validState)).toMatchObject({ custom: {}, eventHandlers: {} });
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
    [
      "a workflow path other than workflow.yaml",
      { ...validState, workflow: { name: "f", path: "w.yaml" } },
    ],
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
