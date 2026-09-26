import { describe, expect, test } from "bun:test";
import { EventSchema, StageSchema, StateSchema } from "./contracts.ts";

const validStage = {
  name: "planning",
  description: "Turn a selected task into an implementation plan.",
  run: { skill: "planning" },
  mode: "subagent",
  tags: ["planning", "design"],
  "allowed-tools": ["Read", "Write"],
  tier: "balanced",
  inputs: { description: "Task context.", schema: "planning.input.v1" },
  outputs: { description: "Planning result.", schema: "planning.output.v1" },
  consumes: [{ artifact: "design", optional: true }],
  produces: [{ artifact: "plan" }],
  protocols: ["artifact-registration"],
  scopes: ["feature"],
};

describe("StageSchema", () => {
  test("a full stage parses and produce entries default optional to false", () => {
    const stage = StageSchema.parse(validStage);
    expect(stage.produces).toEqual([{ artifact: "plan", optional: false }]);
  });
});

const agentRun = {
  nodeRunId: "plan-1",
  nodeId: "plan",
  index: 1,
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
  activeNodeRuns: ["plan-1"],
  nodeRuns: { "plan-1": agentRun },
};

describe("StateSchema", () => {
  test("a state with one running agent node run parses", () => {
    expect(StateSchema.safeParse(validState).success).toBe(true);
  });

  const withRun = (run: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    ...validState,
    nodeRuns: { "plan-1": { ...agentRun, ...run } },
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
    ["agentState without stage", { ...validState, nodeRuns: { "plan-1": runWithoutStage } }],
    ["a skipped run with no reason", withRun({ status: "skipped" }, { activeNodeRuns: [] })],
    ["a nodeRuns key that differs from nodeRunId", withRun({ nodeRunId: "other" })],
    ["a missing parent run", withRun({ parentNodeRunId: "ghost" })],
    ["an active run that is not running", withRun({ status: "completed" })],
    ["duplicate active IDs", { ...validState, activeNodeRuns: ["plan-1", "plan-1"] }],
    ["an empty repository map", { ...validState, workspace: { path: "/w", repositories: {} } }],
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
    ["a worktree event", { ...baseEvent, type: "worktree.created", repoId: "app" }],
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
    ["an unknown envelope field", { ...baseEvent, extra: 1 }],
    ["an undefined payload", { ...baseEvent, payload: undefined }],
    ["a BigInt payload", { ...baseEvent, payload: 1n }],
    ["a NaN nested in the payload", { ...baseEvent, payload: { n: Number.NaN } }],
    ["a function payload", { ...baseEvent, payload: () => null }],
  ])("rejects %s", (_label, event) => {
    expect(EventSchema.safeParse(event).success).toBe(false);
  });
});
