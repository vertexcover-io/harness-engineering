import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type Config,
  isNormalizedRelativePath,
  NameSchema,
  NonEmptyStringSchema,
  parseFrontmatter,
  type Result,
  type RunRef,
  readText,
  SlugSchema,
  spawnDetached,
} from "@yok/sdk";
import { devPluginDir, selfArgv, VERSION } from "@yok/sdk/internal";
import * as z from "zod";

const UniqueSlugsSchema = z
  .array(SlugSchema)
  .refine((values) => new Set(values).size === values.length, "Names must be unique");
const SchemaKeySchema = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.v[1-9]\d*$/);

const ArtifactDeclarationSchema = z.strictObject({
  artifact: SlugSchema,
  optional: z.boolean().default(false),
});

const StagePortSchema = z.strictObject({
  description: NonEmptyStringSchema,
  schema: SchemaKeySchema,
});

const ReferenceSchema = z.strictObject({
  path: NonEmptyStringSchema.refine(
    isNormalizedRelativePath,
    "Expected a normalized path relative to the skill folder",
  ),
  description: NonEmptyStringSchema,
});

const verifierBase = {
  id: SlugSchema,
  args: z.json().default({}),
  timeoutMs: z.number().int().positive().default(60_000),
};

export const VerifierSchema = z.union(
  [
    z.strictObject({
      ...verifierBase,
      module: NonEmptyStringSchema,
      functionName: NonEmptyStringSchema,
    }),
    z.strictObject({
      ...verifierBase,
      runtime: z.enum(["sh", "bun"]),
      script: NonEmptyStringSchema,
    }),
  ],
  { error: "a verifier needs runtime + script, or module + functionName" },
);
export type Verifier = z.infer<typeof VerifierSchema>;

// A value the workflow's stage node sets through its `variables`; `next` hands it to the skill.
const VariableSchema = z.strictObject({
  description: NonEmptyStringSchema,
  default: z.string().optional(),
});

export const StageSchema = z.strictObject({
  name: SlugSchema,
  description: NonEmptyStringSchema,
  mode: z.enum(["inline", "subagent"]),
  tags: UniqueSlugsSchema.optional(),
  "allowed-tools": z.array(NonEmptyStringSchema),
  tier: NameSchema.optional(),
  inputs: StagePortSchema.optional(),
  outputs: StagePortSchema.extend({ module: NonEmptyStringSchema.optional() }).optional(),
  consumes: z.array(ArtifactDeclarationSchema).optional(),
  produces: z.array(ArtifactDeclarationSchema).optional(),
  protocols: UniqueSlugsSchema,
  scopes: UniqueSlugsSchema,
  references: z.record(SlugSchema, ReferenceSchema).default({}),
  verifiers: z
    .array(VerifierSchema)
    .refine(
      (list) => new Set(list.map((v) => v.id)).size === list.length,
      "Verifier ids must be unique",
    )
    .default([]),
  variables: z.record(SlugSchema, VariableSchema).default({}),
});
export type Stage = z.infer<typeof StageSchema>;
export type ArtifactDeclaration = z.infer<typeof ArtifactDeclarationSchema>;

export type SchemaRegistry = Readonly<Record<string, z.ZodType>>;

export type LoadedStage = {
  readonly stage: Stage;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
};

type ResolveOptions = Readonly<{
  skillsDir?: string | undefined;
  root: string;
  config: Config;
  skill: string;
}>;

// Parsed records inherit Object.prototype, so a key like "constructor" must not read through to it.
export const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

// Skills ship only in the agent plugin, which `yok plugin install` pins to this program's
// version, so a compiled binary reads that version's folder in the agent's plugin cache.
export const findPluginSkills = (
  env: NodeJS.ProcessEnv,
  version: string,
  home: string = homedir(),
): Result<string> => {
  const roots = [
    env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    env.CODEX_HOME || join(home, ".codex"),
  ];
  const found = roots
    .map((root) => join(root, "plugins", "cache", "yok", "yok", version, "skills"))
    .find((dir) => existsSync(dir));
  if (found !== undefined) return { ok: true, value: found };
  return {
    ok: false,
    error: `the yok plugin ${version} is not installed; run: yok plugin install --agent claude`,
  };
};

// From source the repo's skills/ is the plugin. YOK_SKILLS_DIR points tests at a demo set.
export const yokSkillsDir = (env: NodeJS.ProcessEnv = process.env): string => {
  if (env.YOK_SKILLS_DIR) return env.YOK_SKILLS_DIR;
  const repo = devPluginDir();
  if (repo !== undefined) return join(repo, "skills");
  const found = findPluginSkills(env, VERSION);
  if (!found.ok) throw new Error(found.error);
  return found.value;
};

// Agent hooks, the status line and the detached helpers start this same program again, so a
// release run calls the release binary and a dev run calls the source it started from.
export const orchestrateArgv = (): readonly [string, ...string[]] => [...selfArgv(), "orchestrate"];

