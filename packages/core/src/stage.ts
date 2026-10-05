import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  type CheckoutConfig,
  type Config,
  ConfigSchema,
  createGit,
  isNormalizedRelativePath,
  loadStartConfig,
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

// A value the workflow's stage node sets; `next` hands it to the skill.
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

// Parsed records inherit Object.prototype, so a key like "constructor" must not read through to it.
export const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

// A compiled binary reads its skills from the plugin `yok plugin install` put in the agent's
// cache for this exact version.
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
    error: `the yok plugin ${version} is not installed; run: yok plugin install --agent claude (or --agent codex)`,
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

// Hooks and helpers start this same program again: a release run calls the binary, a dev run the
// source.
export const orchestrateArgv = (): readonly [string, ...string[]] => [...selfArgv(), "orchestrate"];

// Detached, because the hook that starts the helper must return before the agent goes idle.
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

export const extensionPath = (config: Config, skill: string): string | undefined =>
  own(config.extensions, skill)?.skill;

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

export const noProjectConfig = (root: string): CheckoutConfig => ({
  config: ConfigSchema.parse({ version: 2 }),
  path: null,
  root,
});

// Outside a git checkout there is no config, so nothing changes any skill.
export const loadProjectConfig = async (
  file: string | null,
  cwd: string,
): Promise<Result<CheckoutConfig>> => {
  if (file !== null || (await createGit().repoRoot(cwd)) !== null)
    return loadStartConfig(file, cwd);
  return { ok: true, value: noProjectConfig(cwd) };
};

// A skill path resolves against root; the files the config names resolve against the config's
// own root, which can differ. A run's stages map each stage name in its workflow to its folder.
export type SkillScope = Readonly<{
  root: string;
  config: CheckoutConfig;
  run?: Readonly<{ name: string; stages: Readonly<Record<string, string>> }> | undefined;
}>;

const notFound = (ref: string, tried: readonly string[]): Result<never> => ({
  ok: false,
  error: `no skill ${ref}; tried: ${tried.join(", ")}`,
});

export const findSkill = (ref: string, scope: SkillScope): Result<string> => {
  if (ref.includes("/")) {
    const dir = resolve(scope.root, ref);
    return existsSync(dir) ? { ok: true, value: dir } : notFound(ref, [dir]);
  }
  const inRun = scope.run === undefined ? undefined : own(scope.run.stages, ref);
  if (inRun !== undefined) return { ok: true, value: inRun };
  const dir = join(yokSkillsDir(), ref);
  if (existsSync(dir)) return { ok: true, value: dir };
  const run =
    scope.run === undefined ? [] : [`a stage named ${ref} in run ${scope.run.name}'s workflow`];
  return notFound(ref, [...run, dir]);
};

export type Ref = Readonly<
  { kind: "file"; path: string; extraPath?: string } | { kind: "command"; command: string }
>;
export type SkillRef = Ref & Readonly<{ description: string | null }>;

export type Skill = Readonly<{
  name: string;
  dir: string;
  frontmatter: Stage;
  // the skill's own references first, then the ones the project adds
  references: Readonly<Record<string, SkillRef>>;
  extensionDoc?: string;
}>;

type Extension = NonNullable<Config["extensions"][string]>;
type ReferenceExtension = Extension["references"][string];

const readStage = async (dir: string): Promise<Result<Stage>> => {
  const path = join(dir, "SKILL.md");
  const text = await readText(path);
  if (!text.ok) return text;
  const frontmatter = parseFrontmatter(text.value, path);
  if (!frontmatter.ok) return frontmatter;
  const parsed = StageSchema.safeParse(frontmatter.value);
  if (!parsed.success) return { ok: false, error: `${path}: ${z.prettifyError(parsed.error)}` };
  const { name, references } = parsed.data;
  const folder = basename(dir);
  if (name !== folder) {
    return { ok: false, error: `${path}: skill name "${name}" must match its folder ${folder}` };
  }
  const missing = Object.values(references).find((ref) => !existsSync(join(dir, ref.path)));
  if (missing === undefined) return { ok: true, value: parsed.data };
  return { ok: false, error: `${path}: reference file ${missing.path} does not exist` };
};

