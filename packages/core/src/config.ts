import { join } from "node:path";
import { EffortSchema } from "@harness/sdk";
import * as z from "zod";
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

const NameSchema = z.string().regex(/^[a-z][a-zA-Z0-9]*$/, "Expected a camelCase name");
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

// null means the project has no such command (NOT_APPLICABLE); callers never fall back to another key.
const CommandsSchema = recordOf(NameSchema, NonEmptyStringSchema.nullable());

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

// setup and teardown run in every repo's worktree; a package's commands.worktreeSetup/worktreeTeardown override them in multi layout.
const WorktreeSchema = z.strictObject({
  layout: z.enum(["mono", "multi"]).default("mono"),
  path: NonEmptyStringSchema.optional(),
  setup: NonEmptyStringSchema.optional(),
  teardown: NonEmptyStringSchema.optional(),
});

export const ConfigSchema = z.strictObject({
  version: z.literal(2),
  doctor: NonEmptyStringSchema.optional(),
  tiers: recordOf(NameSchema, TierSchema).default({}),
  packages: recordOf(NameSchema, PackageSchema).default({}),
  environments: EnvironmentsSchema.optional(),
  extensions: recordOf(SkillNameSchema, RepoPathSchema).default({}),
  env: recordOf(EnvNameSchema, z.string()).default({}),
  worktree: WorktreeSchema.optional(),
});

export type ConfigInput = z.input<typeof ConfigSchema>;
export type Config = z.output<typeof ConfigSchema>;

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
    `${path}: expected "version: 2" but found ${found}. A file without it is a v1 config; rewrite it in the v2 shape that ConfigSchema in @harness/core defines`,
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
