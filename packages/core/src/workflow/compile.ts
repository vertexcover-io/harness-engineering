import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type CheckoutConfig, type JsonValue, runDirOf } from "@yok/sdk";
import { parseDocument } from "yaml";
import { z } from "zod";
import { loadSkill, noProjectConfig, own } from "../stage.ts";
import { expressionPaths, expressionsIn, isWholeExpression } from "./evaluate.ts";
import { importModule } from "./executors.ts";
import {
  type AgentNode,
  type DoctorDeclaration,
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
import { loadVerifiers } from "./verifiers.ts";

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

const variableValues = (node: WorkflowNode): string[] =>
  node.type === "agent" ? Object.values(node.variables ?? {}) : [];

const expressionFields = (node: WorkflowNode): JsonValue[] => [
  node.input,
  ...(node.type === "switch" ? [node.expression] : node.when === undefined ? [] : [node.when]),
  ...variableValues(node),
];

// A variable is plain text or one whole expression, never text around an expression.
const checkSingleExpressions = (node: WorkflowNode, scope: string): void => {
  const guard = node.type === "switch" ? node.expression : node.when;
  const templated = variableValues(node).filter((value) => expressionsIn(value).length > 0);
  const text = [guard, ...templated].find(
    (value) => value !== undefined && !isWholeExpression(value),
  );
  if (text !== undefined) {
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

const collectExpressionPaths = (
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
    const bad = collectExpressionPaths(node, scope).find(
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
    checkAlwaysReads(node, scope);
  }
};

// Refuses an `always` node whose input, `when` or variables read `nodes.X`. Such a node can start
// after X never ran (a failure before X stopped it, and a node that never ran has no result), so
// the read would fail the `always` node at start, in the one case it exists for.
const checkAlwaysReads = (node: WorkflowNode, scope: string): void => {
  if (!node.always) return;
  const read = collectExpressionPaths(node, scope).find(([root]) => root === "nodes");
  if (read === undefined) return;
  throw new WorkflowError(
    "invalid-reference",
    `${node.id} is always: true, so it can start when "${read[1]}" never ran; it cannot read ${read.join(".")}`,
    scope + node.id,
  );
};

const checkUntil = (node: LoopNode, scope: string): void => {
  const readsNodes = collectExpressionPaths(node, scope, [node.until]).some(
    ([root]) => root === "nodes",
  );
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

export const readWorkflowFile = async (path: string): Promise<Workflow> =>
  parseWorkflow(await readWorkflow(path));

const MAX_INCLUDE_DEPTH = 8;
const MAX_EXPANDED_NODES = 1000;

// chain is the include path so far, used to stop cycles and deep nesting.
type Compiling = Readonly<{
  chain: readonly string[];
  cwd: string;
  parents: readonly string[];
  config: CheckoutConfig;
}>;

const resolveOutputSchema = async (
  ref: Readonly<{ module?: string | undefined; zodSchema: string }>,
  cwd: string,
  location: string,
): Promise<z.ZodType> => {
  if (ref.module === undefined) {
    if (ref.zodSchema === "Json") return z.json();
    throw new WorkflowError("missing-schema", `${location}: output.module is required`, location);
  }
  const loaded = await importModule(ref.module, cwd);
  const registry = z.record(z.string(), z.unknown()).safeParse(loaded.schemas);
  const schema = registry.success ? registry.data[ref.zodSchema] : undefined;
  if (schema instanceof z.ZodType) return schema;
  throw new WorkflowError(
    "missing-schema",
    `${location}: ${ref.module} has no schemas["${ref.zodSchema}"]`,
    location,
  );
};

const loadPlanStage = async (ref: string, at: Compiling): Promise<PlanStage> => {
  const skill = await loadSkill(ref, { root: at.cwd, config: at.config });
  if (!skill.ok) throw new WorkflowError("missing-stage", `stage ${ref}: ${skill.error}`, ref);
  const { dir, frontmatter } = skill.value;
  const { outputs } = frontmatter;
  if (outputs !== undefined && outputs.module === undefined) {
    throw new WorkflowError("missing-schema", `stage ${ref}: outputs.module is required`, ref);
  }
  const output =
    outputs?.module === undefined
      ? undefined
      : {
          name: outputs.schema,
          schema: await resolveOutputSchema(
            { module: outputs.module, zodSchema: outputs.schema },
            dir,
            `stage ${ref}`,
          ),
        };
  return {
    ref,
    name: skill.value.name,
    skill: join(dir, "SKILL.md"),
    tier: frontmatter.tier,
    consumes: frontmatter.consumes ?? [],
    produces: frontmatter.produces ?? [],
    variables: frontmatter.variables,
    ...(output === undefined ? {} : { output }),
    verifiers: await loadVerifiers(frontmatter.verifiers, dir),
  };
};

// A stage node sets only the variables its skill declares, and every one the skill gives no default.
const checkVariables = (node: AgentNode, stage: PlanStage): void => {
  const set = node.variables ?? {};
  const unknown = Object.keys(set).find((name) => own(stage.variables, name) === undefined);
  if (unknown !== undefined) {
    const known = Object.keys(stage.variables).join(", ") || "none";
    throw new WorkflowError(
      "schema",
      `${node.id}: stage ${stage.ref} has no variable "${unknown}"; it has: ${known}`,
      node.id,
    );
  }
  const unset = Object.keys(stage.variables).find(
    (name) => stage.variables[name]?.default === undefined && own(set, name) === undefined,
  );
  if (unset !== undefined) {
    throw new WorkflowError(
      "schema",
      `${node.id}: stage ${stage.ref} needs variable "${unset}", which has no default; set it in variables`,
      node.id,
    );
  }
};

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

async function compileNode(node: WorkflowNode, at: Compiling): Promise<PlanNode> {
  const { parents } = at;
  const inside: Compiling = { ...at, parents: [...parents, node.id] };
  if (node.type === "include") return { ...node, parents, plan: await compileInclude(node, at) };
  if (node.type === "loop") {
    return { ...node, parents, nodes: await compileNodes(node.nodes, inside) };
  }
  if (node.type === "agent") {
    const { stage, ...rest } = node;
    if (stage === undefined) {
      const outputSchema =
        node.output === undefined
          ? undefined
          : await resolveOutputSchema(node.output, at.cwd, node.id);
      return { ...rest, parents, outputSchema };
    }
    if (node.output !== undefined) {
      throw new WorkflowError(
        "schema",
        `${node.id}: stage output schema is declared in SKILL.md; remove the node output override`,
        node.id,
      );
    }
    const loaded = await loadPlanStage(stage, at);
    checkVariables(node, loaded);
    return { ...rest, parents, stage: loaded };
  }
  if (node.type === "exec") {
    const outputSchema =
      node.output === undefined
        ? undefined
        : await resolveOutputSchema(node.output, at.cwd, node.id);
    return { ...node, parents, outputSchema };
  }
  if (node.type !== "switch") return { ...node, parents };
  const { cases, default: fallback, ...rest } = node;
  const compiled = await Promise.all(
    cases.map(async (c) => ({ ...c, nodes: await compileNodes(c.nodes, inside) })),
  );
  if (fallback === undefined) return { ...rest, parents, cases: compiled };
  return { ...rest, parents, cases: compiled, default: await compileNodes(fallback, inside) };
}

// Every case of a switch counts, since compile can't know which one runs.
const listChildren = (node: PlanNode): readonly (readonly PlanNode[])[] => {
  if (node.type === "loop") return [node.nodes];
  if (node.type === "include") return [node.plan.nodes];
  if (node.type !== "switch") return [];
  return [...node.cases.map((c) => c.nodes), ...(node.default === undefined ? [] : [node.default])];
};

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

const doctorOf = (nodes: readonly PlanNode[]): readonly DoctorDeclaration[] =>
  nodes.flatMap((node) =>
    node.type === "include" ? node.plan.doctor : listChildren(node).flatMap(doctorOf),
  );

// First seen wins, so the top workflow's checks lead.
const uniqueDeclarations = (
  declarations: readonly DoctorDeclaration[],
): readonly DoctorDeclaration[] => {
  const seen = new Map(declarations.map((d) => [JSON.stringify([d.check, d.key, d.fix]), d]));
  return [...seen.values()];
};

async function compileFile(path: string, at: Compiling): Promise<WorkflowPlan> {
  const workflow = await readWorkflowFile(path);
  const nodes = await compileNodes(validateScope(workflow.nodes, ""), at);
  const size = countNodes(nodes);
  if (size > MAX_EXPANDED_NODES) {
    throw new WorkflowError("include-limit", `${path} expands to ${size} nodes`, path);
  }
  const doctor = uniqueDeclarations([...workflow.doctor, ...doctorOf(nodes)]);
  return Object.freeze({
    name: workflow.name,
    agent: workflow.agent,
    tiers: workflow.tiers,
    env: workflow.env,
    envFile: workflow.envFile,
    inputs: workflow.inputs,
    doctor,
    notifier: workflow.notifier,
    nodes,
  });
}

const guaranteedInScope = (
  nodes: readonly PlanNode[],
  guaranteedOnly: boolean,
): readonly string[] => {
  const completed = new Set<string>();
  const artifacts = new Set<string>();
  for (const node of nodes) {
    const canSkip =
      (node.type !== "switch" && node.when !== undefined) ||
      node.dependsOn.some((dependency) => !completed.has(dependency)) ||
      (node.type === "switch" && node.default === undefined);
    if (canSkip) continue;
    completed.add(node.id);
    for (const artifact of listProducedArtifacts(node, guaranteedOnly)) artifacts.add(artifact);
  }
  return [...artifacts];
};

// A node that allows failure guarantees no artifact.
function listProducedArtifacts(node: PlanNode, guaranteedOnly = false): readonly string[] {
  if (guaranteedOnly && node.allowFailure) return [];
  if (node.type === "agent") {
    return (node.stage?.produces ?? [])
      .filter((produced) => !guaranteedOnly || !produced.optional)
      .map((produced) => produced.artifact);
  }
  if (node.type === "switch") {
    const branches = [
      ...node.cases.map((branch) => branch.nodes),
      ...(node.default === undefined ? [] : [node.default]),
    ];
    const [first, ...rest] = branches.map((branch) => guaranteedInScope(branch, guaranteedOnly));
    return first?.filter((artifact) => rest.every((branch) => branch.includes(artifact))) ?? [];
  }
  if (node.type === "include") return guaranteedInScope(node.plan.nodes, guaranteedOnly);
  if (node.type === "loop") return guaranteedInScope(node.nodes, guaranteedOnly);
  return [];
}

const explainMissing = (nodes: readonly PlanNode[], artifact: string): string => {
  const makers = nodes.filter((n) => listProducedArtifacts(n).includes(artifact));
  if (makers.length === 0) return "no node in this scope produces it";
  if (makers.every((maker) => !listProducedArtifacts(maker, true).includes(artifact))) {
    return "every producer declares it optional or sets allowFailure; mark the consume optional or require production";
  }
  return `add dependsOn: [${makers.map((n) => n.id).join(", ")}]`;
};

const describeMissing = (
  nodes: readonly PlanNode[],
  node: PlanNode,
  artifact: string,
  underAlways: boolean,
): string => {
  const needs = `${node.id} needs artifact "${artifact}"`;
  if (!underAlways && !node.always) {
    return `${needs}, but no node it depends on produces it; ${explainMissing(nodes, artifact)}`;
  }
  const why = node.always ? "it is always: true" : "it is inside an always: true node";
  return `${needs}, which may never be written before it starts: ${why}, so it can start after its producers failed or never ran; mark the consume optional`;
};

// Every artifact a stage needs must come from a node it depends on, directly or through its
// container, so it is written before the stage starts. An `always` node can start after those
// producers failed or never ran, so it and everything inside it count none of them.
const checkArtifacts = (
  nodes: readonly PlanNode[],
  written: ReadonlySet<string>,
  scope: string,
  underAlways = false,
): void => {
  const ancestors = ancestorsOf(nodes);
  for (const node of nodes) {
    const always = underAlways || node.always;
    const deps = nodes.filter((candidate) => ancestors.get(node.id)?.has(candidate.id));
    const before = node.always
      ? written
      : new Set([...written, ...deps.flatMap((dep) => listProducedArtifacts(dep, true))]);
    const stage = node.type === "agent" ? node.stage : undefined;
    const missing = stage?.consumes.find((c) => !c.optional && !before.has(c.artifact));
    if (missing !== undefined) {
      throw new WorkflowError(
        "missing-artifact",
        scope + describeMissing(nodes, node, missing.artifact, underAlways),
        scope + node.id,
      );
    }
    for (const children of listChildren(node)) {
      checkArtifacts(children, before, `${scope}${node.id}.`, always);
    }
  }
};

// Workflow and stage paths resolve against cwd. Without a config, no project extension applies.
export type CompileOptions = Readonly<{ cwd?: string; config?: CheckoutConfig }>;

export const compileWorkflow = async (
  path: string,
  options: CompileOptions = {},
): Promise<WorkflowPlan> => {
  const cwd = resolve(options.cwd ?? process.cwd());
  const absolute = resolve(cwd, path);
  const config = options.config ?? noProjectConfig(cwd);
  const plan = await compileFile(absolute, { chain: [absolute], cwd, parents: [], config });
  checkArtifacts(plan.nodes, new Set(), "");
  return plan;
};

// The workflow `orchestrate init` copied into the run's folder, compiled with the run's config.
export const compileRunWorkflow = (
  run: Readonly<{ cwd: string; name: string }>,
  config: CheckoutConfig,
): Promise<WorkflowPlan> =>
  compileWorkflow(join(runDirOf(run.cwd, run.name), "workflow.yaml"), { cwd: run.cwd, config });

const planStages = (nodes: readonly PlanNode[]): readonly PlanStage[] =>
  nodes.flatMap((node): readonly PlanStage[] => {
    if (node.type !== "agent") return listChildren(node).flatMap(planStages);
    return node.stage === undefined ? [] : [node.stage];
  });

// Each stage of the run's workflow by name, for findSkill's run scope.
export const runStageDirs = async (
  run: Readonly<{ cwd: string; name: string }>,
  config: CheckoutConfig,
): Promise<Readonly<Record<string, string>>> => {
  const plan = await compileRunWorkflow(run, config);
  return Object.fromEntries(
    planStages(plan.nodes).map((stage) => [stage.name, dirname(stage.skill)]),
  );
};
