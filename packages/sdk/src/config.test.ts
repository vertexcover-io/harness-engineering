import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import * as z from "zod";
import {
  type Config,
  ConfigSchema,
  loadConfig,
  loadConfigAt,
  type Notifier,
  resolveTiers,
} from "./config.ts";

const exampleYaml = `version: 2
doctor: bun bin/doctor.ts

agents:
  claude:
    tiers:
      default: standard
      models:
        deep: { model: opus, effort: high }
        standard: { model: sonnet }
        fast: { model: haiku }

packages:
  root:
    path: .
    commands:
      typecheck: bun run typecheck
      lint: bun run lint
      testAll: bun test ./packages
      testFile: bun test {FILE}
  api:
    path: packages/api
    runner: vitest
    timeoutSeconds: 600
    commands:
      bootstrap: pnpm install
      testAll: pnpm --filter api test
      e2e: pnpm --filter api test:e2e

environments:
  default: local
  entries:
    local:
      stackUp: scripts/stack.sh up {BRANCH} {SERVICE...} [--seed-demo]
      stackStatus: scripts/stack.sh status {BRANCH}
      stackDown: scripts/stack.sh down {BRANCH}

extensions:
  planning:
    skill: yok/planning.md

env:
  SLACK_CHANNEL_ID: C09XXXXXXXX
`;
const exampleJson = JSON.stringify(parse(exampleYaml));

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "config-"));
});

const writeConfig = (fileName: string, text: string): Promise<void> =>
  writeFile(join(root, fileName), text);

