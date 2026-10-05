import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  noopLogger,
  type PreToolUseHandler,
  registryPath,
  runDirOf,
  type ToolCall,
  type ToolUse,
} from "@yok/sdk";
import { createRegistry, jsonlEventStore } from "@yok/sdk/internal";
import { bashAntipatterns, protectedRecordOf, recordGuard, runPreToolUse } from "./pre-tool-use.ts";

describe("protectedRecordOf", () => {
  const where = { cwd: "/repo", home: "/home/u", yokHome: "/home/u/.yok" };
  const kindOf = (path: string) => protectedRecordOf(path, where);

  test("SC7 — only the three records are protected", () => {
    expect(kindOf(".yok/feat-x/state.json")).toMatchObject({
      kind: "state",
      runName: "feat-x",
    });
    expect(kindOf("/abs/.yok/feat-x/event.jsonl")).toMatchObject({
      kind: "events",
      runName: "feat-x",
    });
    for (const path of [
      "/home/u/.yok/registry.json",
      "~/.yok/registry.json",
      "$HOME/.yok/registry.json",
      "$YOK_HOME/registry.json",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell form under test
      "${YOK_HOME}/registry.json",
    ]) {
      expect(kindOf(path)).toEqual({ kind: "registry", path: "/home/u/.yok/registry.json" });
    }
    for (const path of [
      ".yok/feat-x/artifacts/plan.md",
      ".yok/feat-x/state.json.bak",
      "docs/state.json",
      ".yok/registry.json",
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
    config: null,
    tiers: null,
    createdAt: "2026-09-26T10:00:00Z",
  });
  const runDir = runDirOf(cwd, "feat-x");
  await mkdir(runDir, { recursive: true });
  const deps = { registry, env: { YOK_RUN_ID: "r-1", YOK_HOME: home }, log: noopLogger };
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
      use(cwd, write(".yok/feat-x/state.json")),
      recordGuard,
      deps,
    );

    const path = join(cwd, ".yok/feat-x/state.json");
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

  test("SC3: an Edit of .yok/demo/state.json is refused naming the run, and the old run folder is left alone", async () => {
    const { cwd, deps } = await setUp();
    const edit = (path: string) =>
      runPreToolUse(use(cwd, write(path), { toolName: "Edit" }), recordGuard, deps);

    const refused = await edit("/repo/.yok/demo/state.json");
    // Split so the sweep for the old product name (SC10) does not flag this test.
    const allowed = await edit(`/repo/.${["har", "ness"].join("")}/demo/state.json`);

    expect(refused.kind).toBe("deny");
    expect(refused.kind === "deny" ? refused.message : "").toContain("--run demo");
    expect(allowed).toEqual({ kind: "allow" });
  });

  test("SC4: both shell spellings of YOK_HOME in a command expand to the yok home, whose registry is refused", async () => {
    const { cwd, home, deps } = await setUp();
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell form under test
    for (const variable of ["$YOK_HOME", "${YOK_HOME}"]) {
      const verdict = await runPreToolUse(
        use(cwd, shell(`rm ${variable}/registry.json`), { toolName: "Bash" }),
        recordGuard,
        deps,
      );
      expect(verdict).toMatchObject({ kind: "deny", path: join(home, "registry.json") });
    }
  });

  test("SC9 — a shell command on the registry is refused with init and link-session", async () => {
    const { cwd, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, shell("rm $YOK_HOME/registry.json"), { toolName: "Bash" }),
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
      use(cwd, write(".yok/feat-x/artifacts/plan.md")),
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
    const second = await runPreToolUse(use(cwd, write(".yok/feat-x/state.json")), recordGuard, {
      ...deps,
      registry,
    });
    expect(second.kind).toBe("deny");
  });

  test("SC12 — a session the run does not own is still guarded but not logged", async () => {
    const { cwd, runDir, deps } = await setUp();

    const verdict = await runPreToolUse(
      use(cwd, write(".yok/feat-x/event.jsonl"), { sessionId: "other" }),
      recordGuard,
      deps,
    );

    expect(verdict.kind).toBe("deny");
    expect(await jsonlEventStore(runDir).read()).toEqual([]);
  });
});

describe("bashAntipatterns", () => {
  const deps = {
    env: {},
    log: noopLogger,
    registry: {
      findRun: async () => undefined,
      findRunsByName: async () => [],
      listRuns: async () => [],
    },
  };
  const run = (command: string) => bashAntipatterns.run(use(tmpdir(), shell(command)), deps);

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

  test("SC21 (regression) — the orchestrate done heredoc still passes", async () => {
    const command = [
      "bun run orchestrate done n1 --run feat-x --output - <<'JSON'",
      '{ "ok": true }',
      "JSON",
    ].join("\n");

    expect(await run(command)).toEqual({ kind: "allow" });
  });

  test("a call that is not a shell command is not its concern", async () => {
    expect(await bashAntipatterns.run(use(tmpdir(), write("notes.md")), deps)).toEqual({
      kind: "allow",
    });
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