// Re-runs orchestrate as a detached helper for a run's session, such as `context` or
// `limit-wait`: the hook that starts it must return before the agent goes idle.
export const spawnOrchestrateHelper = ({
  command,
  id,
  run,
  sessionId,
}: Readonly<{ command: string; id: string; run: RunRef; sessionId: string }>): void => {
  const [program, ...self] = orchestrateArgv();
  const args = [...self, command, id, "--run-id", run.id, "--session-id", sessionId];
  spawnDetached(program, args, { cwd: run.cwd, output: "ignore" });
};

// A stage name is one of yok's own skills; a stage with a "/" is a skill folder in the
// project at `root`, which needs no plugin installed, so the skills folder is looked up lazily.
export const findStageDir = (stage: string, root: string, skillsDir?: string): string =>
  stage.includes("/") ? resolve(root, stage) : join(skillsDir ?? yokSkillsDir(), stage);

// Yok's default workflows ship beside this code, like its skills.
export const yokWorkflowsDir = (): string =>
  join(import.meta.dir, "..", "..", "..", "workflows");

// A bare name is one of yok's own workflows; a name with a "/" or a .yaml/.yml extension
// is a file in the project at `cwd`.
export const findWorkflowPath = (
  workflow: string,
  cwd: string,
  workflowsDir = yokWorkflowsDir(),
): string =>
  workflow.includes("/") || /\.ya?ml$/.test(workflow)
    ? resolve(cwd, workflow)
    : join(workflowsDir, `${workflow}.yaml`);

export const loadSkill = async (skillDir: string): Promise<Result<Stage>> => {
  const path = join(skillDir, "SKILL.md");
  const text = await readText(path);
  if (!text.ok) return text;
  const frontmatter = parseFrontmatter(text.value, path);
  if (!frontmatter.ok) return frontmatter;
  const parsed = StageSchema.safeParse(frontmatter.value);
  if (!parsed.success) return { ok: false, error: `${path}: ${z.prettifyError(parsed.error)}` };
  const stage = parsed.data;
  const folder = basename(skillDir);
  if (stage.name !== folder) {
    return {
      ok: false,
      error: `${path}: skill name "${stage.name}" must match its folder ${folder}`,
    };
  }
  const references = Object.values(stage.references);
  const found = await Promise.all(
    references.map((reference) =>
      access(join(skillDir, reference.path)).then(
        () => true,
        () => false,
      ),
    ),
  );
  const missing = references.find((_, index) => !found[index]);
  if (missing !== undefined) {
    return { ok: false, error: `${path}: reference file ${missing.path} does not exist` };
  }
  return { ok: true, value: stage };
};

export const loadStage = async (
  skillDir: string,
  registry: SchemaRegistry,
): Promise<Result<LoadedStage>> => {
  const loaded = await loadSkill(skillDir);
  if (!loaded.ok) return loaded;
  const stage = loaded.value;
  const path = join(skillDir, "SKILL.md");
  const inputSchema = stage.inputs === undefined ? z.json() : registry[stage.inputs.schema];
  const outputSchema = stage.outputs === undefined ? z.string() : registry[stage.outputs.schema];
  if (!inputSchema) return { ok: false, error: `${path}: unknown schema ${stage.inputs?.schema}` };
  if (!outputSchema)
    return { ok: false, error: `${path}: unknown schema ${stage.outputs?.schema}` };
  return { ok: true, value: { stage, inputSchema, outputSchema } };
};

export const extensionPath = (config: Config, skill: string): string | undefined =>
  own(config.extensions, skill)?.skill;

// The project's extensions are set per skill name, which is also the last part of a stage path.
export const resolveExtension = async (options: ResolveOptions): Promise<Result<string>> => {
  const doc = extensionPath(options.config, basename(options.skill));
  return doc === undefined ? { ok: true, value: "" } : readText(join(options.root, doc));
};

// Where a reference's text comes from once the project's extension for it is applied.
type Located = Readonly<
  | { kind: "skill" | "replace" | "add"; skill: string; path: string }
  | { kind: "extend"; skill: string; path: string; extra: string }
  | { kind: "command"; skill: string; command: string }
>;

type SkillReferences = Readonly<{
  name: string;
  skillDir: string;
  references: Stage["references"];
  extensions: NonNullable<Config["extensions"][string]>["references"];
}>;

// A skill's references with the project's extensions for them, once those extensions fit.
const loadReferences = async (options: ResolveOptions): Promise<Result<SkillReferences>> => {
  const { skill, root } = options;
  const skillDir = findStageDir(skill, root, options.skillsDir);
  const loaded = await loadSkill(skillDir);
  if (!loaded.ok) return loaded;
  const { name, references } = loaded.value;
  const extensions = own(options.config.extensions, name)?.references ?? {};
  // An add must name a key the skill lacks; replace and extend must name one it has.
  const misfit = Object.entries(extensions).find(
    ([key, extension]) => "add" in extension === (own(references, key) !== undefined),
  );
  if (misfit === undefined) return { ok: true, value: { name, skillDir, references, extensions } };
  const [key, extension] = misfit;
  const problem =
    "add" in extension
      ? `already has reference ${key}; use replace or extend`
      : `has no reference ${key}`;
  return { ok: false, error: `extensions.${name}.references.${key}: ${skill} ${problem}` };
};