const load = async (fileName: string, text: string): Promise<Config> => {
  await writeConfig(fileName, text);
  const result = await loadConfig(root);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

const errorOf = (value: unknown): string => {
  const parsed = ConfigSchema.safeParse(value);
  if (parsed.success) throw new Error("expected the config to be rejected");
  return z.prettifyError(parsed.error);
};

describe("resolveTiers", () => {
  const configWith = (tiers?: object): Config =>
    ConfigSchema.parse({
      version: 2,
      ...(tiers === undefined ? {} : { agents: { claude: { tiers } } }),
    });
  const BUILT_IN = {
    default: "deep",
    models: {
      fast: { model: "claude-sonnet-5-5" },
      deep: { model: "claude-opus-5-5", effort: "high" },
    },
  } as const;

  test("claude with no config and no workflow tiers gets the built-in set: default deep, fast on sonnet, deep on opus at high effort", () => {
    expect(resolveTiers(configWith(), "claude", {})).toEqual({ ok: true, value: BUILT_IN });
  });

  test.each([
    [
      "a config model for fast replaces the built-in fast and keeps deep",
      { models: { fast: { model: "haiku-x" } } },
      {},
      { ...BUILT_IN, models: { ...BUILT_IN.models, fast: { model: "haiku-x" } } },
    ],
    [
      "a config tier the built-in lacks is added beside fast and deep",
      { models: { standard: { model: "sonnet-x" } } },
      {},
      { ...BUILT_IN, models: { ...BUILT_IN.models, standard: { model: "sonnet-x" } } },
    ],
    [
      "a workflow that sets only default: fast keeps every model and launches on fast",
      {},
      { default: "fast" },
      { ...BUILT_IN, default: "fast" },
    ],
    [
      "a workflow deep with no effort replaces the config's whole deep entry, effort included",
      { default: "fast", models: { deep: { model: "opus-x", effort: "max" } } } as const,
      { models: { deep: { model: "opus-y" } } },
      { default: "fast", models: { ...BUILT_IN.models, deep: { model: "opus-y" } } },
    ],
  ])("%s", (_label, config, workflow, expected) => {
    expect(resolveTiers(configWith(config), "claude", workflow)).toEqual({
      ok: true,
      value: expected,
    });
  });

  test("a default naming a tier no layer maps fails, naming the tier and the tiers there are", () => {
    const resolved = resolveTiers(configWith(), "claude", { default: "balanced" });
    if (resolved.ok) throw new Error("expected a failure");
    expect(resolved.error).toContain('"balanced"');
    expect(resolved.error).toContain("fast, deep");
  });

  test("codex with no config and no workflow tiers gets its built-in set: default deep, fast on gpt-6-luna, deep on gpt-6-sol at high effort", () => {
    expect(resolveTiers(configWith(), "codex", {})).toEqual({
      ok: true,
      value: {
        default: "deep",
        models: {
          fast: { model: "gpt-6-luna" },
          deep: { model: "gpt-6-sol", effort: "high" },
        },
      },
    });
  });

  test("pi has no built-in set: with no tiers anywhere it resolves to null", () => {
    expect(resolveTiers(configWith(), "pi", {})).toEqual({ ok: true, value: null });
  });
});

describe("ConfigSchema", () => {
  test("SC1 — a file holding only version 2 loads with every map empty and a mono workspace", () => {
    const config = ConfigSchema.parse({ version: 2 });
    expect(config).toEqual({
      version: 2,
      agents: {},
      packages: {},
      extensions: {},
      env: {},
      workspace: { layout: "mono" },
      eventHandlers: {},
      subscribers: {},
    });
  });

  test("EH1 — eventHandlers lists module and handler per event type, custom.* included", () => {
    const eventHandlers = {
      "workspace.created": [{ module: "scripts/review-state.ts", handler: "onWorkspaceCreated" }],
      "custom.review.note": [{ module: "scripts/review-state.ts", handler: "onReviewNote" }],
    };
    expect(ConfigSchema.parse({ version: 2, eventHandlers }).eventHandlers).toEqual(eventHandlers);
  });

  test.each([
    [
      "an unknown event namespace",
      { "review.note": [{ module: "a.ts", handler: "f" }] },
      "review.note",
    ],
    [
      "a custom event with no name after its scope",
      { "custom.review": [{ module: "a.ts", handler: "f" }] },
      "custom.review",
    ],
    ["a missing handler", { "custom.review.note": [{ module: "a.ts" }] }, "handler"],
    [
      "a module outside the repository",
      { "custom.review.note": [{ module: "../a.ts", handler: "f" }] },
      "relative to the repository root",
    ],
  ])("EH2 — eventHandlers with %s is rejected", (_label, eventHandlers, detail) => {
    expect(errorOf({ version: 2, eventHandlers })).toContain(detail);
  });

  test("SC2 — a full example loads with defaults filled", async () => {
    const config = await load("orchestrate.config.yaml", exampleYaml);
    expect(config.agents.claude?.tiers).toMatchObject({
      default: "standard",
      models: { deep: { model: "opus", effort: "high" } },
    });
    expect(config.packages.root).toEqual({
      path: ".",
      timeoutSeconds: 300,
      commands: {
        typecheck: { command: "bun run typecheck" },
        lint: { command: "bun run lint" },
        testAll: { command: "bun test ./packages" },
        testFile: { command: "bun test {FILE}" },
      },
    });
    expect(config.packages.api?.timeoutSeconds).toBe(600);
    expect(config.environments?.default).toBe("local");
    expect(Object.keys(config.environments?.entries.local ?? {})).toEqual([
      "stackUp",
      "stackStatus",
      "stackDown",
    ]);
    expect(config.extensions).toEqual({
      planning: { skill: "yok/planning.md", references: {} },
    });
  });

  test.each([
    ["command", { packages: { root: { path: ".", commands: { test_all: "x" } } } }, "test_all"],
    ["package", { packages: { "my-api": { path: "api" } } }, "my-api"],
    [
      "tier",
      { agents: { claude: { tiers: { models: { "deep-think": { model: "opus" } } } } } },
      "deep-think",
    ],
    [
      "environment",
      { environments: { default: "my-local", entries: { "my-local": {} } } },
      "my-local",
    ],
    [
      "environment step",
      { environments: { default: "local", entries: { local: { stack_up: "x" } } } },
      "stack_up",
    ],
    ["env var", { env: { slackChannel: "C1" } }, "slackChannel"],
    ["extension skill", { extensions: { Planning: { skill: "a.md" } } }, "Planning"],
  ])("SC7 — a %s key in the wrong format is rejected by name", (_label, fields, key) => {
    const message = errorOf({ version: 2, ...fields });
    expect(message).toContain(`Invalid key "${key}"`);
    expect(message).not.toContain("Invalid key in record");
  });

  test.each([
    ["a zero package timeout", { packages: { api: { path: "api", timeoutSeconds: 0 } } }],
    ["a negative package timeout", { packages: { api: { path: "api", timeoutSeconds: -1 } } }],
    ["an empty command", { packages: { api: { path: "api", commands: { testAll: "" } } } }],
    ["an env value that is a number", { env: { SLACK_CHANNEL_ID: 42 } }],
  ])("SC20 — %s is rejected", (_label, fields) => {
    expect(ConfigSchema.safeParse({ version: 2, ...fields }).success).toBe(false);
  });

  test.each(["env/dev.env", "../shared/.env", "./.env.local", "/etc/myapp/dev.env"])(
    "an envFile path, relative or absolute, is kept: %s",
    (envFile) => {
      expect(ConfigSchema.parse({ version: 2, envFile }).envFile).toBe(envFile);
    },
  );

  test("WS5 — a package description is kept", () => {
    const config = ConfigSchema.parse({
      version: 2,
      packages: { api: { path: "api", description: "HTTP API" } },
    });
    expect(config.packages.api?.description).toBe("HTTP API");
  });

  test.each([
    [
      "WS6 — a reference extension with both replace and extend",
      {
        "create-workspace": { references: { "select-repos": { replace: "a.md", extend: "b.md" } } },
      },
    ],
    ["WS7 — an extension as a bare string, the v1 shape", { "create-workspace": "a.md" }],
  ])("%s is rejected", (_label, extensions) => {
    expect(ConfigSchema.safeParse({ version: 2, extensions }).success).toBe(false);
  });

  test("SC43: a command reference extension parses alone, and is rejected beside replace or empty", () => {
    const withScript = (script: unknown) =>
      ConfigSchema.safeParse({ version: 2, extensions: { baseline: { references: { script } } } });
    expect(withScript({ command: "x", replace: "a.md" }).success).toBe(false);
    expect(withScript({ command: "" }).success).toBe(false);
    const parsed = withScript({ command: "python tools/b.py" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.extensions.baseline?.references.script).toEqual({
      command: "python tools/b.py",
    });
  });

  test("SC21 — a null command loads as a command the project does not have", () => {
    const config = ConfigSchema.parse({
      version: 2,
      packages: { api: { path: "api", commands: { lintFile: null } } },
    });
    expect(config.packages.api?.commands).toEqual({ lintFile: null });
  });

  test("SC19 — the generated JSON Schema carries the camelCase key rule", () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(ConfigSchema, { io: "input" }));
    expect(jsonSchema).toContain(
      '"propertyNames":{"type":"string","pattern":"^[a-z][a-zA-Z0-9]*$"}',
    );
  });

  test.each([
    ["top level", { version: 2, packagez: {} }, "packagez"],
    [
      "package",
      { version: 2, packages: { api: { path: "api", timeoutSecond: 5 } } },
      "timeoutSecond",
    ],
    [
      "tier",
      {
        version: 2,
        agents: { claude: { tiers: { models: { deep: { model: "opus", efort: "high" } } } } },
      },
      "efort",
    ],
    ["agent", { version: 2, agents: { gemini: { tiers: {} } } }, "gemini"],
  ])("SC8 — an unknown key in a %s is rejected, not dropped", (_label, value, key) => {
    expect(errorOf(value)).toContain(key);
  });

  test("SC9 — a tier's effort must be one of the agent effort levels", () => {
    const valid = ConfigSchema.parse({
      version: 2,
      agents: { claude: { tiers: { models: { deep: { model: "opus", effort: "max" } } } } },
    });
    expect(valid.agents.claude?.tiers.models?.deep?.effort).toBe("max");
    expect(
      errorOf({
        version: 2,
        agents: { claude: { tiers: { models: { deep: { model: "opus", effort: "extreme" } } } } },
      }),
    ).toContain("effort");
  });

  test.each([
    ["an undeclared name", "remote", { local: {} }],
    ["a name every object inherits", "constructor", {}],
    ["another inherited name", "toString", { local: {} }],
  ])("SC10 — environments.default naming %s is rejected", (_label, selected, entries) => {
    expect(errorOf({ version: 2, environments: { default: selected, entries } })).toContain(
      "Must name one of the entries",
    );
  });

  test.each([
    ["an absolute package path", { packages: { api: { path: "/srv/api" } } }],
    ["a package path leaving the repository", { packages: { api: { path: "../api" } } }],
    ["a Windows drive path", { packages: { api: { path: "C:/srv/api" } } }],
    ["a path with a dot segment", { packages: { api: { path: "./api" } } }],
    ["a path with a backslash", { packages: { api: { path: "a\\b" } } }],
    ["a path with an empty segment", { packages: { api: { path: "a//b" } } }],
    ["an extension outside the repository", { extensions: { planning: { skill: "../x.md" } } }],
    [
      "a reference extension outside the repository",
      { extensions: { planning: { references: { notes: { extend: "../x.md" } } } } },
    ],
  ])("SC11 — %s is rejected", (_label, fields) => {
    expect(errorOf({ version: 2, ...fields })).toContain(
      "Expected a path relative to the repository root",
    );
  });

  test.each([
    ["root commands", { commands: { typecheck: "tsc" } }, "commands"],
    ["stage overrides", { stages: { coder: { model: "opus" } } }, "stages"],
    [
      "the v1 notifier's provider key",
      { notifier: { enabled: true, provider: "slack" } },
      "notifier",
    ],
    ["the samskara field", { samskara: { enabled: true } }, "samskara"],
    ["the v1 environments shape", { environments: { default: "local", local: {} } }, "local"],
  ])("SC12 — v1 %s are rejected", (_label, fields, key) => {
    expect(errorOf({ version: 2, ...fields })).toContain(key);
  });

  test("SC103: a v1 hooks block keyed by run-started is refused, naming hooks", () => {
    expect(errorOf({ version: 2, hooks: { "run-started": [] } })).toContain("hooks");
  });
});

