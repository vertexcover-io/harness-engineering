import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import * as z from "zod";
import { type Config, ConfigSchema, loadConfig } from "./config.ts";

const exampleYaml = `version: 2
doctor: bun bin/doctor.ts

tiers:
  deep: { agent: claude, model: opus, effort: high }
  standard: { agent: claude, model: sonnet }
  fast: { agent: claude, model: haiku }

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
  planning: harness/planning.md

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

describe("ConfigSchema", () => {
  test("SC1 — a file holding only version 2 loads with every map empty", () => {
    const config = ConfigSchema.parse({ version: 2 });
    expect(config).toEqual({
      version: 2,
      tiers: {},
      packages: {},
      extensions: {},
      env: {},
    });
  });

  test("SC2 — a full example loads with defaults filled", async () => {
    const config = await load("orchestrate.config.yaml", exampleYaml);
    expect(config.tiers.deep).toEqual({ agent: "claude", model: "opus", effort: "high" });
    expect(config.packages.root).toEqual({
      path: ".",
      timeoutSeconds: 300,
      commands: {
        typecheck: "bun run typecheck",
        lint: "bun run lint",
        testAll: "bun test ./packages",
        testFile: "bun test {FILE}",
      },
    });
    expect(config.packages.api?.timeoutSeconds).toBe(600);
    expect(config.environments?.default).toBe("local");
    expect(Object.keys(config.environments?.entries.local ?? {})).toEqual([
      "stackUp",
      "stackStatus",
      "stackDown",
    ]);
    expect(config.extensions).toEqual({ planning: "harness/planning.md" });
  });

  test.each([
    ["command", { packages: { root: { path: ".", commands: { test_all: "x" } } } }, "test_all"],
    ["package", { packages: { "my-api": { path: "api" } } }, "my-api"],
    ["tier", { tiers: { "deep-think": { agent: "claude" } } }, "deep-think"],
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
    ["extension skill", { extensions: { Planning: "a.md" } }, "Planning"],
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
    ["tier", { version: 2, tiers: { deep: { agent: "claude", modle: "opus" } } }, "modle"],
  ])("SC8 — an unknown key in a %s is rejected, not dropped", (_label, value, key) => {
    expect(errorOf(value)).toContain(key);
  });

  test("SC9 — a tier's effort must be one of the agent effort levels", () => {
    const valid = ConfigSchema.parse({
      version: 2,
      tiers: { deep: { agent: "claude", effort: "max" } },
    });
    expect(valid.tiers.deep?.effort).toBe("max");
    expect(
      errorOf({ version: 2, tiers: { deep: { agent: "claude", effort: "extreme" } } }),
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
    ["an extension outside the repository", { extensions: { planning: "../x.md" } }],
  ])("SC11 — %s is rejected", (_label, fields) => {
    expect(errorOf({ version: 2, ...fields })).toContain(
      "Expected a path relative to the repository root",
    );
  });

  test.each([
    ["root commands", { commands: { typecheck: "tsc" } }, "commands"],
    ["stage overrides", { stages: { coder: { model: "opus" } } }, "stages"],
    ["the notifier field", { notifier: { enabled: true, provider: "slack" } }, "notifier"],
    ["the samskara field", { samskara: { enabled: true } }, "samskara"],
    ["hooks, which belong to workflows", { hooks: { "run-started": [] } }, "hooks"],
    ["the v1 environments shape", { environments: { default: "local", local: {} } }, "local"],
  ])("SC12 — v1 %s are rejected", (_label, fields, key) => {
    expect(errorOf({ version: 2, ...fields })).toContain(key);
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

  test("SC14 — a repository without a config file fails with CONFIG_MISSING naming setup-harness", async () => {
    const result = await loadConfig(root);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error.code).toBe("CONFIG_MISSING");
    expect(result.error.message).toContain("setup-harness");
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

  test.each([
    ["unparsable text", "orchestrate.config.yaml", "version: [2\n", "invalid YAML"],
    [
      "a schema violation",
      "orchestrate.config.json",
      '{"version": 2, "tiers": {"deep": {}}}',
      "agent",
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
