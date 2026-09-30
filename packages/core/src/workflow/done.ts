import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { ArtifactRef, JsonValue, NodeRun } from "@harness/sdk";
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

const fileIssue = async (
  runDir: string,
  artifactsDir: string,
  artifact: ArtifactRef,
): Promise<readonly CompletionIssue[]> => {
  const path = join(runDir, artifact.path);
  const { name } = artifact;
  try {
    const actual = await realpath(path);
    const fromArtifacts = relative(artifactsDir, actual);
    const outside =
      isAbsolute(fromArtifacts) || fromArtifacts === ".." || fromArtifacts.startsWith("../");
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
export const findDefaultIssues = async (
  node: PlanAgentNode,
  output: JsonValue,
  artifacts: readonly ArtifactRef[],
  runDir: string,
): Promise<readonly CompletionIssue[]> => {
  const artifactIssues = await verifyArtifacts(runDir, node.stage, artifacts);
  const schema = node.stage?.outputSchema ?? node.outputSchema ?? z.json();
  const parsed = schema.safeParse(output);
  const name = node.stage?.outputSchemaName ?? node.output?.zodSchema ?? "json";
  const schemaIssues: CompletionIssue[] = parsed.success
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
