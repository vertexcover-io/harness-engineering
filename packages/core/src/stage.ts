import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import * as z from "zod";
import type { Config } from "./config.ts";
import { type Result, type Stage, StageSchema } from "./contracts.ts";
import { parseFrontmatter, readText } from "./files.ts";

export type SchemaRegistry = Readonly<Record<string, z.ZodType>>;

export type LoadedStage = {
  readonly stage: Stage;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
};

type ResolveOptions = Readonly<{ skillsDir: string; root: string; config: Config; skill: string }>;

// Parsed records inherit Object.prototype, so a key like "constructor" must not read through to it.
const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

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

export const resolveExtension = async (options: ResolveOptions): Promise<Result<string>> => {
  const doc = own(options.config.extensions, options.skill)?.skill;
  return doc === undefined ? { ok: true, value: "" } : readText(join(options.root, doc));
};

export const resolveReference = async (
  options: ResolveOptions & Readonly<{ ref: string }>,
): Promise<Result<string>> => {
  const { skill, ref, root } = options;
  const skillDir = join(options.skillsDir, skill);
  const loaded = await loadSkill(skillDir);
  if (!loaded.ok) return loaded;
  const { references } = loaded.value;
  const reference = own(references, ref);
  if (reference === undefined) {
    const known = Object.keys(references).join(", ");
    return { ok: false, error: `unknown reference "${ref}"; ${skill} has: ${known}` };
  }
  const extensions = own(options.config.extensions, skill)?.references ?? {};
  const stray = Object.keys(extensions).find((key) => own(references, key) === undefined);
  if (stray !== undefined) {
    const error = `extensions.${skill}.references.${stray}: ${skill} has no reference ${stray}`;
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