describe("subscribers", () => {
  test("SC101: a module subscriber and a command subscriber load in order, keeping their fields", async () => {
    const config = await load(
      "orchestrate.config.yaml",
      `version: 2
subscribers:
  workflow.node.completed:
    - { name: asana, module: yok/asana.ts, handler: onDone }
    - { name: log-it, command: "cat >> subscribers.txt", blocking: false, timeoutSeconds: 5 }
`,
    );

    const [asana, logIt] = config.subscribers["workflow.node.completed"] ?? [];
    expect(asana).toEqual({ name: "asana", module: "yok/asana.ts", handler: "onDone" });
    expect(logIt).toEqual({
      name: "log-it",
      command: "cat >> subscribers.txt",
      blocking: false,
      timeoutSeconds: 5,
    });
  });

  const started = (entries: readonly object[]) => ({ "workflow.started": entries });

  test.each([
    [
      "an entry with both module and command",
      started([{ name: "a", module: "a.ts", handler: "run", command: "true" }]),
      "{ name, module, handler } or { name, command, cwd? }",
    ],
    [
      "an entry with neither module nor command",
      started([{ name: "a" }]),
      "{ name, module, handler } or { name, command, cwd? }",
    ],
    [
      "two entries named a under one event type",
      started([
        { name: "a", command: "true" },
        { name: "a", command: "false" },
      ]),
      "subscriber names must be unique for one event type",
    ],
    [
      "subscriber.called as an event type",
      { "subscriber.called": [{ name: "a", command: "true" }] },
      "no subscriber may listen to subscriber.called",
    ],
    [
      "a module path leaving the repository",
      started([{ name: "a", module: "../x.ts", handler: "run" }]),
      "Expected a path relative to the repository root",
    ],
    [
      "a blocking flag that is not a boolean",
      started([{ name: "a", command: "true", blocking: "no" }]),
      "blocking: boolean",
    ],
    [
      "a blocking subscriber given 26 seconds",
      started([{ name: "a", command: "true", blocking: true, timeoutSeconds: 26 }]),
      "the agent's 30-second hook limit",
    ],
    [
      "a subscriber with blocking left out, so blocking, given 30 seconds",
      started([{ name: "a", module: "a.ts", handler: "run", timeoutSeconds: 30 }]),
      "the agent's 30-second hook limit",
    ],
  ])("SC102: %s is refused with the reason", async (_label, subscribers, reason) => {
    await writeConfig("orchestrate.config.json", JSON.stringify({ version: 2, subscribers }));

    const result = await loadConfig(root);

    expect(result.ok ? "" : result.error.message).toContain(reason);
  });

  test("a non-blocking subscriber may run for 120 seconds", () => {
    const entry = { name: "a", command: "true", blocking: false, timeoutSeconds: 120 };

    const { subscribers } = ConfigSchema.parse({ version: 2, subscribers: started([entry]) });

    expect(subscribers).toEqual({ "workflow.started": [entry] });
  });

  test("SC202: a project subscriber named notifier is refused as the built-in notifier's name", () => {
    const subscribers = started([{ name: "notifier", command: "true" }]);

    expect(errorOf({ version: 2, subscribers })).toContain(
      '"notifier" is the built-in notifier\'s name',
    );
  });
});

