import { join } from "node:path";
import * as z from "zod";
import { EffortSchema } from "./agent.ts";
import {
  isNormalizedRelativePath,
  NonEmptyStringSchema,
  type Result,
  SkillNameSchema,
  SlugSchema,
} from "./contracts.ts";
import { parseYaml, readIfExists } from "./files.ts";

const CONFIG_FILES = [
  "orchestrate.config.yaml",
  "orchestrate.config.yml",
  "orchestrate.config.json",
] as const;

export const NameSchema = z.string().regex(/^[a-z][a-zA-Z0-9]*$/, "Expected a camelCase name");
const EnvNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "Expected an UPPER_SNAKE name");

// "." is the repository root itself, the path of a single-package repository.
const isRepoPath = (value: string): boolean => value === "." || isNormalizedRelativePath(value);

const RepoPathSchema = NonEmptyStringSchema.refine(
  isRepoPath,
  "Expected a path relative to the repository root",
);

// Without its own message, Zod reports a bad record key as "Invalid key in record" and hides the reason.
const recordOf = <T extends z.ZodType>(key: z.ZodType<string>, value: T) =>
  z.record(key, value, {
    error: (issue) =>
      issue.code === "invalid_key"
        ? `Invalid key "${String(issue.input)}": ${issue.issues[0]?.message ?? "invalid"}`
        : undefined,
  });

// A command is a string, or an object that also sets the folder it runs in (relative to the
// workspace folder) and how long it may run. Both load as the object.
const CommandSchema = z
  .union([
    NonEmptyStringSchema,
    z.strictObject({
      command: NonEmptyStringSchema,
      cwd: RepoPathSchema.optional(),
      timeoutSeconds: z.int().positive().optional(),
    }),
  ])
  .transform((value) => (typeof value === "string" ? { command: value } : value));

// null means the project has no such command (NOT_APPLICABLE); callers never fall back to another key.
const CommandsSchema = recordOf(NameSchema, CommandSchema.nullable());

const TierSchema = z.strictObject({
  agent: SlugSchema,
  model: NonEmptyStringSchema.optional(),
  effort: EffortSchema.optional(),
});

const PackageSchema = z.strictObject({
  path: RepoPathSchema,
  runner: NonEmptyStringSchema.optional(),
  timeoutSeconds: z.int().positive().default(300),
  commands: CommandsSchema.default({}),
  description: NonEmptyStringSchema.optional(),
});

const EnvironmentsSchema = z
  .strictObject({
    default: NameSchema,
    entries: recordOf(NameSchema, CommandsSchema),
  })
  .refine((value) => Object.hasOwn(value.entries, value.default), {
    path: ["default"],
    message: "Must name one of the entries",
  });

// setup and teardown run in every repo's worktree; a package's commands.workspaceSetup/workspaceTeardown override them in multi layout.
// baseBranch is what new branches start from when --base is not given; without it, origin's default branch.
export const LayoutSchema = z.enum(["mono", "multi"]);

const WorkspaceConfigSchema = z.strictObject({
  layout: LayoutSchema.default("mono"),
  path: NonEmptyStringSchema.optional(),
  baseBranch: NonEmptyStringSchema.optional(),
  setup: NonEmptyStringSchema.optional(),
  teardown: NonEmptyStringSchema.optional(),
});

// replace uses the project's file instead of the skill's; extend appends it after the skill's.
const ReferenceExtensionSchema = z.union([
  z.strictObject({ replace: RepoPathSchema }),
  z.strictObject({ extend: RepoPathSchema }),
]);

const ExtensionSchema = z.strictObject({
  skill: RepoPathSchema.optional(),
  references: recordOf(SlugSchema, ReferenceExtensionSchema).default({}),
});

