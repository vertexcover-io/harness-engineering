import { join } from "node:path";
import * as z from "zod";
import { type AgentType, AgentTypeSchema, EffortSchema } from "./agent.ts";
import {
  EventHandlerRefSchema,
  EventTypeSchema,
  isNormalizedRelativePath,
  LayoutSchema,
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

export const TierModelSchema = z.strictObject({
  model: NonEmptyStringSchema,
  effort: EffortSchema.optional(),
});
export type TierModel = z.infer<typeof TierModelSchema>;

const AgentConfigSchema = z.strictObject({
  tiers: recordOf(NameSchema, TierModelSchema).default({}),
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
const WorkspaceConfigSchema = z.strictObject({
  layout: LayoutSchema.default("mono"),
  path: NonEmptyStringSchema.optional(),
  baseBranch: NonEmptyStringSchema.optional(),
  setup: NonEmptyStringSchema.optional(),
  teardown: NonEmptyStringSchema.optional(),
});

// replace uses the project's file instead of the skill's; extend appends it after the skill's; add names a reference the skill does not have.
const ReferenceExtensionSchema = z.union([
  z.strictObject({ replace: RepoPathSchema }),
  z.strictObject({ extend: RepoPathSchema }),
  z.strictObject({ add: RepoPathSchema }),
]);

const ExtensionSchema = z.strictObject({
  skill: RepoPathSchema.optional(),
  references: recordOf(SlugSchema, ReferenceExtensionSchema).default({}),
});

// Env vars a run's agent sessions start with, set by the config and by the workflow. envFile is
// read beneath env; a relative one resolves against the config's folder or the folder the run
// starts in, and a missing file fails when it is read.
export const EnvLayerSchema = z.object({
  env: recordOf(EnvNameSchema, z.string()).default({}),
  envFile: NonEmptyStringSchema.optional(),
});
export type EnvLayer = z.output<typeof EnvLayerSchema>;

// Each event type's handlers run in list order, after the built-in handler for that type.
const EventHandlerSchema = EventHandlerRefSchema.extend({ module: RepoPathSchema });

const entryFields = {
  name: SlugSchema,
  blocking: z.boolean().optional(),
  timeoutSeconds: z.int().positive().optional(),
};

// A hook's timeout when it names none. A blocking hook may run inside an agent's hook, which the
// agent kills at 30 seconds, so it gets less.
export const HOOK_TIMEOUT_S = { blocking: 20, detached: 60 } as const;
const BLOCKING_TIMEOUT_MAX_S = 25;

// A hook runs a module's export, or a shell command that reads the hook input as JSON on stdin.
// Relative paths resolve against the config's folder, or the workflow's for a workflow's hooks.
export const HookEntrySchema = z
  .union(
    [
      z.strictObject({ ...entryFields, module: RepoPathSchema, handler: NonEmptyStringSchema }),
      z.strictObject({
        ...entryFields,
        command: NonEmptyStringSchema,
        cwd: RepoPathSchema.optional(),
      }),
    ],
    {
      error:
        "a hook is { name, module, handler } or { name, command, cwd? }, with optional blocking: boolean and timeoutSeconds: positive integer",
    },
  )
  .refine(
    (entry) => entry.blocking === false || (entry.timeoutSeconds ?? 0) <= BLOCKING_TIMEOUT_MAX_S,
    `a blocking hook's timeoutSeconds is at most ${BLOCKING_TIMEOUT_MAX_S}, under the agent's 30-second hook limit; set blocking: false for a longer one`,
  );
export type HookEntry = z.infer<typeof HookEntrySchema>;

const HookTypeSchema = EventTypeSchema.refine(
  (type) => type !== "hooks.hook.called",
  "no hook may listen to hooks.hook.called, the record of hook calls",
);
// The built-in notifier's hook name, which no project hook may take.
export const NOTIFIER_HOOK = "notifier";

export const uniqueNames = (entries: readonly Readonly<{ name: string }>[]): boolean =>
  new Set(entries.map((entry) => entry.name)).size === entries.length;

export const HooksSchema = recordOf(
  HookTypeSchema,
  z
    .array(HookEntrySchema)
    .refine(uniqueNames, "hook names must be unique for one event type")
    .refine(
      (entries) => entries.every((entry) => entry.name !== NOTIFIER_HOOK),
      `"${NOTIFIER_HOOK}" is the built-in notifier's name`,
    ),
).default({});
export type Hooks = z.infer<typeof HooksSchema>;

export const NotifierSchema = z.strictObject({
  enabled: z.boolean().default(true),
  type: z.enum(["slack"]).default("slack"),
});
export type Notifier = z.infer<typeof NotifierSchema>;

// The top-level baseline runs once for the workspace; a package's commands.baseline runs for that package.
export const ConfigSchema = z.strictObject({
  version: z.literal(2),
  doctor: NonEmptyStringSchema.optional(),
  baseline: CommandSchema.optional(),
  agents: z.partialRecord(AgentTypeSchema, AgentConfigSchema).default({}),
  packages: recordOf(NameSchema, PackageSchema).default({}),
  environments: EnvironmentsSchema.optional(),
  extensions: recordOf(SkillNameSchema, ExtensionSchema).default({}),
  ...EnvLayerSchema.shape,
  workspace: WorkspaceConfigSchema.prefault({}),
  eventHandlers: recordOf(EventTypeSchema, z.array(EventHandlerSchema)).default({}),
  hooks: HooksSchema,
  notifier: NotifierSchema.optional(),
});

export type ConfigInput = z.input<typeof ConfigSchema>;
export type Config = z.output<typeof ConfigSchema>;

export const findTierModel = (
  config: Config,
  agent: AgentType,
  tier: string,
): Result<TierModel> => {
  const tiers = config.agents[agent]?.tiers ?? {};
  const found = Object.hasOwn(tiers, tier) ? tiers[tier] : undefined;
  if (found !== undefined) return { ok: true, value: found };
  return {
    ok: false,
    error: `tier "${tier}" has no model for ${agent}: add agents.${agent}.tiers.${tier} to the config`,
  };
};

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

export type LoadedConfig = Readonly<{ config: Config; path: string }>;

export const loadConfigFile = async (
  repoRoot: string,
): Promise<Result<LoadedConfig, ConfigError>> => {
  const files = await findConfigFiles(repoRoot);
  if (files.length === 0) {
    return {
      ok: false,
      error: {
        code: "CONFIG_MISSING",
        message: `${repoRoot} has no ${CONFIG_FILES.join(", ")}. Write orchestrate.config.yaml (version: 2)`,
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
  return parseConfigFile(file);
};

const parseConfigFile = (file: ConfigFile): Result<LoadedConfig, ConfigError> => {
  const yaml = parseYaml(file.text, file.path);
  if (!yaml.ok) return invalid(yaml.error);
  const versioned = checkVersion(yaml.value, file.path);
  if (!versioned.ok) return versioned;
  const parsed = ConfigSchema.safeParse(versioned.value);
  if (!parsed.success) return invalid(`${file.path}: ${z.prettifyError(parsed.error)}`);
  return { ok: true, value: { config: parsed.data, path: file.path } };
};

const readConfigAt = async (path: string): Promise<Result<string>> => {
  try {
    const text = await readIfExists(path);
    if (text === null) return { ok: false, error: `${path}: no such config file` };
    return { ok: true, value: text };
  } catch (error) {
    return { ok: false, error: `${path}: cannot read config file: ${String(error)}` };
  }
};

// A file named outright, as `harness run --config` does: its name need not be one of CONFIG_FILES.
export const loadConfigAt = async (path: string): Promise<Result<LoadedConfig>> => {
  const text = await readConfigAt(path);
  if (!text.ok) return text;
  const loaded = parseConfigFile({ path, text: text.value });
  return loaded.ok ? loaded : { ok: false, error: loaded.error.message };
};

export const defaultConfig = (): Config => ConfigSchema.parse({ version: 2 });

export const loadConfig = async (repoRoot: string): Promise<Result<Config, ConfigError>> => {
  const loaded = await loadConfigFile(repoRoot);
  return loaded.ok ? { ok: true, value: loaded.value.config } : loaded;
};

// A repo with no config file still gets plain worktrees; any other config problem stops the command.
export const loadConfigOrDefault = async (root: string): Promise<Result<Config>> => {
  const loaded = await loadConfig(root);
  if (loaded.ok) return loaded;
  if (loaded.error.code === "CONFIG_MISSING") {
    return { ok: true, value: defaultConfig() };
  }
  return { ok: false, error: loaded.error.message };
};