const extensionFile = (extension: ReferenceExtension): string | undefined => {
  if ("replace" in extension) return extension.replace;
  if ("extend" in extension) return extension.extend;
  return "add" in extension ? extension.add : undefined;
};

// An add must name a new reference; replace, extend and command must name an existing one.
const checkExtension = (
  ref: string,
  stage: Stage,
  extension: Extension,
  root: string,
): Result<void> => {
  const prefix = `extensions.${stage.name}`;
  const entries = Object.entries(extension.references);
  const misfit = entries.find(
    ([key, ext]) => "add" in ext === (own(stage.references, key) !== undefined),
  );
  if (misfit !== undefined) {
    const [key, ext] = misfit;
    const problem =
      "add" in ext
        ? `already has reference ${key}; use replace or extend`
        : `has no reference ${key}`;
    return { ok: false, error: `${prefix}.references.${key}: ${ref} ${problem}` };
  }
  const files = [
    ...(extension.skill === undefined ? [] : [[`${prefix}.skill`, extension.skill] as const]),
    ...entries.flatMap(([key, ext]) => {
      const file = extensionFile(ext);
      return file === undefined ? [] : [[`${prefix}.references.${key}`, file] as const];
    }),
  ];
  const missing = files.find(([, file]) => !existsSync(join(root, file)));
  if (missing === undefined) return { ok: true, value: undefined };
  return { ok: false, error: `${missing[0]}: ${join(root, missing[1])} does not exist` };
};

const applyExtension = (
  shipped: Extract<SkillRef, { kind: "file" }>,
  extension: ReferenceExtension | undefined,
  root: string,
): SkillRef => {
  if (extension === undefined || "add" in extension) return shipped;
  if ("replace" in extension) return { ...shipped, path: join(root, extension.replace) };
  if ("extend" in extension) return { ...shipped, extraPath: join(root, extension.extend) };
  return { kind: "command", command: extension.command, description: shipped.description };
};

const buildReferences = (
  dir: string,
  stage: Stage,
  extensions: Extension["references"],
  root: string,
): Record<string, SkillRef> => {
  const shipped = Object.entries(stage.references).map(([key, { path, description }]) => {
    const ref = { kind: "file" as const, path: join(dir, path), description };
    return [key, applyExtension(ref, own(extensions, key), root)] as const;
  });
  const added = Object.entries(extensions).flatMap(([key, ext]) =>
    "add" in ext
      ? [
          [
            key,
            {
              kind: "file" as const,
              path: join(root, ext.add),
              description: ext.description ?? null,
            },
          ] as const,
        ]
      : [],
  );
  return Object.fromEntries([...shipped, ...added]);
};

export const loadSkill = async (ref: string, scope: SkillScope): Promise<Result<Skill>> => {
  const dir = findSkill(ref, scope);
  if (!dir.ok) return dir;
  const stage = await readStage(dir.value);
  if (!stage.ok) return stage;
  const { root } = scope.config;
  const extension = own(scope.config.config.extensions, stage.value.name) ?? { references: {} };
  const checked = checkExtension(ref, stage.value, extension, root);
  if (!checked.ok) return checked;
  return {
    ok: true,
    value: {
      name: stage.value.name,
      dir: dir.value,
      frontmatter: stage.value,
      references: buildReferences(dir.value, stage.value, extension.references, root),
      ...(extension.skill === undefined ? {} : { extensionDoc: join(root, extension.skill) }),
    },
  };
};

export const findReference = (skill: Skill, key: string): Result<SkillRef> => {
  const ref = own(skill.references, key);
  if (ref !== undefined) return { ok: true, value: ref };
  const known = Object.keys(skill.references).join(", ");
  return { ok: false, error: `unknown reference "${key}"; ${skill.name} has: ${known}` };
};