export type ReferenceListing = Readonly<{ name: string; description: string | null }>;

// The skill's own references, then the ones the project adds, so a skill can choose among them.
export const listReferences = async (
  options: ResolveOptions,
): Promise<Result<readonly ReferenceListing[]>> => {
  const loaded = await loadReferences(options);
  if (!loaded.ok) return loaded;
  const { references, extensions } = loaded.value;
  const shipped = Object.entries(references).map(([name, { description }]) => ({
    name,
    description,
  }));
  const added = Object.entries(extensions).flatMap(([name, extension]) =>
    "add" in extension ? [{ name, description: extension.description ?? null }] : [],
  );
  return { ok: true, value: [...shipped, ...added] };
};

const locateReference = async (
  options: ResolveOptions & Readonly<{ ref: string }>,
): Promise<Result<Located>> => {
  const { skill, ref, root } = options;
  const loaded = await loadReferences(options);
  if (!loaded.ok) return loaded;
  const { name, skillDir, references, extensions } = loaded.value;
  const extension = own(extensions, ref);
  if (extension !== undefined && "add" in extension) {
    return { ok: true, value: { kind: "add", skill: name, path: join(root, extension.add) } };
  }
  const reference = own(references, ref);
  if (reference === undefined) {
    const added = Object.keys(extensions).filter((key) => own(references, key) === undefined);
    const known = [...Object.keys(references), ...added].join(", ");
    return { ok: false, error: `unknown reference "${ref}"; ${skill} has: ${known}` };
  }
  if (extension !== undefined && "replace" in extension) {
    return {
      ok: true,
      value: { kind: "replace", skill: name, path: join(root, extension.replace) },
    };
  }
  if (extension !== undefined && "command" in extension) {
    return { ok: true, value: { kind: "command", skill: name, command: extension.command } };
  }
  const path = join(skillDir, reference.path);
  if (extension === undefined) return { ok: true, value: { kind: "skill", skill: name, path } };
  const extra = join(root, extension.extend);
  return { ok: true, value: { kind: "extend", skill: name, path, extra } };
};

const commandHasNoFile = (skill: string, ref: string): Result<never> => ({
  ok: false,
  error: `extensions.${skill}.references.${ref}: a command reference has no text or file to resolve`,
});

export const resolveReference = async (
  options: ResolveOptions & Readonly<{ ref: string }>,
): Promise<Result<string>> => {
  const located = await locateReference(options);
  if (!located.ok) return located;
  if (located.value.kind === "command") return commandHasNoFile(located.value.skill, options.ref);
  const base = await readText(located.value.path);
  if (!base.ok || located.value.kind !== "extend") return base;
  const extra = await readText(located.value.extra);
  if (!extra.ok) return extra;
  return { ok: true, value: `${base.value.trimEnd()}\n\n${extra.value}` };
};

export type ReferenceRun = Readonly<{ file: string } | { command: string }>;

// What a reference that is run rather than read, such as a script, runs: a file, or the project's
// command line. An extend appends text to the skill's file, so it has no single file to run.
const resolveReferenceRun = async (
  options: ResolveOptions & Readonly<{ ref: string }>,
): Promise<Result<ReferenceRun>> => {
  const located = await locateReference(options);
  if (!located.ok) return located;
  const found = located.value;
  if (found.kind === "command") return { ok: true, value: { command: found.command } };
  if (found.kind === "extend") {
    const key = `extensions.${found.skill}.references.${options.ref}`;
    return {
      ok: false,
      error: `${key}: a reference used by path can only be replaced, not extended`,
    };
  }
  const exists = await access(found.path).then(
    () => true,
    () => false,
  );
  return exists
    ? { ok: true, value: { file: found.path } }
    : { ok: false, error: `${found.path} does not exist` };
};

export const resolveReferencePath = async (
  options: ResolveOptions & Readonly<{ ref: string }>,
): Promise<Result<string>> => {
  const run = await resolveReferenceRun(options);
  if (!run.ok) return run;
  return "file" in run.value
    ? { ok: true, value: run.value.file }
    : commandHasNoFile(basename(options.skill), options.ref);
};

// What `orchestrate script --skill` runs for FILE in skillDir: when FILE is one of the skill's
// references, the project's extension of it applies; any other file runs as it is.
export const resolveSkillScript = async (
  options: Readonly<{ skillDir: string; file: string; root: string; config: Config }>,
): Promise<Result<ReferenceRun>> => {
  const { skillDir, file, root, config } = options;
  const unchanged: Result<ReferenceRun> = { ok: true, value: { file } };
  if (own(config.extensions, basename(skillDir)) === undefined) return unchanged;
  const loaded = await loadSkill(skillDir);
  if (!loaded.ok) return loaded;
  const ref = Object.entries(loaded.value.references).find(
    ([, reference]) => resolve(skillDir, reference.path) === resolve(file),
  )?.[0];
  if (ref === undefined) return unchanged;
  return resolveReferenceRun({ root, config, ref, skill: resolve(skillDir) });
};
