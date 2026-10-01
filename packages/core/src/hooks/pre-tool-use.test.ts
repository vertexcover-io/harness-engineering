import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRegistry,
  jsonlEventStore,
  noopLogger,
  type PreToolUseHandler,
  registryPath,
  runDirOf,
  type ToolCall,
  type ToolUse,
} from "@harness/sdk";
import { bashAntipatterns, protectedRecordOf, recordGuard, runPreToolUse } from "./pre-tool-use.ts";

describe("protectedRecordOf", () => {
  const where = { cwd: "/repo", home: "/home/u", harnessHome: "/home/u/.harness" };
  const kindOf = (path: string) => protectedRecordOf(path, where);

  test("SC7 — only the three records are protected", () => {
    expect(kindOf(".harness/feat-x/state.json")).toMatchObject({
      kind: "state",
      runName: "feat-x",
    });
    expect(kindOf("/abs/.harness/feat-x/event.jsonl")).toMatchObject({
      kind: "events",
      runName: "feat-x",
    });
    for (const path of [
      "/home/u/.harness/registry.json",
      "~/.harness/registry.json",
      "$HOME/.harness/registry.json",
      "$HARNESS_HOME/registry.json",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell form under test
      "${HARNESS_HOME}/registry.json",
    ]) {
      expect(kindOf(path)).toEqual({ kind: "registry", path: "/home/u/.harness/registry.json" });
    }
    for (const path of [
      ".harness/feat-x/artifacts/plan.md",
      ".harness/feat-x/state.json.bak",
      "docs/state.json",
      ".harness/registry.json",
    ]) {
      expect(kindOf(path)).toBeUndefined();
    }
  });
});

// A registry run r-1 named feat-x in a temp repo, owned by claude session s1.
const setUp = async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pre-tool-home-")));
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "pre-tool-repo-")));
  const registry = createRegistry(registryPath(home));
  await registry.addRun({
    id: "r-1",
    workflow: "feature",
    workflowPath: join(cwd, "workflow.yaml"),
    inputs: {},
    cwd,
    sessions: [{ agent: "claude", sessionId: "s1" }],
    name: "feat-x",
    terminal: null,
    createdAt: "2026-09-26T10:00:00Z",
  });
  const runDir = runDirOf(cwd, "feat-x");
  await mkdir(runDir, { recursive: true });
  const deps = { registry, env: { HARNESS_RUN_ID: "r-1", HARNESS_HOME: home }, log: noopLogger };
  return { cwd, home, runDir, deps };
};

const use = (cwd: string, call: ToolCall, overrides: Partial<ToolUse> = {}): ToolUse => ({
  agent: "claude",
  sessionId: "s1",
  toolName: "Write",
  cwd,
  call,
  ...overrides,
});
const write = (path: string): ToolCall => ({ kind: "file-write", path });
const shell = (command: string): ToolCall => ({ kind: "shell", command });

describe("recordGuard through runPreToolUse", () => {
  test("SC8 — a write tool on a run record is refused with the orchestrate commands, and logged", async () => {
    const { cwd, runDir, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, write(".harness/feat-x/state.json")),
      recordGuard,
      deps,
    );

    const path = join(cwd, ".harness/feat-x/state.json");
    expect(verdict).toMatchObject({ kind: "deny", path });
    const message = verdict.kind === "deny" ? verdict.message : "";
    expect(message).toContain("bun run orchestrate next --run feat-x");
    expect(message).toContain("exec|done NODE_RUN_ID --run feat-x");
    expect(message).toContain("orchestrate emit");
    expect((await jsonlEventStore(runDir).read()).map((event) => event.payload)).toEqual([
      {
        agent: "claude",
        sessionId: "s1",
        tool: "Write",
        handler: "record-guard",
        decision: "deny",
        message,
        path,
      },
    ]);
  });

  test("SC9 — a shell command on the registry is refused with init and link-session", async () => {
    const { cwd, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, shell("rm $HARNESS_HOME/registry.json"), { toolName: "Bash" }),
      recordGuard,
      deps,
    );

    const message = verdict.kind === "deny" ? verdict.message : "";
    expect(message).toContain("bun run orchestrate init");
    expect(message).toContain("link-session");
  });

  test("SC10 — other writes pass and are not logged", async () => {
    const { cwd, runDir, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, write(".harness/feat-x/artifacts/plan.md")),
      recordGuard,
      deps,
    );

    expect(verdict).toEqual({ kind: "allow" });
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
  });

  test("SC11 — a failing handler allows, and a failing log still answers", async () => {
    const { cwd, deps } = await setUp();
    const boom: PreToolUseHandler = {
      name: "boom",
      run: async () => {
        throw new Error("boom");
      },
    };

    expect(await runPreToolUse(use(cwd, write("notes.md")), boom, deps)).toEqual({ kind: "allow" });

    const registry = {
      ...deps.registry,
      findRun: async () => {
        throw new Error("registry down");
      },
    };
    const second = await runPreToolUse(use(cwd, write(".harness/feat-x/state.json")), recordGuard, {
      ...deps,
      registry,
    });
    expect(second.kind).toBe("deny");
  });

  test("SC12 — a session the run does not own is still guarded but not logged", async () => {
    const { cwd, runDir, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, write(".harness/feat-x/event.jsonl"), { sessionId: "other" }),
      recordGuard,
      deps,
    );

    expect(verdict.kind).toBe("deny");
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
  });
});

describe("bashAntipatterns", () => {
  const context = { cwd: tmpdir(), env: {}, log: noopLogger };
  const run = (command: string) => bashAntipatterns.run(shell(command), context);

  test("SC19 — the vendored script keeps its license and upstream pointer", async () => {
    const text = await readFile(
      join(import.meta.dir, "..", "..", "vendor", "bash-antipatterns.sh"),
      "utf8",
    );

    expect(text.split("\n")[0]).toBe("#!/usr/bin/env bash");
    expect(text).toContain("Copyright (c) 2026 Lauri Gates");
    expect(text).toContain("Permission is hereby granted, free of charge");
    expect(text).toContain(
      "https://github.com/laurigates/claude-plugins/blob/2e07766617d92e8955e9939014e949836b6356ba/hooks-plugin/hooks/bash-antipatterns.sh",
    );
    expect(text).toContain(
      "# PreToolUse hook for Bash tool - detects anti-patterns and reminds Claude",
    );
  });

  test("SC20 — a shell write to an ordinary file is refused, whichever agent sent it", async () => {
    const verdict = await run("echo hi > notes.md");

    expect(verdict.kind).toBe("deny");
    expect(verdict.kind === "deny" && verdict.message).toContain("Write tool");
  });

  test("SC21 (regression) — the orchestrate-v2 done heredoc still passes", async () => {
    const command = [
      "bun run orchestrate done n1 --run feat-x --output - <<'JSON'",
      '{ "ok": true }',
      "JSON",
    ].join("\n");

    expect(await run(command)).toEqual({ kind: "allow" });
  });

  test("a call that is not a shell command is not its concern", async () => {
    expect(await bashAntipatterns.run(write("notes.md"), context)).toEqual({ kind: "allow" });
  });

  test("SC22 — a script that cannot run lets the call through", async () => {
    const saved = process.env.PATH;
    // /bin has bash and cat but not jq, which the script needs to read its input.
    process.env.PATH = "/bin";
    try {
      expect(await run("echo hi > notes.md")).toEqual({ kind: "allow" });
    } finally {
      process.env.PATH = saved;
    }
  });
});
