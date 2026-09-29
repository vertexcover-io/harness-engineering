import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { JsonValue } from "@harness/sdk";
import { parseDocument } from "yaml";
import { findStageDir, loadSkill } from "../stage.ts";
import { expressionPaths, isWholeExpression } from "./evaluate.ts";
import {
  type IncludeNode,
  type LoopNode,
  NodeFailure,
  type PlanNode,
  type PlanStage,
  type SwitchNode,
  type Workflow,
  WorkflowError,
  type WorkflowNode,
  type WorkflowPlan,
  WorkflowSchema,
} from "./types.ts";

const parseWorkflow = (source: string): Workflow => {
  const document = parseDocument(source);
  const [yamlError] = document.errors;
  if (yamlError) throw new WorkflowError("yaml", yamlError.message);
  const parsed = WorkflowSchema.safeParse(document.toJS());
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const path = issue?.path.join(".") ?? "";
  throw new WorkflowError("schema", `${path}: ${issue?.message ?? "invalid workflow"}`, path);
};

const checkIds = (nodes: readonly WorkflowNode[], scope: string): void => {
  const ids = nodes.map((node) => node.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate !== undefined) {
    throw new WorkflowError("duplicate-id", `duplicate id "${duplicate}"`, scope + duplicate);
  }
  const missing = nodes.find((node) => node.dependsOn.some((dep) => !ids.includes(dep)));
  if (missing !== undefined) {
    const dep = missing.dependsOn.find((d) => !ids.includes(d));
    throw new WorkflowError(
      "missing-dependency",
      `${missing.id} depends on unknown "${dep}"`,
      scope + missing.id,
    );
  }
};

const sortTopologically = (nodes: readonly WorkflowNode[], scope: string): WorkflowNode[] => {
  const placed: WorkflowNode[] = [];
  const remaining = [...nodes];
  while (remaining.length > 0) {
    const index = remaining.findIndex((node) =>
      node.dependsOn.every((dep) => placed.some((p) => p.id === dep)),
    );
    if (index === -1) {
      throw new WorkflowError(
        "cycle",
        `dependency cycle among: ${remaining.map((n) => n.id).join(", ")}`,
        scope,
      );
    }
    placed.push(...remaining.splice(index, 1));
  }
  return placed;
};

const ancestorsOf = (
  sorted: readonly Readonly<{ id: string; dependsOn: readonly string[] }>[],
): ReadonlyMap<string, ReadonlySet<string>> =>
  sorted.reduce(
    (map, node) =>
      map.set(node.id, new Set(node.dependsOn.flatMap((dep) => [dep, ...(map.get(dep) ?? [])]))),
    new Map<string, Set<string>>(),
  );

const expressionFields = (node: WorkflowNode): JsonValue[] => [
  node.input,
  ...(node.type === "switch" ? [node.expression] : node.when === undefined ? [] : [node.when]),
];

const checkSingleExpressions = (node: WorkflowNode, scope: string): void => {
  const text = node.type === "switch" ? node.expression : node.when;
  if (text !== undefined && !isWholeExpression(text)) {
    throw new WorkflowError(
      "invalid-expression",
      `${node.id}: "${text}" must be exactly one {{ expression }}`,
      scope + node.id,
    );
  }
};

const checkCases = (node: SwitchNode, scope: string): void => {
  const ids = node.cases.map((c) => c.id);
  const values = node.cases.map((c) => JSON.stringify(c.value));
  const repeated = (list: string[]) => list.find((item, index) => list.indexOf(item) !== index);
  const bad = ids.includes("default")
    ? "case id default is reserved"
    : (repeated(ids) ?? repeated(values));
  if (bad !== undefined)
    throw new WorkflowError(
      "schema",
      `${node.id}: duplicate or reserved case ${bad}`,
      scope + node.id,
    );
};

const pathsOf = (
  node: WorkflowNode,
  scope: string,
  fields: JsonValue[] = expressionFields(node),
): string[][] => {
  try {
    return fields.flatMap(expressionPaths);
  } catch (error) {
    if (error instanceof NodeFailure) {
      throw new WorkflowError(
        "invalid-expression",
        `${node.id}: ${error.message}`,
        scope + node.id,
      );
    }
    throw error;
  }
};

