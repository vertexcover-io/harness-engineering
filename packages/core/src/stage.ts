import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  type Config,
  isNormalizedRelativePath,
  NonEmptyStringSchema,
  parseFrontmatter,
  type Result,
  readText,
  SlugSchema,
} from "@harness/sdk";
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

export const StageSchema = z.strictObject({
  name: SlugSchema,
  description: NonEmptyStringSchema,
  mode: z.enum(["inline", "subagent"]),
  tags: UniqueSlugsSchema.optional(),
  "allowed-tools": z.array(NonEmptyStringSchema),
  tier: NonEmptyStringSchema,
  inputs: StagePortSchema,
  outputs: StagePortSchema,
  consumes: z.array(ArtifactDeclarationSchema).optional(),
  produces: z.array(ArtifactDeclarationSchema).optional(),
  protocols: UniqueSlugsSchema,
  scopes: UniqueSlugsSchema,
  references: z.record(SlugSchema, ReferenceSchema).default({}),
});
export type Stage = z.infer<typeof StageSchema>;
export type ArtifactDeclaration = z.infer<typeof ArtifactDeclarationSchema>;

export type SchemaRegistry = Readonly<Record<string, z.ZodType>>;

export type LoadedStage = {
  readonly stage: Stage;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
};

type ResolveOptions = Readonly<{ skillsDir: string; root: string; config: Config; skill: string }>;

// Parsed records inherit Object.prototype, so a key like "constructor" must not read through to it.
export const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

// The harness's own skills ship beside this code, so their text always matches this version;
// HARNESS_SKILLS_DIR points tests at a demo set instead.
export const harnessSkillsDir = (): string =>
  process.env.HARNESS_SKILLS_DIR || join(import.meta.dir, "..", "..", "..", "skills");

// Agent hooks run outside this repo's package.json, so they call bun and the script by
// absolute path. The server that asks for this runs under bun, so execPath is bun.
export const orchestrateHookCommand = (): readonly string[] => [
  process.execPath,
  join(import.meta.dir, "orchestrate.ts"),
  "hook",
];

// A stage name is one of the harness's own skills; a stage with a "/" is a skill folder in the
// project at `root`.
export const findStageDir = (
  stage: string,
  root: string,
  skillsDir = harnessSkillsDir(),
): string => (stage.includes("/") ? resolve(root, stage) : join(skillsDir, stage));

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
  const missing = Object.values(stage.references).find(
    (reference) => !existsSync(join(skillDir, reference.path)),
  );
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
  const inputSchema = registry[stage.inputs.schema];
  const outputSchema = registry[stage.outputs.schema];
  if (!inputSchema) return { ok: false, error: `${path}: unknown schema ${stage.inputs.schema}` };
  if (!outputSchema) return { ok: false, error: `${path}: unknown schema ${stage.outputs.schema}` };
  return { ok: true, value: { stage, inputSchema, outputSchema } };
};

export const extensionPath = (config: Config, skill: string): string | undefined =>
  own(config.extensions, skill)?.skill;

// The project's extensions are set per skill name, which is also the last part of a stage path.
export const resolveExtension = async (options: ResolveOptions): Promise<Result<string>> => {
  const doc = extensionPath(options.config, basename(options.skill));
  return doc === undefined ? { ok: true, value: "" } : readText(join(options.root, doc));
};

export const resolveReference = async (
  options: ResolveOptions & Readonly<{ ref: string }>,
): Promise<Result<string>> => {
  const { skill, ref, root } = options;
  const skillDir = findStageDir(skill, root, options.skillsDir);
  const loaded = await loadSkill(skillDir);
  if (!loaded.ok) return loaded;
  const { name, references } = loaded.value;
  const reference = own(references, ref);
  if (reference === undefined) {
    const known = Object.keys(references).join(", ");
    return { ok: false, error: `unknown reference "${ref}"; ${skill} has: ${known}` };
  }
  const extensions = own(options.config.extensions, name)?.references ?? {};
  const stray = Object.keys(extensions).find((key) => own(references, key) === undefined);
  if (stray !== undefined) {
    const error = `extensions.${name}.references.${stray}: ${skill} has no reference ${stray}`;
    return { ok: false, error };
  }
  const extension = own(extensions, ref);
  if (extension !== undefined && "replace" in extension) {
    return readText(join(root, extension.replace));
  }
  const base = await readText(join(skillDir, reference.path));
  if (!base.ok || extension === undefined) return base;
  const extra = await readText(join(root, extension.extend));
  if (!extra.ok) return extra;
  return { ok: true, value: `${base.value.trimEnd()}\n\n${extra.value}` };
};