describe("notifier", () => {
  test.each<[string, object | undefined, Notifier | undefined]>([
    ["an empty block", {}, { enabled: true, type: "slack" }],
    ["enabled: false", { enabled: false }, { enabled: false, type: "slack" }],
    ["no block", undefined, undefined],
  ])("SC201: %s loads as the notifier it turns on or off", (_label, notifier, expected) => {
    expect(ConfigSchema.parse({ version: 2, notifier }).notifier).toEqual(expected);
  });

  test.each([
    ["an unknown type", { type: "email" }, "notifier.type"],
    ["the v1 provider key", { provider: "slack" }, "notifier"],
  ])("SC201: %s is refused, naming the bad key", (_label, notifier, key) => {
    expect(errorOf({ version: 2, notifier })).toContain(key);
  });
});

describe("loadConfig", () => {
  test.each(["orchestrate.config.yaml", "orchestrate.config.yml"])(
    "SC13 — %s and orchestrate.config.json holding the same content load to the same Config",
    async (yamlName) => {
      const fromYaml = await load(yamlName, exampleYaml);
      root = await mkdtemp(join(tmpdir(), "config-"));
      const fromJson = await load("orchestrate.config.json", exampleJson);
      expect(fromJson).toEqual(fromYaml);
    },
  );

  test("SC14 — a repository without a config file fails with CONFIG_MISSING saying which file to write", async () => {
    const result = await loadConfig(root);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_MISSING");
    expect(result.error.message).toContain("Write orchestrate.config.yaml (version: 2)");
  });

  test("BL10: a top-level baseline command loads, and a number there fails with CONFIG_INVALID", async () => {
    const config = await load(
      "orchestrate.config.json",
      '{"version": 2, "baseline": "bun run baseline"}',
    );
    expect(config.baseline).toEqual({ command: "bun run baseline" });
    await writeConfig("orchestrate.config.json", '{"version": 2, "baseline": 5}');
    const result = await loadConfig(root);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_INVALID");
    expect(result.error.message).toContain("baseline");
  });

  test("CMD1: a command is a string or { command, cwd, timeoutSeconds }, and both load as the object", async () => {
    const config = await load(
      "orchestrate.config.yaml",
      [
        "version: 2",
        "baseline: { command: bun run baseline, cwd: tools, timeoutSeconds: 60 }",
        "packages:",
        "  core:",
        "    path: packages/core",
        "    commands:",
        "      typecheck: bun run typecheck",
        "      testAll: null",
        "      baseline: { command: bun test, cwd: packages/core }",
      ].join("\n"),
    );
    expect(config.baseline).toEqual({
      command: "bun run baseline",
      cwd: "tools",
      timeoutSeconds: 60,
    });
    expect(config.packages.core?.commands).toEqual({
      typecheck: { command: "bun run typecheck" },
      testAll: null,
      baseline: { command: "bun test", cwd: "packages/core" },
    });
  });

  test.each([
    ["an absolute cwd", '{ "command": "x", "cwd": "/tmp" }'],
    ["a cwd that leaves the repo", '{ "command": "x", "cwd": "../other" }'],
    ["a zero timeout", '{ "command": "x", "timeoutSeconds": 0 }'],
    ["an unknown key", '{ "command": "x", "timeout": 5 }'],
    ["no command", '{ "cwd": "tools" }'],
  ])("CMD2: a command object with %s fails with CONFIG_INVALID", async (_, command) => {
    await writeConfig("orchestrate.config.json", `{"version": 2, "baseline": ${command}}`);
    const result = await loadConfig(root);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_INVALID");
  });

  test("SC15 — two config files fail with CONFIG_AMBIGUOUS naming both", async () => {
    await writeConfig("orchestrate.config.yaml", "version: 2\n");
    await writeConfig("orchestrate.config.json", '{"version": 2}');
    const result = await loadConfig(root);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_AMBIGUOUS");
    expect(result.error.message).toContain("orchestrate.config.yaml");
    expect(result.error.message).toContain("orchestrate.config.json");
  });

  test("SC22 — a v1 orchestrate.config.json beside a v2 orchestrate.config.yaml loads the YAML", async () => {
    await writeConfig("orchestrate.config.yaml", "version: 2\nenv:\n  FROM: yaml\n");
    await writeConfig("orchestrate.config.json", '{"stages": {"coder": {}}}');
    const result = await loadConfig(root);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.env).toEqual({ FROM: "yaml" });
  });

  test("SC23 — two config files where neither declares version 2 fail with CONFIG_AMBIGUOUS", async () => {
    await writeConfig("orchestrate.config.yaml", "stages: {}\n");
    await writeConfig("orchestrate.config.json", '{"stages": {}}');
    const result = await loadConfig(root);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_AMBIGUOUS");
  });

  test.each([
    ["unparsable text", "orchestrate.config.yaml", "version: [2\n", "invalid YAML"],
    [
      "a schema violation",
      "orchestrate.config.json",
      '{"version": 2, "agents": {"claude": {"tiers": {"models": {"deep": {}}}}}}',
      "model",
    ],
    ["a file that is not an object", "orchestrate.config.yaml", "- version\n", "version: 2"],
  ])(
    "SC16 — %s fails with CONFIG_INVALID naming the file",
    async (_label, fileName, text, detail) => {
      await writeConfig(fileName, text);
      const result = await loadConfig(root);
      if (result.ok) throw new Error("expected a failure");
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain(join(root, fileName));
      expect(result.error.message).toContain(detail);
    },
  );

  test.each([
    ["no version", { stages: { coder: {} }, commands: { test_all: "node --test" } }, "no version"],
    ["version 1", { version: 1, stages: { coder: {} } }, "version 1"],
    ["a quoted version", { version: "2" }, 'version "2"'],
  ])(
    "SC17 — a config with %s fails with a hint pointing at the v1 migration",
    async (_label, value, found) => {
      await writeConfig("orchestrate.config.json", JSON.stringify(value));
      const result = await loadConfig(root);
      if (result.ok) throw new Error("expected a failure");
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain(`found ${found}`);
      expect(result.error.message).toContain("v1 config");
      expect(result.error.message).toContain("ConfigSchema");
      expect(result.error.message).not.toContain("stages");
    },
  );
});

describe("loadConfigAt", () => {
  test("a path naming a folder fails with an error naming the path", async () => {
    const folder = join(root, "configs");
    await mkdir(folder);
    const result = await loadConfigAt(folder);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain(`${folder}: cannot read config file`);
  });
});
