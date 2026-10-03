import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmitInput, Event, JsonObject, JsonValue, NodeRun, State } from "@harness/sdk";
import { builtInHandlers, projectEvents } from "@harness/sdk/internal";
import { compileWorkflow } from "./compile.ts";
import { type Decision, decideNext } from "./next.ts";
import { DEMO_STAGES, writeStages } from "./test-stages.ts";
import type { WorkflowPlan } from "./types.ts";

type Stop = Decision;

// Compiles SOURCE as main.yml in a fresh folder that also holds any included workflow FILES and
// the demo stages under stages/.
const compilePlan = (
  source: string,
  files: Readonly<Record<string, string>> = {},
): Promise<WorkflowPlan> => {
  const root = mkdtempSync(join(tmpdir(), "wf-step-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  writeStages(join(root, "stages"), DEMO_STAGES);
  const path = join(root, "main.yml");
  writeFileSync(path, source);
  return compileWorkflow(path, { cwd: root });
};

const start = (input: JsonObject = {}): State => ({
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-1",
  runName: "demo",
  runDir: "/work/.harness/demo",
  version: "2.0.0",
  workflow: { name: "demo", path: "workflow.yaml" },
  input,
  scope: null,
  startedAt: "2026-09-28T09:00:00Z",
  completedAt: null,
  status: "running",
  workspace: {
    type: "mono",
    path: "/work",
    repositories: {
      app: { path: "/work", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  nodeRuns: {},
  activeSessions: [],
  eventHandlers: {},
});

// Stores one event the way emitRunEvent would: next seq, then the core reducers.
const apply = (state: State, draft: EmitInput): State => {
  const seq = state.lastEventSeq + 1;
  const event: Event = {
    ...draft,
    schemaVersion: 1,
    seq,
    id: `e${seq}`,
    ts: new Date(Date.UTC(2026, 8, 28, 9, 0, seq)).toISOString(),
    runId: "r-1",
  };
  return projectEvents({ state, events: [event], handlers: builtInHandlers });
};

type Advanced = Readonly<{ state: State; stop: Stop; events: readonly EmitInput[] }>;

// What one `orchestrate next` does, with events stored in memory instead of event.jsonl.
const advance = async (plan: WorkflowPlan, state: State): Promise<Advanced> => {
  const events: EmitInput[] = [];
  const emit = async (current: State, event: EmitInput): Promise<State> => {
    events.push(event);
    return apply(current, event);
  };
  const { state: after, decision } = await decideNext(plan, state, emit);
  return { state: after, stop: decision, events };
};

// Where a node run sits in state.json's tree: its node id and the ids of the containers above it.
const locateRun = (
  nodes: Readonly<Record<string, NodeRun>>,
  nodeRunId: string,
  parents: readonly string[] = [],
): Readonly<{ nodeId: string; parents: readonly string[] }> | undefined => {
  for (const [nodeId, run] of Object.entries(nodes)) {
    if (run.nodeRunId === nodeRunId) return { nodeId, parents };
    const inside = locateRun(run.nodes ?? {}, nodeRunId, [...parents, nodeId]);
    if (inside !== undefined) return inside;
  }
  return undefined;
};

// What `orchestrate exec` records when a leaf ends.
const end = (
  state: State,
  nodeRunId: string,
  status: "completed" | "failed",
  extra: Readonly<Record<string, JsonValue>> = {},
): State => {
  const where = locateRun(state.nodeRuns, nodeRunId);
  if (where === undefined) throw new Error(`no node run ${nodeRunId}`);
  const parents = where.parents.length === 0 ? {} : { parents: [...where.parents] };
  const payload = { nodeType: "exec", attempts: 1, ...parents, ...extra };
  return apply(state, {
    type: `workflow.node.${status}`,
    source: "test",
    nodeId: where.nodeId,
    nodeRunId,
    payload,
  });
};

const expectLeaf = (stop: Stop): Extract<Decision, { kind: "leaf" }> => {
  if (stop.kind !== "leaf") throw new Error(`expected a leaf, got ${stop.kind}`);
  return stop;
};

// The node's entry in state.json, found by the ids from the top of the workflow down to it.
const findRun = (state: State, ...ids: readonly string[]): NodeRun | undefined =>
  ids.reduce<NodeRun | undefined>(
    (run, id, depth) => (depth === 0 ? state.nodeRuns[id] : run?.nodes?.[id]),
    undefined,
  );

const exec = (id: string, extra = ""): string => `
  - id: ${id}
    type: exec
    runtime: sh
    script: "true"${extra}`;

describe("decideNext", () => {
  test("IW1 — a is handed out alone, and b is handed out after it with a's output as its input", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", '\n    dependsOn: [a]\n    input: "{{ nodes.a.output.n }}"')}
`);
    const first = await advance(plan, start());
    const a = expectLeaf(first.stop);
    expect(a.node.id).toBe("a");
    expect(a.nodeRunId).toMatch(/^nr-[0-9a-f]{16}$/);
    expect((await advance(plan, first.state)).stop).toEqual({
      kind: "waiting",
      nodeRunId: a.nodeRunId,
    });

    const afterA = end(first.state, a.nodeRunId, "completed", { output: { n: 7 } });
    const second = await advance(plan, afterA);
    const b = expectLeaf(second.stop);
    expect(b.node.id).toBe("b");
    expect(b.nodeRunId).toMatch(/^nr-[0-9a-f]{16}$/);
    expect(findRun(second.state, "b")).toMatchObject({
      nodeRunId: b.nodeRunId,
      input: 7,
      status: "running",
    });
  });

  test("IW2 — a node whose when is false is skipped without starting, and so is the node depending on it", async () => {
    const plan = await compilePlan(`name: t
inputs:
  flag: { type: boolean, required: true }
nodes:${exec("a", '\n    when: "{{ inputs.flag }}"\n    input: {}')}${exec("b", "\n    dependsOn: [a]\n    input: {}")}
`);
    const done = await advance(plan, start({ flag: false }));
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "a")).toMatchObject({
      status: "skipped",
      output: { reason: "when-false", proof: { expression: "{{ inputs.flag }}", value: false } },
    });
    expect(findRun(done.state, "b")).toMatchObject({
      status: "skipped",
      output: { reason: "dependency-skipped", proof: { dependencies: ["a"] } },
    });
    expect(done.events.map((event) => event.payload)).toContainEqual(
      expect.objectContaining({ skip: expect.objectContaining({ reason: "when-false" }) }),
    );
  });

  test("IW42 — a dependency-skipped node names only the dependencies that were skipped", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", '\n    when: "{{ false }}"\n    input: {}')}${exec("b", "\n    input: {}")}${exec("c", "\n    dependsOn: [a, b]\n    input: {}")}
`);
    const first = await advance(plan, start());
    const b = expectLeaf(first.stop);
    const done = await advance(plan, end(first.state, b.nodeRunId, "completed", { output: {} }));
    expect(done.events[0]).toMatchObject({
      type: "workflow.node.skipped",
      nodeId: "c",
      payload: { skip: { reason: "dependency-skipped", proof: { dependencies: ["a"] } } },
    });
  });

  test("IW3 — after a fails, neither its dependent b nor the independent c starts, and the run ends failed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${exec("c", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const error = { kind: "exit", message: "exited with code 3" };
    const failed = end(first.state, expectLeaf(first.stop).nodeRunId, "failed", { error });
    expect((await advance(plan, failed)).events[0]).toMatchObject({ type: "workflow.failed" });
    const done = await advance(plan, failed);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "b")).toBeUndefined();
    expect(findRun(done.state, "c")).toBeUndefined();
  });

  test("a failed node with allowFailure lets its dependent and the nodes after it run, and the run ends completed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    allowFailure: true\n    input: {}")}${exec("b", '\n    dependsOn: [a]\n    input: "{{ nodes.a.status }}"')}${exec("c", "\n    input: {}")}
`);
    const { state, inputs } = await runLeaves(plan, start(), ["failed", "completed", "completed"]);
    expect(inputs).toEqual([{}, "failed", {}]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "a")?.status).toBe("failed");
  });

  test("an allowed failure does not hide an ordinary failure after it: the run still ends failed", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    allowFailure: true\n    input: {}")}${exec("b", "\n    input: {}")}${exec("c", "\n    input: {}")}
`);
    const { state } = await runLeaves(plan, start(), ["failed", "failed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "c")).toBeUndefined();
  });

  test("IW4 — while background a runs, nothing else starts, not even independent c; then b and c follow one at a time", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    mode: background\n    input: {}")}${exec("b", "\n    dependsOn: [a]\n    input: {}")}${exec("c", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const a = expectLeaf(first.stop);
    expect(a.node).toMatchObject({ id: "a", mode: "background" });
    expect((await advance(plan, first.state)).stop).toEqual({
      kind: "waiting",
      nodeRunId: a.nodeRunId,
    });

    const afterA = end(first.state, a.nodeRunId, "completed", { output: {} });
    const second = await advance(plan, afterA);
    const b = expectLeaf(second.stop);
    expect(b.node.id).toBe("b");
    expect((await advance(plan, second.state)).stop).toEqual({
      kind: "waiting",
      nodeRunId: b.nodeRunId,
    });
    const afterB = end(second.state, b.nodeRunId, "completed", { output: {} });
    expect(expectLeaf((await advance(plan, afterB)).stop).node.id).toBe("c");
  });

  test("IW5 — once every node has ended the run is recorded completed, and every later call replies finished", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const ended = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    expect((await advance(plan, ended)).events[0]).toMatchObject({ type: "workflow.completed" });
    const done = await advance(plan, ended);
    expect(done.state).toMatchObject({ status: "completed", completedAt: expect.any(String) });
    expect((await advance(plan, done.state)).stop).toEqual({
      kind: "finished",
      status: "completed",
    });
  });

  test("IW6 — an input that reads a missing field fails that node at start with a resolution error", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("a", "\n    input: {}")}${exec("b", '\n    dependsOn: [a]\n    input: "{{ nodes.a.output.missing }}"')}
