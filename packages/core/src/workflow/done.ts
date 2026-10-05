import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ArtifactRef, JsonValue, NodeRun, Result } from "@yok/sdk";
import * as z from "zod";
import type { PlanAgentNode, PlanStage } from "./types.ts";
import { VerifierIssueSchema } from "./verifiers.ts";

// Whether a done is acceptable: the checks every done gets, and the artifacts a stage reads.
// runs.ts reads and writes the run's records (state.json, event.jsonl); this file never does.

// Why a done is rejected; each issue names what to fix.
export const CompletionIssueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("output-schema"),
    schema: z.string(),
    path: z.string(),
    message: z.string(),
  }),
  z.strictObject({ kind: z.literal("required-artifact"), name: z.string() }),
  z.strictObject({
    kind: z.literal("artifact-file"),
    name: z.string(),
    path: z.string(),
    reason: z.enum(["missing", "not-file", "outside-run", "invalid-artifacts-dir"]),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("artifact-name"),
    name: z.string(),
    reason: z.literal("duplicate"),
  }),
  ...VerifierIssueSchema.options,
]);
export type CompletionIssue = z.infer<typeof CompletionIssueSchema>;

// Each name passed again after its first time.
const duplicateIssues = (artifacts: readonly ArtifactRef[]): readonly CompletionIssue[] =>
  artifacts.flatMap((artifact, index): CompletionIssue[] =>
    artifacts.slice(0, index).some((earlier) => earlier.name === artifact.name)
      ? [{ kind: "artifact-name", name: artifact.name, reason: "duplicate" }]
      : [],
  );

const requiredIssues = (
  stage: PlanStage | undefined,
  artifacts: readonly ArtifactRef[],
): readonly CompletionIssue[] =>
  (stage?.produces ?? [])
    .filter((produced) => !produced.optional)
    .filter((produced) => !artifacts.some((artifact) => artifact.name === produced.artifact))
    .map((produced) => ({ kind: "required-artifact", name: produced.artifact }));

// The run's artifacts/ folder, resolved, or undefined when it is not a real folder in the run.
const findArtifactsDir = async (runDir: string): Promise<string | undefined> => {
  try {
    const [dir, run] = await Promise.all([realpath(join(runDir, "artifacts")), realpath(runDir)]);
    return dir === join(run, "artifacts") ? dir : undefined;
  } catch {
    return undefined;
  }
};

// Whether `child` sits inside `parent`. Pass real paths (realpath) so a symlink cannot lead out.
export const isInsideDir = (parent: string, child: string): boolean => {
  const fromParent = relative(parent, child);
  return !(isAbsolute(fromParent) || fromParent === ".." || fromParent.startsWith("../"));
};

const fileIssue = async (
  runDir: string,
  artifactsDir: string,
  artifact: ArtifactRef,
): Promise<readonly CompletionIssue[]> => {
  const path = join(runDir, artifact.path);
  const { name } = artifact;
  try {
    const actual = await realpath(path);
    const outside = !isInsideDir(artifactsDir, actual);
    if (!outside && (await stat(actual)).isFile()) return [];
    const reason = outside ? "outside-run" : "not-file";
    const message = `artifact ${name}: ${path} must be a file inside artifacts/`;
    return [{ kind: "artifact-file", name, path, reason, message }];
  } catch {
    const message = `artifact ${name}: ${path} does not exist`;
    return [{ kind: "artifact-file", name, path, reason: "missing", message }];
  }
};

const verifyArtifacts = async (
  runDir: string,
  stage: PlanStage | undefined,
  artifacts: readonly ArtifactRef[],
): Promise<readonly CompletionIssue[]> => {
  const named = [...duplicateIssues(artifacts), ...requiredIssues(stage, artifacts)];
  const artifactsDir = await findArtifactsDir(runDir);
  if (artifactsDir === undefined) {
    const path = join(runDir, "artifacts");
    const message = `run artifacts/ must be a real directory inside ${runDir}`;
    return [
      ...named,
      { kind: "artifact-file", name: "artifacts", path, reason: "invalid-artifacts-dir", message },
    ];
  }
  const files = await Promise.all(
    artifacts.map((artifact) => fileIssue(runDir, artifactsDir, artifact)),
  );
  return [...named, ...files.flat()];
};

// What is wrong with a done before any verifier runs: its artifact files and its output's schema.
// The schema a node's output must match, or undefined when the node takes plain text.
const findOutputSchema = (
  node: PlanAgentNode,
): Readonly<{ name: string; schema: z.ZodType }> | undefined => {
  if (node.stage !== undefined) return node.stage.output;
  if (node.output === undefined || node.outputSchema === undefined) return undefined;
  return { name: node.output.zodSchema, schema: node.outputSchema };
};

// The output a done hands in: kept as text, or parsed as JSON when the node names a schema.
export const readOutput = (
  node: PlanAgentNode,
  text: string,
): Result<JsonValue, CompletionIssue> => {
  const declared = findOutputSchema(node);
  if (declared === undefined) return { ok: true, value: text };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    const message = "output is not valid JSON";
    return {
      ok: false,
      error: { kind: "output-schema", schema: declared.name, path: "", message },
    };
  }
};

export const findDefaultIssues = async (
  node: PlanAgentNode,
  output: JsonValue,
  artifacts: readonly ArtifactRef[],
  runDir: string,
): Promise<readonly CompletionIssue[]> => {
  const artifactIssues = await verifyArtifacts(runDir, node.stage, artifacts);
  const declared = findOutputSchema(node);
  const parsed = declared?.schema.safeParse(output);
  const name = declared?.name ?? "text";
  const schemaIssues: CompletionIssue[] =
    parsed === undefined || parsed.success
      ? []
      : parsed.error.issues.map(
          (issue): CompletionIssue => ({
            kind: "output-schema",
            schema: name,
            path: issue.path.map(String).join("."),
            message: issue.message,
          }),
        );
  return [...artifactIssues, ...schemaIssues];
};

const completedRuns = (runs: Readonly<Record<string, NodeRun>>): readonly NodeRun[] =>
  Object.values(runs).flatMap((run) => [
    ...(run.status === "completed" ? [run] : []),
    ...completedRuns(run.nodes ?? {}),
  ]);

// The artifacts a stage consumes that a completed node listed; when several did, the latest wins.
export const findConsumedArtifacts = (
  stage: PlanStage,
  nodeRuns: Readonly<Record<string, NodeRun>>,
): readonly ArtifactRef[] => {
  const newestFirst = [...completedRuns(nodeRuns)].sort((a, b) =>
    (b.completedAt ?? "").localeCompare(a.completedAt ?? ""),
  );
  const listed = newestFirst.flatMap((run) => run.artifacts);
  return stage.consumes.flatMap(({ artifact }) => {
    const ref = listed.find((candidate) => candidate.name === artifact);
    return ref === undefined ? [] : [ref];
  });
};