// The top-level baseline runs once for the workspace; a package's commands.baseline runs for that package.
export const ConfigSchema = z.strictObject({
  version: z.literal(2),
  doctor: NonEmptyStringSchema.optional(),
  baseline: CommandSchema.optional(),
  tiers: recordOf(NameSchema, TierSchema).default({}),
  packages: recordOf(NameSchema, PackageSchema).default({}),
  environments: EnvironmentsSchema.optional(),
  extensions: recordOf(SkillNameSchema, ExtensionSchema).default({}),
  env: recordOf(EnvNameSchema, z.string()).default({}),
  workspace: WorkspaceConfigSchema.prefault({}),
});

export type ConfigInput = z.input<typeof ConfigSchema>;
export type Config = z.output<typeof ConfigSchema>;

export const unknownPackage = (config: Config, names: readonly string[]): string | undefined =>
  names.find((name) => !Object.hasOwn(config.packages, name));

type ConfigFile = { readonly path: string; readonly text: string };

const findConfigFiles = async (repoRoot: string): Promise<readonly ConfigFile[]> => {
  const files = await Promise.all(
    CONFIG_FILES.map(async (name) => {
      const path = join(repoRoot, name);
      const text = await readIfExists(path);
      return text === null ? null : { path, text };
    }),
  );
  return files.filter((file) => file !== null);
};

export type ConfigError = {
  readonly code: "CONFIG_MISSING" | "CONFIG_AMBIGUOUS" | "CONFIG_INVALID";
  readonly message: string;
};

const invalid = (message: string): Result<never, ConfigError> => ({
  ok: false,
  error: { code: "CONFIG_INVALID", message },
});

// A v1 file would otherwise fail on whichever v1-only key Zod meets first.
const checkVersion = (value: unknown, path: string): Result<unknown, ConfigError> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`${path}: expected a mapping holding version: 2`);
  }
  if ("version" in value && value.version === 2) return { ok: true, value };
  const found = "version" in value ? `version ${JSON.stringify(value.version)}` : "no version";
  return invalid(
    `${path}: expected "version: 2" but found ${found}. A file without it is a v1 config; rewrite it in the v2 shape that ConfigSchema in @harness/sdk defines`,
  );
};

const declaresVersion2 = (file: ConfigFile): boolean => {
  const yaml = parseYaml(file.text, file.path);
  return yaml.ok && checkVersion(yaml.value, file.path).ok;
};

// A v1 file can sit beside the v2 one while a repo migrates, so only v2 files compete.
const contenders = (files: readonly ConfigFile[]): readonly ConfigFile[] =>
  files.length > 1 ? files.filter(declaresVersion2) : files;

export const loadConfig = async (repoRoot: string): Promise<Result<Config, ConfigError>> => {
  const files = await findConfigFiles(repoRoot);
  if (files.length === 0) {
    return {
      ok: false,
      error: {
        code: "CONFIG_MISSING",
        message: `${repoRoot} has no ${CONFIG_FILES.join(", ")}. Run setup-harness to write one`,
      },
    };
  }
  const candidates = contenders(files);
  const [file] = candidates;
  if (file === undefined || candidates.length > 1) {
    return {
      ok: false,
      error: {
        code: "CONFIG_AMBIGUOUS",
        message: `${files.map(({ path }) => path).join(" and ")} both exist. Keep one`,
      },
    };
  }
  const yaml = parseYaml(file.text, file.path);
  if (!yaml.ok) return invalid(yaml.error);
  const versioned = checkVersion(yaml.value, file.path);
  if (!versioned.ok) return versioned;
  const parsed = ConfigSchema.safeParse(versioned.value);
  if (!parsed.success) return invalid(`${file.path}: ${z.prettifyError(parsed.error)}`);
  return { ok: true, value: parsed.data };
};

// A repo with no config file still gets plain worktrees; any other config problem stops the command.
export const loadConfigOrDefault = async (root: string): Promise<Result<Config>> => {
  const loaded = await loadConfig(root);
  if (loaded.ok) return loaded;
  if (loaded.error.code === "CONFIG_MISSING") {
    return { ok: true, value: ConfigSchema.parse({ version: 2 }) };
  }
  return { ok: false, error: loaded.error.message };
};