`);
    const first = await advance(plan, start());
    const afterA = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", { output: {} });
    expect((await advance(plan, afterA)).events[0]).toMatchObject({
      type: "workflow.node.failed",
      nodeId: "b",
      payload: { error: { kind: "resolution" } },
    });
    const done = await advance(plan, afterA);
    expect(findRun(done.state, "b")).toMatchObject({ status: "failed", startedAt: null });
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
  });
});

const stage = (id: string, name: string, extra = ""): string => `
  - id: ${id}
    type: agent
    stage: stages/${name}${extra}`;

const PLAN_ARTIFACT = { artifacts: [{ name: "plan", path: "artifacts/plan.md" }] };

describe("decideNext with stage and agent nodes", () => {
  test("IW13 — a stage node is handed out with its resolved input, and its reported output feeds the next node", async () => {
    const plan = await compilePlan(`name: t
inputs:
  prompt: { type: string, required: true }
nodes:${stage("make", "producer", '\n    input: { request: "{{ inputs.prompt }}" }')}${exec("b", '\n    dependsOn: [make]\n    input: "{{ nodes.make.output.ok }}"')}
`);
    const first = await advance(plan, start({ prompt: "hi" }));
    const make = expectLeaf(first.stop);
    expect(make).toMatchObject({
      node: { id: "make", stage: { ref: "stages/producer" } },
      input: { request: "hi" },
      variables: {},
    });
    const afterMake = end(first.state, make.nodeRunId, "completed", { output: { ok: true } });
    const b = expectLeaf((await advance(plan, afterMake)).stop);
    expect(b).toMatchObject({ node: { id: "b" }, input: true });
  });

  test("a stage node is handed out with its skill's variable defaults under the node's own values, an expression read like its input", async () => {
    const plan = await compilePlan(`name: t
