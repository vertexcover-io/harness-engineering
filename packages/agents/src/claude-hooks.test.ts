import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { continueWorkflow, noopLogger, type Registry, recordGuard } from "@harness/sdk";
import { claudeAdapter, claudeHookSettings, readClaudeTranscript } from "./claude-hooks.ts";

const claudeStop = claudeAdapter.stop;
const claudePreToolUse = claudeAdapter.preToolUse;

const line = (value: unknown): string => JSON.stringify(value);
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  line({ type: "user", ...extra, message: { role: "user", content } });
const assistant = (content: unknown) =>
  line({ type: "assistant", message: { role: "assistant", content } });

describe("readClaudeTranscript", () => {
  test("SC15 — the Claude transcript reads as prompts and shell commands, in order", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "claude-transcript-")), "s1.jsonl");
    const lines = [
      user("go"),
      assistant([
        { type: "text", text: "Running next." },
        {
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: { command: "bun run orchestrate next --run feat-x" },
        },
      ]),
      user([{ type: "tool_result", tool_use_id: "t1", content: "{}" }]),
      user("Stop hook feedback: node plan is still open", { isMeta: true }),
      user([{ type: "text", text: "Stop hook feedback: run next" }]),
      assistant([{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/a" } }]),
      "{not json",
      user("<task-notification>task b1 completed</task-notification>", {
        origin: { kind: "task-notification" },
      }),
      user([{ type: "text", text: "why?" }]),
    ];
    await writeFile(path, lines.join("\n"));

    expect(await readClaudeTranscript(path)).toEqual([
      { kind: "prompt", text: "go" },
      { kind: "command", command: "bun run orchestrate next --run feat-x" },
      { kind: "prompt", text: "why?" },
    ]);
  });

  test("SC15 — no path, or a path that does not exist, is unknown", async () => {
    expect(await readClaudeTranscript(undefined)).toBeUndefined();
    expect(await readClaudeTranscript(join(tmpdir(), "no-such-transcript.jsonl"))).toBeUndefined();
  });
});

describe("claudeAdapter.stop", () => {
  test("SC16 — input Claude's hook cannot read lets the turn end without looking up a run", async () => {
    let lookups = 0;
    const registry: Registry = {
      findRun: async () => {
        lookups += 1;
        throw new Error("findRun must not be called");
      },
      findRunsByName: async () => [],
      addRun: async () => {},
      removeRun: async () => {},
      initRun: async () => {},
      linkSession: async () => {},
    };
    const deps = { registry, env: { HARNESS_RUN_ID: "r-1" }, log: noopLogger };

    expect(await claudeStop?.("not json", deps, continueWorkflow)).toBe("");
    expect(await claudeStop?.("{}", deps, continueWorkflow)).toBe("");
    expect(lookups).toBe(0);
  });
});

describe("claudeHookSettings", () => {
  test("SC18 — the settings run the hook command with every argument quoted", () => {
    const settings = claudeHookSettings(["/usr/bin/bun", "/opt/it's here/orchestrate.ts", "hook"]);
    expect(settings.hooks.Stop[0]?.hooks[0]).toEqual({
      type: "command",
      command:
        "'/usr/bin/bun' '/opt/it'\\''s here/orchestrate.ts' 'hook' 'stop' '--agent' 'claude' '--handler' 'continue-workflow'",
      timeout: 30,
    });
  });
});

describe("claudeAdapter.preToolUse", () => {
  const registry: Registry = {
    findRun: async () => undefined,
    findRunsByName: async () => [],
    addRun: async () => {},
    removeRun: async () => {},
    initRun: async () => {},
    linkSession: async () => {},
  };
  const deps = { registry, env: { HARNESS_RUN_ID: "r-1" }, log: noopLogger };
  const stdin = (tool_name: string, tool_input: Record<string, unknown>) =>
    JSON.stringify({ session_id: "s1", tool_name, tool_input, cwd: "/repo" });
  const TARGET = ".harness/x/state.json";

  test("SC14 — Claude's tool shapes map to the guard and deny in Claude's format", async () => {
    const inputs = [
      stdin("Write", { file_path: TARGET }),
      stdin("Edit", { file_path: TARGET }),
      stdin("MultiEdit", { file_path: TARGET }),
      stdin("NotebookEdit", { notebook_path: TARGET }),
      stdin("Bash", { command: `rm ${TARGET}` }),
    ];
    for (const input of inputs) {
      const out = (await claudePreToolUse?.(input, deps, recordGuard)) ?? "";
      expect(out.endsWith("\n")).toBe(true);
      expect(JSON.parse(out)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("bun run orchestrate next --run x"),
        },
      });
    }
    const read = stdin("Read", { file_path: TARGET });
    expect(await claudePreToolUse?.(read, deps, recordGuard)).toBe("");
    expect(await claudePreToolUse?.("not json", deps, recordGuard)).toBe("");
    const missingTool = JSON.stringify({ session_id: "s1", tool_input: {} });
    expect(await claudePreToolUse?.(missingTool, deps, recordGuard)).toBe("");
  });
});

describe("claudeHookSettings PreToolUse", () => {
  test("SC15 — each registered handler gets its own command, grouped by matcher", () => {
    const settings = claudeHookSettings(["/usr/bin/bun", "/o.ts", "hook"]);
    const command = (handler: string) =>
      `'/usr/bin/bun' '/o.ts' 'hook' 'pre-tool-use' '--agent' 'claude' '--handler' '${handler}'`;
    expect(settings.hooks.PreToolUse).toEqual([
      {
        matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
        hooks: [{ type: "command", command: command("record-guard"), timeout: 30 }],
      },
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: command("bash-antipatterns"), timeout: 30 }],
      },
    ]);
    expect(settings.hooks.Stop[0]?.hooks[0]?.command).toEndWith(
      "'stop' '--agent' 'claude' '--handler' 'continue-workflow'",
    );
  });
});
