import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger, type Registry } from "@harness/sdk";
import { claudeHookSettings, claudeStopHook, readClaudeTranscript } from "./claude-hooks.ts";

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

describe("claudeStopHook", () => {
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

    expect(await claudeStopHook("not json", deps)).toBe("");
    expect(await claudeStopHook("{}", deps)).toBe("");
    expect(lookups).toBe(0);
  });
});

describe("claudeHookSettings", () => {
  test("SC18 — the settings run the hook command with every argument quoted", () => {
    const settings = claudeHookSettings(["/usr/bin/bun", "/opt/it's here/orchestrate.ts", "hook"]);
    expect(settings.hooks.Stop[0]?.hooks[0]).toEqual({
      type: "command",
      command:
        "'/usr/bin/bun' '/opt/it'\\''s here/orchestrate.ts' 'hook' 'stop' '--agent' 'claude'",
      timeout: 30,
    });
  });
});
