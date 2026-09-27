import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import type { JsonValue } from "../contracts.ts";
import { expressionPaths, isWholeExpression } from "./evaluate.ts";
import {
  type LoopNode,
  NodeFailure,
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

const ancestorsOf = (sorted: readonly WorkflowNode[]): ReadonlyMap<string, ReadonlySet<string>> =>
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

export const walkNodes = (nodes: readonly WorkflowNode[]): WorkflowNode[] =>
  nodes.flatMap((node) =>
    node.type === "switch"
      ? [node, ...node.cases.flatMap((c) => walkNodes(c.nodes)), ...walkNodes(node.default ?? [])]
      : node.type === "loop"
        ? [node, ...walkNodes(node.nodes)]
        : [node],
  );

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

const compileIncludes = async (
  nodes: readonly WorkflowNode[],
  chain: readonly string[],
  cwd: string,
): Promise<ReadonlyMap<string, WorkflowPlan>> => {
  const targets = [
    ...new Set(walkNodes(nodes).flatMap((n) => (n.type === "include" ? [n.workflow] : []))),
  ];
  if (targets.length > 0 && chain.length > MAX_INCLUDE_DEPTH) {
    throw new WorkflowError(
      "include-limit",
      `includes nest deeper than ${MAX_INCLUDE_DEPTH}: ${chain.join(" -> ")}`,
    );
  }
  const compiled = await Promise.all(
    targets.map(async (target) => {
      const included = resolve(cwd, target);
      if (chain.includes(included)) {
        throw new WorkflowError(
          "include-recursion",
          `include cycle: ${[...chain, included].join(" -> ")}`,
          target,
        );
      }
      return [target, await compileFile(included, [...chain, included], cwd)] as const;
    }),
  );
  return new Map(compiled);
};

const sizeOf = (
  nodes: readonly WorkflowNode[],
  includes: ReadonlyMap<string, WorkflowPlan>,
): number =>
  walkNodes(nodes).reduce(
    (total, n) => total + 1 + (n.type === "include" ? (includes.get(n.workflow)?.size ?? 0) : 0),
    0,
  );

async function compileFile(
  path: string,
  chain: readonly string[],
  cwd: string,
): Promise<WorkflowPlan> {
  const source = await readWorkflow(path);
  const workflow = parseWorkflow(source);
  const nodes = validateScope(workflow.nodes, "");
  const includes = await compileIncludes(nodes, chain, cwd);
  const size = sizeOf(nodes, includes);
  if (size > MAX_EXPANDED_NODES) {
    throw new WorkflowError("include-limit", `${path} expands to ${size} nodes`, path);
  }
  const includeHashes = [...includes.entries()]
    .map(([name, plan]) => `${name}:${plan.hash}`)
    .sort();
  return Object.freeze({
    name: workflow.name,
    inputs: workflow.inputs,
    maxConcurrency: workflow.maxConcurrency,
    nodes,
    includes,
    size,
    hash: createHash("sha256").update(source).update(includeHashes.join("\n")).digest("hex"),
  });
}

export type CompileOptions = Readonly<{ cwd?: string }>;

export const compileWorkflow = (
  path: string,
  options: CompileOptions = {},
): Promise<WorkflowPlan> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const absolute = resolve(cwd, path);
  return compileFile(absolute, [absolute], cwd);
};
