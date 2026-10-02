import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Glob } from "bun";

const filesContaining = (
  pattern: string,
  needle: string | RegExp,
  options?: { excludeTests?: boolean },
): string[] => {
  const matches: string[] = [];
  for (const file of new Glob(pattern).scanSync(".")) {
    if (options?.excludeTests === true && file.includes(".test.")) continue;
    const text = readFileSync(file, "utf8");
    if (typeof needle === "string" ? text.includes(needle) : needle.test(text)) matches.push(file);
  }
  return matches.sort();
};

const PUBLIC_RUNTIME_NAMES = [
  "AbsolutePathSchema",
  "AgentStateSchema",
  "AgentTypeSchema",
  "ArtifactRefSchema",
  "CheckStatusSchema",
  "ConfigSchema",
  "ContextStartedEvent",
  "ERROR_MESSAGE_LIMIT",
  "EffortSchema",
  "EmitInputSchema",
  "ErrorSchema",
  "EventHandlerRefSchema",
  "EventHandlerRefsSchema",
  "EventSchema",
  "EventTypeSchema",
  "FindingSchema",
  "GitStateSchema",
  "JsonObjectSchema",
  "LayoutSchema",
  "LimitReachedEvent",
  "LimitResumedEvent",
  "LimitWaitingEvent",
  "LogLevelSchema",
  "NOT_FOUND",
  "NameSchema",
  "NodeIteratedEvent",
  "NodeRunSchema",
  "NodeStartedEvent",
  "NodeTypeSchema",
  "NonEmptyStringSchema",
  "NotificationSchema",
  "PermissionModeSchema",
  "PreToolUseCalledEvent",
  "ProcessRecordSchema",
  "PullRequestSchema",
  "RepositorySchema",
  "SessionRefSchema",
  "SessionReplacedEvent",
  "SessionStartCalledEvent",
  "SkillNameSchema",
  "SkipOutputSchema",
  "SlugSchema",
  "StateSchema",
  "StopCalledEvent",
  "StopReasonSchema",
  "TicketSchema",
  "TokenUsageSchema",
  "VerifierErrorReasonSchema",
  "VerifierResultSchema",
  "VerifierRunSchema",
  "WorkflowEndedEvent",
  "WorkflowRefSchema",
  "WorkflowRunSchema",
  "WorkflowStartedEvent",
  "WorkspaceCreateFailedEvent",
  "WorkspaceCreatedEvent",
  "WorkspaceRemoveFailedEvent",
  "WorkspaceRemovedEvent",
  "WorkspaceRepositoryAddFailedEvent",
  "WorkspaceRepositoryAddedEvent",
  "WorkspaceRepositoryRemoveFailedEvent",
  "WorkspaceRepositoryRemovedEvent",
  "WorkspaceSchema",
  "checkBinary",
  "createGit",
  "createRegistryReader",
  "emitRunEvent",
  "eventError",
  "execWithTimeout",
  "fail",
  "findConfigRoot",
  "findRoot",
  "findTierModel",
  "harnessHome",
  "isNormalizedRelativePath",
  "jsonLogger",
  "killRunning",
  "loadCheckoutConfig",
  "loadConfig",
  "loadConfigAt",
  "loadConfigFile",
  "loadConfigOrDefault",
  "loadNamedConfig",
  "loadPickedConfig",
  "loadRecordedConfig",
  "loadRunConfig",
  "loadStartConfig",
  "noopLogger",
  "ok",
  "parseFrontmatter",
  "parseJson",
  "parseYaml",
  "pickRun",
  "readIfExists",
  "readProjectEnv",
  "readState",
  "readText",
  "registryPath",
  "requireRun",
  "resolveRun",
  "runDirOf",
  "spawn",
  "spawnDetached",
  "spawnInteractive",
  "stackOf",
  "stopRunningOnSignal",
  "tierLaunch",
  "toRepoId",
  "unknownPackage",
  "warn",
  "withLock",
];

describe("source boundaries", () => {
  test('SC33: only packages/sdk/src/git.ts calls exec("git"', () => {
    expect(filesContaining("packages/*/src/**/*.ts", 'exec("git"', { excludeTests: true })).toEqual(
      ["packages/sdk/src/git.ts"],
    );
  });

  test("SC40: sdk src never import pino directly", () => {
    // excludeTests: true, so this assertion's own needle text can't match itself.
    expect(
      filesContaining("packages/sdk/src/**/*.ts", 'from "pino', { excludeTests: true }),
    ).toEqual([]);
  });

  test("SC3: no source file imports the deleted agents package, and the package is gone", () => {
    // Built from parts so this file's own needle text can't match itself.
    const agentsImport = ["@harness", "agents"].join("/");
    const sources = ["packages/*/src/**/*.ts", "skills/**/*.{ts,mts,js,mjs}"].flatMap((pattern) =>
      filesContaining(pattern, agentsImport),
    );
    expect(sources).toEqual([]);
    expect(existsSync("packages/agents")).toBe(false);
  });

  test("sdk never imports core, so it installs as a library on its own", () => {
    // Built from parts so this file's own needle text can't match itself.
    const coreImport = `from "${["@harness", "core"].join("/")}"`;
    expect(filesContaining("packages/sdk/**/*.ts", coreImport)).toEqual([]);
  });

  // A write can name the file through a variable or helper, so the check is on the path itself:
  // only state.ts may build a path to state.json at all. Others read it through readState.
  test("EH11 — only packages/sdk/src/state.ts builds a path to state.json, so every write goes through its lock", () => {
    const statePath = /[/"'`]state\.json["'`]/;
    const sources = ["packages/*/src/**/*.ts", "skills/**/*.{ts,mts,js,mjs}"].flatMap((pattern) =>
      filesContaining(pattern, statePath, { excludeTests: true }),
    );
    expect(sources).toEqual(["packages/sdk/src/state.ts"]);
  });

  test("EH12 — no skill script imports @harness/core; skills act on a run through the orchestrate script or the sdk", () => {
    expect(filesContaining("skills/**/*.{ts,mts,js,mjs}", /["']@harness\/core["'/]/)).toEqual([]);
  });

  test("SC5: @harness/sdk exports exactly the agreed runtime names", async () => {
    const names = Object.keys(await import("@harness/sdk")).sort();
    expect(names).toEqual(PUBLIC_RUNTIME_NAMES);
    expect(names).toEqual(
      expect.arrayContaining([
        "emitRunEvent",
        "createRegistryReader",
        "resolveRun",
        "readState",
        "VerifierResultSchema",
      ]),
    );
    for (const hidden of [
      "createRegistry",
      "syncState",
      "createState",
      "appendRunEvent",
      "builtInHandlers",
      "jsonlEventStore",
      "continueWorkflow",
      "recordGuard",
    ]) {
      expect(names).not.toContain(hidden);
    }
  });

  test("SC6: the public index and the internal entry name every export", () => {
    const star = ["export", "*"].join(" ");
    expect(
      ["packages/sdk/src/index.ts", "packages/sdk/src/internal.ts"].filter((file) =>
        readFileSync(file, "utf8").includes(star),
      ),
    ).toEqual([]);
  });

  test("SC7: no skill script imports the sdk's internal entry", () => {
    const internalImport = ["@harness/sdk", "internal"].join("/");
    expect(
      filesContaining("skills/**/*.{ts,mts,js,mjs}", internalImport, { excludeTests: true }),
    ).toEqual([]);
  });
});