inputs:
  who: { type: string, required: true }
nodes:${stage("say", "tuned", '\n    input: {}\n    variables: { audience: "{{ inputs.who }}" }')}
`);
    const say = expectLeaf((await advance(plan, start({ who: "devs" }))).stop);
    expect(say.variables).toEqual({ tone: "plain", audience: "devs" });
    const overridden = await compilePlan(`name: t
nodes:${stage("shout", "tuned", "\n    input: {}\n    variables: { tone: loud, audience: all }")}
`);
    const shout = expectLeaf((await advance(overridden, start())).stop);
    expect(shout.variables).toEqual({ tone: "loud", audience: "all" });
  });

  test.each([
    ["reads a missing input", "{{ inputs.nobody }}", "nobody"],
    ["is not a string", "{{ inputs.count }}", "string"],
  ])("a stage node whose variable %s fails before it starts", async (_label, value, message) => {
    const plan = await compilePlan(`name: t
inputs:
  count: { type: number, default: 3 }
nodes:${stage("say", "tuned", `\n    input: {}\n    variables: { audience: "${value}" }`)}
`);
    const done = await advance(plan, start());
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "say")).toMatchObject({
      status: "failed",
      startedAt: null,
      output: { kind: "resolution", message: expect.stringContaining(message) },
    });
  });

  test("IW14 — a stage whose producer completed without its artifact is blocked, and is handed out once the producer lists it", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("use", "consumer", "\n    dependsOn: [make]\n    input: {}")}${stage("make", "producer", "\n    input: {}")}
`);
    const first = await advance(plan, start());
    const make = expectLeaf(first.stop);
    expect(make.node.id).toBe("make");
    expect(findRun(first.state, "use")).toBeUndefined();
    expect((await advance(plan, first.state)).stop).toEqual({
      kind: "waiting",
      nodeRunId: make.nodeRunId,
    });

    const withoutPlan = end(first.state, make.nodeRunId, "completed", { output: {} });
    expect((await advance(plan, withoutPlan)).stop).toEqual({
      kind: "blocked",
      nodeId: "use",
      stage: "stages/consumer",
      missing: ["plan"],
    });
    const withPlan = end(first.state, make.nodeRunId, "completed", {
      output: {},
      ...PLAN_ARTIFACT,
    });
    expect(expectLeaf((await advance(plan, withPlan)).stop).node.id).toBe("use");
  });

  test("IW15 — an optional consumed artifact never blocks its stage", async () => {
    const plan = await compilePlan(`name: t
nodes:${stage("read", "reader", "\n    input: {}")}
`);
    expect(expectLeaf((await advance(plan, start())).stop).node.id).toBe("read");
  });

  test("IW16 — an agent node with a prompt and no stage is handed out with its input", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: ask
    type: agent
    prompt: summarise
    input: { text: x }
`);
    const ask = expectLeaf((await advance(plan, start())).stop);
    expect(ask).toMatchObject({ node: { id: "ask", prompt: "summarise" }, input: { text: "x" } });
  });
});

const SWITCH = `name: t
inputs:
  kind: { type: string, required: true }
nodes:
  - id: decide
    type: switch
    expression: "{{ inputs.kind }}"
    input: {}
    cases:
      - id: a
        value: a
        nodes:
          - { id: one, type: exec, runtime: sh, script: "true", input: {} }
      - id: b
        value: b
        nodes:
          - { id: two, type: exec, runtime: sh, script: "true", input: {} }
  - id: after
    type: exec
    runtime: sh
    script: "true"
    dependsOn: [decide]
    input: "{{ nodes.decide.output }}"
`;

const loop = (until: string, maxIterations: number, extra = ""): string => `name: t
nodes:
  - id: fix
    type: loop
    until: "${until}"
    maxIterations: ${maxIterations}
    input: {}
    nodes:
      - { id: test, type: exec, runtime: sh, script: "true", input: "pass {{ iteration.index }}" }${extra}
`;

type Leaves = Readonly<{ state: State; inputs: readonly JsonValue[] }>;

// Hands out a leaf and ends it with each status in turn, as the skill would.
const runLeaves = async (
  plan: WorkflowPlan,
  state: State,
  statuses: readonly ("completed" | "failed")[],
  inputs: readonly JsonValue[] = [],
): Promise<Leaves> => {
  const [status, ...rest] = statuses;
  if (status === undefined) return { state, inputs };
  const next = await advance(plan, state);
  const leaf = expectLeaf(next.stop);
  const extra =
    status === "completed"
      ? { output: `out ${inputs.length + 1}` }
      : { error: { kind: "exit", message: "exited with code 1" } };
  const ended = end(next.state, leaf.nodeRunId, status, extra);
  return await runLeaves(plan, ended, rest, [...inputs, leaf.input]);
};

describe("decideNext with containers", () => {
  test("IW22 — a switch hands out only the matching case's node, records the case, and its output feeds what follows", async () => {
    const plan = await compilePlan(SWITCH);
    const first = await advance(plan, start({ kind: "b" }));
    const two = expectLeaf(first.stop);
    const decide = findRun(first.state, "decide");
    expect(two.node.id).toBe("two");
    expect(decide).toMatchObject({ status: "running", branch: "b" });
    expect(findRun(first.state, "decide", "two")?.nodeRunId).toBe(two.nodeRunId);

    const afterTwo = end(first.state, two.nodeRunId, "completed", { output: { x: 1 } });
    const next = await advance(plan, afterTwo);
    expect(expectLeaf(next.stop)).toMatchObject({ node: { id: "after" }, input: { x: 1 } });
    expect(findRun(next.state, "decide")).toMatchObject({
      status: "completed",
      output: { x: 1 },
    });
    expect(findRun(next.state, "decide", "one")).toBeUndefined();
  });

  test("IW23 — a switch with no matching case and no default is skipped, and so is what depends on it", async () => {
    const done = await advance(await compilePlan(SWITCH), start({ kind: "c" }));
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "decide")).toMatchObject({
      status: "skipped",
      output: {
        reason: "no-matching-case",
        proof: { expression: "{{ inputs.kind }}", value: "c" },
      },
    });
    expect(findRun(done.state, "after")).toMatchObject({
      status: "skipped",
      output: { reason: "dependency-skipped", proof: { dependencies: ["decide"] } },
    });
  });

  test("IW43 — a switch's output is null when the last node of its case did not complete", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: decide
    type: switch
    expression: "{{ 'go' }}"
    input: {}
    cases:
      - id: go
        value: go
        nodes:
          - { id: one, type: exec, runtime: sh, script: "true", input: {} }
          - { id: two, type: exec, runtime: sh, script: "true", when: "{{ false }}", input: {} }
`);
    const first = await advance(plan, start());
    const one = expectLeaf(first.stop);
    const done = await advance(plan, end(first.state, one.nodeRunId, "completed", { output: 1 }));
    expect(findRun(done.state, "decide")).toMatchObject({ status: "completed", output: null });
  });

  test("IW24 — a loop runs its body one pass at a time until until holds, and state keeps only the current pass", async () => {
    const plan = await compilePlan(loop("{{ iteration.index >= 3 }}", 5));
    const { state, inputs } = await runLeaves(plan, start(), ["completed", "completed"]);
    expect(inputs).toEqual(["pass 1", "pass 2"]);
    const third = await advance(plan, state);
    expect(expectLeaf(third.stop).input).toBe("pass 3");
    expect(findRun(third.state, "fix")).toMatchObject({
      status: "running",
      iteration: 3,
      output: "out 2",
    });
    expect(Object.keys(findRun(third.state, "fix")?.nodes ?? {})).toEqual(["test"]);
    expect(findRun(third.state, "fix", "test")).toMatchObject({
      status: "running",
      input: "pass 3",
    });

    const finished = end(third.state, expectLeaf(third.stop).nodeRunId, "completed", {
      output: "out 3",
    });
    const done = await advance(plan, finished);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "fix")).toMatchObject({
      status: "completed",
      iteration: 3,
      output: "out 3",
    });
  });

  test("IW44 — a loop's output, and so iteration.previous, is the output of the last node in its body", async () => {
    const report = `
      - { id: report, type: exec, runtime: sh, script: "true", dependsOn: [test], input: "{{ iteration.previous }}" }`;
    const plan = await compilePlan(loop("{{ iteration.index >= 2 }}", 3, report));
    const firstPass = await runLeaves(plan, start(), ["completed", "completed"]);
    const second = await advance(plan, firstPass.state);
    expect(second.events).toContainEqual(
      expect.objectContaining({
        type: "workflow.node.iterated",
        payload: expect.objectContaining({ output: "out 2" }),
      }),
    );
    const { state, inputs } = await runLeaves(plan, firstPass.state, ["completed", "completed"]);
    expect(inputs).toEqual(["pass 2", "out 2"]);
    const done = await advance(plan, state);
    expect(findRun(done.state, "fix")).toMatchObject({ status: "completed", output: "out 2" });
  });

  test("a qa loop that ends BLOCKED skips the commit gated on its verdict, and the pr after it", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: qa-loop
    type: loop
    until: "{{ iteration.nodes.qa.output.status != 'FAIL' }}"
    maxIterations: 4
    input: {}
    nodes:
      - { id: qa, type: exec, runtime: sh, script: "true", input: {} }${exec("commit", `\n    dependsOn: [qa-loop]\n    when: "{{ nodes.qa-loop.output.status != 'BLOCKED' }}"\n    input: {}`)}${exec("pr", "\n    dependsOn: [commit]\n    input: {}")}
`);
    const qa = await advance(plan, start());
    const blocked = end(qa.state, expectLeaf(qa.stop).nodeRunId, "completed", {
      output: { status: "BLOCKED" },
    });
    const done = await advance(plan, blocked);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "commit")).toMatchObject({
      status: "skipped",
      output: { reason: "when-false" },
    });
    expect(findRun(done.state, "pr")).toMatchObject({
      status: "skipped",
      output: { reason: "dependency-skipped", proof: { dependencies: ["commit"] } },
    });
  });

  test("IW45 — a loop whose last body node did not complete hands null to its next pass", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: fix
    type: loop
    until: "{{ iteration.index >= 2 }}"
    maxIterations: 3
    input: {}
    nodes:
      - { id: test, type: exec, runtime: sh, script: "true", input: "{{ iteration.previous }}" }
      - { id: tail, type: exec, runtime: sh, script: "true", when: "{{ false }}", input: {} }
`);
    const firstPass = await runLeaves(plan, start(), ["completed"]);
    const second = await advance(plan, firstPass.state);
    expect(second.events).toContainEqual(
      expect.objectContaining({
        type: "workflow.node.iterated",
        payload: expect.objectContaining({ output: null }),
      }),
    );
    expect(expectLeaf(second.stop).input).toBeNull();
  });

  test("IW46 — a loop's body and its until read iteration.max as the loop's maxIterations", async () => {
    const plan = await compilePlan(
      loop("{{ iteration.index == iteration.max }}", 2).replace(
        'input: "pass {{ iteration.index }}"',
        'input: "pass {{ iteration.index }} of {{ iteration.max }}"',
      ),
    );
    const { state, inputs } = await runLeaves(plan, start(), ["completed", "completed"]);
    expect(inputs).toEqual(["pass 1 of 2", "pass 2 of 2"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
  });

  test("IW25 — a loop whose until never holds fails as exhausted after maxIterations passes", async () => {
    const plan = await compilePlan(loop("{{ false }}", 2));
    const { state, inputs } = await runLeaves(plan, start(), ["completed", "completed"]);
    expect(inputs).toHaveLength(2);
    expect((await advance(plan, state)).events[0]).toMatchObject({
      type: "workflow.node.failed",
      nodeId: "fix",
      payload: { error: { kind: "exhausted" } },
    });
    expect((await advance(plan, state)).stop).toEqual({ kind: "finished", status: "failed" });
  });

  test("IW41 — a loop whose until cannot be worked out fails with a resolution error", async () => {
    const plan = await compilePlan(loop("{{ iteration.nodes.test.output.x.y }}", 3));
    const { state } = await runLeaves(plan, start(), ["completed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(done.events[0]).toMatchObject({
      type: "workflow.node.failed",
      nodeId: "fix",
      payload: { error: { kind: "resolution" } },
    });
  });

  test("IW26 — a failure in a loop pass fails the loop, starts no further pass, and stops the run", async () => {
    const other = `
  - { id: other, type: exec, runtime: sh, script: "true", input: {} }`;
    const plan = await compilePlan(loop("{{ iteration.index >= 3 }}", 5, other));
    const { state } = await runLeaves(plan, start(), ["failed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "fix")?.status).toBe("failed");
    expect(findRun(done.state, "fix")?.iteration).toBe(1);
    expect(findRun(done.state, "fix", "test")?.status).toBe("failed");
    expect(findRun(done.state, "other")).toBeUndefined();
  });

  test("a failed body node with allowFailure does not fail its loop", async () => {
    const source = loop("{{ iteration.index >= 1 }}", 3).replace(
      'script: "true", input',
      'script: "true", allowFailure: true, input',
    );
    const plan = await compilePlan(source);
    const { state } = await runLeaves(plan, start(), ["failed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "fix")?.status).toBe("completed");
    expect(findRun(done.state, "fix", "test")?.status).toBe("failed");
  });

  test("an allowed failure in a loop body does not hide an ordinary failure after it: the loop fails", async () => {
    const source = loop("{{ iteration.index >= 1 }}", 3).replace(
      'script: "true", input: "pass {{ iteration.index }}" }',
      'script: "true", allowFailure: true, input: {} }\n      - { id: check, type: exec, runtime: sh, script: "true", input: {} }',
    );
    const plan = await compilePlan(source);
    const { state } = await runLeaves(plan, start(), ["failed", "failed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "fix")?.status).toBe("failed");
  });

  test("a container with allowFailure ends failed when a child fails, and the run goes on and completes", async () => {
    const other = `
  - { id: other, type: exec, runtime: sh, script: "true", input: {} }`;
    const source = loop("{{ iteration.index >= 1 }}", 3, other).replace(
      "    maxIterations",
      "    allowFailure: true\n    maxIterations",
    );
    const plan = await compilePlan(source);
    const { state } = await runLeaves(plan, start(), ["failed", "completed"]);
    const done = await advance(plan, state);
    expect(done.stop).toEqual({ kind: "finished", status: "completed" });
    expect(findRun(done.state, "fix")?.status).toBe("failed");
    expect(findRun(done.state, "other")?.status).toBe("completed");
  });

  test("IW27 — an include runs the included workflow with its defaults applied, and fails at start on a wrong-typed input", async () => {
    const child = `name: child
inputs:
  word: { type: string, default: hi }
nodes:
  - { id: say, type: exec, runtime: sh, script: "true", input: "{{ inputs.word }}" }
`;
    const main = (input: string) => `name: t
nodes:
  - { id: sub, type: include, workflow: child.yml, input: ${input} }
`;
    const plan = await compilePlan(main("{}"), { "child.yml": child });
    const first = await advance(plan, start());
    const say = expectLeaf(first.stop);
    expect(say).toMatchObject({ node: { id: "say" }, input: "hi" });
    expect(findRun(first.state, "sub", "say")?.nodeRunId).toBe(say.nodeRunId);

    const bad = await compilePlan(main("{ word: 3 }"), { "child.yml": child });
    expect((await advance(bad, start())).events[0]).toMatchObject({
      type: "workflow.node.failed",
      nodeId: "sub",
      payload: { error: { kind: "validation" } },
    });
    const done = await advance(bad, start());
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "sub", "say")).toBeUndefined();
  });
});

// outer holds inner, then f; inner holds the producer stage x, then the consumer stage y after it.
const NESTED = `name: t
nodes:
  - id: outer
    type: switch
    expression: "{{ 'go' }}"
    input: {}
    cases:
      - id: go
        value: go
        nodes:
          - id: inner
            type: switch
            expression: "{{ 'go' }}"
            input: {}
            cases:
              - id: go
                value: go
                nodes:
                  - { id: x, type: agent, stage: stages/producer, input: {} }
                  - { id: y, type: agent, stage: stages/consumer, dependsOn: [x], input: {} }
          - { id: f, type: exec, runtime: sh, script: "true", input: {} }
`;

describe("decideNext inside nested containers", () => {
  test("IW29 — a blocked stage deep inside containers stops the run: f, which does not depend on it, never starts", async () => {
    const plan = await compilePlan(NESTED);
    const first = await advance(plan, start());
    const x = expectLeaf(first.stop);
    const second = await advance(plan, end(first.state, x.nodeRunId, "completed", { output: {} }));
    expect(second.stop).toEqual({
      kind: "blocked",
      nodeId: "y",
      stage: "stages/consumer",
      missing: ["plan"],
    });
    expect(findRun(second.state, "outer", "f")).toBeUndefined();
  });

  test("IW35 — a failure inside a nested container fails it and every container around it, and nothing after it starts", async () => {
    const plan = await compilePlan(NESTED);
    const first = await advance(plan, start());
    const x = expectLeaf(first.stop);
    const error = { kind: "exit", message: "exited with code 1" };
    const done = await advance(plan, end(first.state, x.nodeRunId, "failed", { error }));
    expect(done.stop).toEqual({ kind: "finished", status: "failed" });
    expect(findRun(done.state, "outer", "inner", "y")).toBeUndefined();
    expect(findRun(done.state, "outer", "inner")?.status).toBe("failed");
    expect(findRun(done.state, "outer", "f")).toBeUndefined();
    expect(findRun(done.state, "outer")?.status).toBe("failed");
  });
});

// A switch on `inputs.value` with a case for the number 1 and a default.
const TYPED_SWITCH = `name: t
inputs:
  value: { type: object, required: true }
nodes:
  - id: decide
    type: switch
    expression: "{{ inputs.value.v }}"
    input: {}
    cases:
      - id: one
        value: 1
        nodes:${exec("a", "\n    input: {}").replaceAll("\n  ", "\n          ")}
    default:${exec("other", "\n    input: {}").replaceAll("\n  ", "\n      ")}
`;

describe("decideNext on inputs, when and switch values", () => {
  test("IW36 — workflow inputs get their defaults, and inputs that break their declarations are refused", async () => {
    const plan = await compilePlan(`name: t
inputs:
  name: { type: string, required: true }
  count: { type: number, default: 2 }
nodes:${exec("show", '\n    input: "{{ inputs }}"')}
`);
    expect(expectLeaf((await advance(plan, start({ name: "x" }))).stop).input).toEqual({
      name: "x",
      count: 2,
    });
    for (const [input, named] of [
      [{}, "name"],
      [{ name: 5 }, "name"],
      [{ name: "x", extra: 1 }, "extra"],
    ] as const) {
      await expect(advance(plan, start(input))).rejects.toThrow(named);
    }
  });

  test("IW37 — a when that is not a boolean fails the node at start instead of skipping it", async () => {
    const plan = await compilePlan(`name: t
inputs:
  name: { type: string, required: true }
nodes:${exec("a", '\n    when: "{{ inputs.name }}"\n    input: {}')}
`);
    expect((await advance(plan, start({ name: "x" }))).events[0]).toMatchObject({
      type: "workflow.node.failed",
      payload: { error: { kind: "resolution" } },
    });
  });

  test("IW38 — case values match by type as well as by value: the string '1' takes the default", async () => {
    const plan = await compilePlan(TYPED_SWITCH);
    expect(expectLeaf((await advance(plan, start({ value: { v: 1 } }))).stop).node.id).toBe("a");
    expect(expectLeaf((await advance(plan, start({ value: { v: "1" } }))).stop).node.id).toBe(
      "other",
    );
  });

  test("IW39 — a switch expression that is missing or not a scalar fails the switch at start", async () => {
    const plan = await compilePlan(TYPED_SWITCH);
    for (const value of [{}, { v: { a: 1 } }]) {
      const done = await advance(plan, start({ value }));
      expect(done.stop).toEqual({ kind: "finished", status: "failed" });
      expect(findRun(done.state, "decide")?.status).toBe("failed");
      expect(findRun(done.state, "decide", "a")).toBeUndefined();
    }
  });

  test("IW40 — nodes named after Object.prototype keys still run", async () => {
    const plan = await compilePlan(`name: t
nodes:${exec("toString", "\n    input: {}")}${exec("hasOwnProperty", "\n    dependsOn: [toString]\n    input: {}")}
`);
    const first = await advance(plan, start());
    expect(expectLeaf(first.stop).node.id).toBe("toString");
    const afterFirst = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", {
      output: {},
    });
    expect(expectLeaf((await advance(plan, afterFirst)).stop).node.id).toBe("hasOwnProperty");
  });
});

const CONTEXT_FLOW = `name: t
nodes:
  - { id: first, type: agent, prompt: one, input: {} }
  - { id: fresh, type: context, action: new, dependsOn: [first] }
  - { id: second, type: agent, prompt: two, dependsOn: [fresh], input: {} }
`;

describe("context node", () => {
  test("next hands out a context node as a step, then the node after it once it completes", async () => {
    const plan = await compilePlan(CONTEXT_FLOW);
    const first = await advance(plan, start());
    const afterFirst = end(first.state, expectLeaf(first.stop).nodeRunId, "completed", {
      output: {},
    });

    const context = expectLeaf((await advance(plan, afterFirst)).stop);
    expect(context.node).toMatchObject({ id: "fresh", type: "context", action: "new" });

    const handed = await advance(plan, afterFirst);
    const afterContext = end(handed.state, expectLeaf(handed.stop).nodeRunId, "completed", {
      output: { action: "new", sessionId: "B" },
    });
    expect(expectLeaf((await advance(plan, afterContext)).stop).node.id).toBe("second");
  });

  test("a context node in a loop is handed out again on every pass", async () => {
    const plan = await compilePlan(`name: t
nodes:
  - id: fix
    type: loop
    until: "{{ iteration.index >= 2 }}"
    maxIterations: 3
    input: {}
    nodes:
      - { id: slim, type: context, action: compact }
`);
    const ids: string[] = [];
    let state = start();
    for (let pass = 0; pass < 2; pass++) {
      const handed = await advance(plan, state);
      const leaf = expectLeaf(handed.stop);
      expect(leaf.node).toMatchObject({ id: "slim", action: "compact" });
      ids.push(leaf.nodeRunId);
      state = end(handed.state, leaf.nodeRunId, "completed", { output: {} });
    }
    expect(new Set(ids).size).toBe(2);
  });
});

describe("the shipped task workflow's qa loop", () => {
  const TASK_WORKFLOW = join(import.meta.dir, "..", "..", "..", "..", "workflows", "task.yaml");
  const bug = { scenario: "SC1", cause: "the total skips refunds", fix: "subtract refunds" };
  const report = "artifacts/verification/proof-report.html";
  const VERDICTS: Readonly<Record<string, JsonObject>> = {
    PASS: { status: "PASS", report, gaps: [], bugs: [] },
    PARTIAL: { status: "PARTIAL", reason: "SC2 not verified", report, gaps: [], bugs: [] },
    FAIL: {
      status: "FAIL",
      reason: "SC1 failed",
      report: null,
      gaps: [],
      bugs: [{ ...bug, needsDecision: false }],
    },
  };
  const OUTPUTS: Readonly<Record<string, JsonObject>> = { "ticket-fetcher": { task: "do X" } };
  // Every artifact a stage in task.yaml consumes, listed on each finished node so none is blocked.
  const artifacts = ["design", "plan", "implementation"].map((name) => ({
    name,
    path: `artifacts/${name}.md`,
  }));

  type Handed = Readonly<{ id: string; input: JsonValue }>;
  type Walked = Readonly<{ state: State; stop: Stop; handed: readonly Handed[] }>;

  // Walks task.yaml as the session would, answering each qa pass with the next verdict, and keeps
  // the fix and qa leaves it was handed.
  const walkTask = async (
    plan: WorkflowPlan,
    state: State,
    verdicts: readonly string[],
    handed: readonly Handed[] = [],
  ): Promise<Walked> => {
    const next = await advance(plan, state);
    if (next.stop.kind !== "leaf") return { state: next.state, stop: next.stop, handed };
    const { node, nodeRunId, input } = next.stop;
    const isQa = node.id === "qa";
    const output = isQa ? (VERDICTS[verdicts[0] ?? ""] ?? null) : (OUTPUTS[node.id] ?? {});
    const ended = end(next.state, nodeRunId, "completed", { nodeType: "agent", output, artifacts });
    const inLoop = isQa || node.id === "fix";
    return walkTask(
      plan,
      ended,
      isQa ? verdicts.slice(1) : verdicts,
      inLoop ? [...handed, { id: node.id, input }] : handed,
    );
  };

  test("SC13: a first PASS runs qa once, as round 1 of 4, and its verdict is the loop's output", async () => {
    const { state, stop, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      ["PASS"],
    );

    expect(handed).toMatchObject([{ id: "qa", input: { task: "do X", round: 1, rounds: 4 } }]);
    expect(findRun(state, "qa-loop")).toMatchObject({ status: "completed", output: VERDICTS.PASS });
    expect(stop).toEqual({ kind: "finished", status: "completed" });
  });

  test("SC14: a FAIL hands its bugs to fix as feedback, then qa runs again as round 2", async () => {
    const { state, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      ["FAIL", "PARTIAL"],
    );

    expect(handed.map((leaf) => leaf.id)).toEqual(["qa", "fix", "qa"]);
    expect(handed[1]?.input).toMatchObject({ feedback: [{ ...bug, needsDecision: false }] });
    expect(handed[2]?.input).toMatchObject({ round: 2, rounds: 4 });
    expect(findRun(state, "qa-loop")).toMatchObject({
      status: "completed",
      output: VERDICTS.PARTIAL,
    });
  });

  test("SC15: four FAILs fail the loop on its fourth pass, after three fix rounds, and the run fails", async () => {
    const { state, stop, handed } = await walkTask(
      await compileWorkflow(TASK_WORKFLOW),
      start({ prompt: "p" }),
      ["FAIL", "FAIL", "FAIL", "FAIL"],
    );

    expect(handed.map((leaf) => leaf.id)).toEqual(["qa", "fix", "qa", "fix", "qa", "fix", "qa"]);
    expect(findRun(state, "qa-loop")).toMatchObject({
      status: "failed",
      iteration: 4,
    });
    expect(stop).toEqual({ kind: "finished", status: "failed" });
  });
});