const checkReferences = (sorted: readonly WorkflowNode[], scope: string, inLoop: boolean): void => {
  const ancestors = ancestorsOf(sorted);
  for (const node of sorted) {
    const allowed = ancestors.get(node.id) ?? new Set<string>();
    const bad = pathsOf(node, scope).find(
      ([root, id = ""]) =>
        (root === "nodes" && !allowed.has(id)) ||
        (root === "iteration" && (!inLoop || id === "nodes")),
    );
    if (bad !== undefined) {
      throw new WorkflowError(
        "invalid-reference",
        `${node.id} reads ${bad.join(".")} but does not depend on "${bad[1]}"`,
        scope + node.id,
      );
    }
  }
};

const checkUntil = (node: LoopNode, scope: string): void => {
  const readsNodes = pathsOf(node, scope, [node.until]).some(([root]) => root === "nodes");
  if (!isWholeExpression(node.until) || readsNodes) {
    throw new WorkflowError(
      "invalid-reference",
      `${node.id}: until may read only inputs and iteration`,
      scope + node.id,
    );
  }
};

const compileChildren = (node: WorkflowNode, scope: string, inLoop: boolean): WorkflowNode => {
  if (node.type === "loop") {
    checkUntil(node, scope);
    return { ...node, nodes: validateScope(node.nodes, `${scope}${node.id}.`, true) };
  }
  if (node.type !== "switch") return node;
  checkCases(node, scope);
  const prefix = `${scope}${node.id}.`;
  return {
    ...node,
    cases: node.cases.map((c) => ({
      ...c,
      nodes: validateScope(c.nodes, `${prefix}${c.id}.`, inLoop),
    })),
    ...(node.default === undefined
      ? {}
      : { default: validateScope(node.default, `${prefix}default.`, inLoop) }),
  };
};

function validateScope(
  nodes: readonly WorkflowNode[],
  scope: string,
  inLoop = false,
): WorkflowNode[] {
  checkIds(nodes, scope);
  for (const node of nodes) checkSingleExpressions(node, scope);
  const sorted = sortTopologically(nodes, scope);
  checkReferences(sorted, scope, inLoop);
  return sorted.map((node) => compileChildren(node, scope, inLoop));
}

const readWorkflow = async (path: string): Promise<string> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new WorkflowError("missing-workflow", `cannot read workflow ${path}: ${reason}`, path);
  }
};

const MAX_INCLUDE_DEPTH = 8;
const MAX_EXPANDED_NODES = 1000;

const loadStage = async (ref: string, cwd: string): Promise<PlanStage> => {
  const dir = findStageDir(ref, cwd);
  const stage = await loadSkill(dir);
  if (!stage.ok) throw new WorkflowError("missing-stage", `stage ${ref}: ${stage.error}`, ref);
  return {
    ref,
    name: stage.value.name,
    skill: join(dir, "SKILL.md"),
    consumes: stage.value.consumes ?? [],
    produces: stage.value.produces ?? [],
  };
};

// Where compile is: the chain of workflow files that led here, for include cycles and depth, and
// the ids of the containers around the nodes being compiled.
type Compiling = Readonly<{ chain: readonly string[]; cwd: string; parents: readonly string[] }>;

const compileInclude = async (node: IncludeNode, at: Compiling): Promise<WorkflowPlan> => {
  if (at.chain.length > MAX_INCLUDE_DEPTH) {
    const chain = at.chain.join(" -> ");
    throw new WorkflowError(
      "include-limit",
      `includes nest deeper than ${MAX_INCLUDE_DEPTH}: ${chain}`,
    );
  }
  const included = resolve(at.cwd, node.workflow);
  if (at.chain.includes(included)) {
    const cycle = [...at.chain, included].join(" -> ");
    throw new WorkflowError("include-recursion", `include cycle: ${cycle}`, node.workflow);
  }
  const parents = [...at.parents, node.id];
  return compileFile(included, { ...at, chain: [...at.chain, included], parents });
};

const compileNodes = (nodes: readonly WorkflowNode[], at: Compiling): Promise<PlanNode[]> =>
  Promise.all(nodes.map((node) => compileNode(node, at)));

// Turns a checked node into the node the engine runs: stages and includes are loaded into it.
async function compileNode(node: WorkflowNode, at: Compiling): Promise<PlanNode> {
  const { parents } = at;
  const inside: Compiling = { ...at, parents: [...parents, node.id] };
  if (node.type === "include") return { ...node, parents, plan: await compileInclude(node, at) };
  if (node.type === "loop") {
    return { ...node, parents, nodes: await compileNodes(node.nodes, inside) };
  }
  if (node.type === "agent") {
    const { stage, ...rest } = node;
    if (stage === undefined) return { ...rest, parents };
    return { ...rest, parents, stage: await loadStage(stage, at.cwd) };
  }
  if (node.type !== "switch") return { ...node, parents };
  const { cases, default: fallback, ...rest } = node;
  const compiled = await Promise.all(
    cases.map(async (c) => ({ ...c, nodes: await compileNodes(c.nodes, inside) })),
  );
  if (fallback === undefined) return { ...rest, parents, cases: compiled };
  return { ...rest, parents, cases: compiled, default: await compileNodes(fallback, inside) };
}

// The lists of nodes a compiled node holds. Every case of a switch counts: compile cannot know
// which one runs.
const listChildren = (node: PlanNode): readonly (readonly PlanNode[])[] => {
  if (node.type === "loop") return [node.nodes];
  if (node.type === "include") return [node.plan.nodes];
  if (node.type !== "switch") return [];
  return [...node.cases.map((c) => c.nodes), ...(node.default === undefined ? [] : [node.default])];
};

// The nodes a workflow runs, counting those of the workflows it includes.
const countNodes = (nodes: readonly PlanNode[]): number =>
  nodes.reduce(
    (total, node) =>
      total +
      1 +
      listChildren(node)
        .map(countNodes)
        .reduce((a, b) => a + b, 0),
    0,
  );

async function compileFile(path: string, at: Compiling): Promise<WorkflowPlan> {
  const workflow = parseWorkflow(await readWorkflow(path));
  const nodes = await compileNodes(validateScope(workflow.nodes, ""), at);
  const size = countNodes(nodes);
  if (size > MAX_EXPANDED_NODES) {
    throw new WorkflowError("include-limit", `${path} expands to ${size} nodes`, path);
  }
  return Object.freeze({ name: workflow.name, inputs: workflow.inputs, nodes });
}

// The artifacts written once `node` has ended: its own stage's, and those of every node inside it.
const listProducedArtifacts = (node: PlanNode): readonly string[] => [
  ...(node.type === "agent" ? (node.stage?.produces ?? []) : []).map((p) => p.artifact),
  ...listChildren(node).flatMap((nodes) => nodes.flatMap(listProducedArtifacts)),
];

// A stage may start only once every artifact it needs is written, so each one must come from a
// node it depends on, directly or through a chain, or from a node its container depends on.
const checkArtifacts = (
  nodes: readonly PlanNode[],
  written: ReadonlySet<string>,
  scope: string,
): void => {
  const ancestors = ancestorsOf(nodes);
  for (const node of nodes) {
    const deps = nodes.filter((candidate) => ancestors.get(node.id)?.has(candidate.id));
    const before = new Set([...written, ...deps.flatMap(listProducedArtifacts)]);
    const stage = node.type === "agent" ? node.stage : undefined;
    const missing = stage?.consumes.find((c) => !c.optional && !before.has(c.artifact));
    if (missing !== undefined) {
      const makers = nodes.filter((n) => listProducedArtifacts(n).includes(missing.artifact));
      const fix =
        makers.length === 0
          ? "no node in this scope produces it"
          : `add dependsOn: [${makers.map((n) => n.id).join(", ")}]`;
      throw new WorkflowError(
        "missing-artifact",
        `${scope}${node.id} needs artifact "${missing.artifact}", but no node it depends on produces it; ${fix}`,
        scope + node.id,
      );
    }
    for (const children of listChildren(node)) {
      checkArtifacts(children, before, `${scope}${node.id}.`);
    }
  }
};

// cwd is the project root: relative workflow paths and stage paths resolve against it.
export type CompileOptions = Readonly<{ cwd?: string }>;

export const compileWorkflow = async (
  path: string,
  options: CompileOptions = {},
): Promise<WorkflowPlan> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const absolute = resolve(cwd, path);
  const plan = await compileFile(absolute, { chain: [absolute], cwd, parents: [] });
  checkArtifacts(plan.nodes, new Set(), "");
  return plan;
};
