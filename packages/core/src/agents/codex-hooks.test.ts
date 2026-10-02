import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noopLogger, type RegistryReader } from "@harness/sdk";
import { recordGuard } from "../hooks/pre-tool-use.ts";
import { continueWorkflow } from "../hooks/stop.ts";
import { codexAdapter, readCodexTranscript } from "./codex-hooks.ts";

const NO_RUNS: RegistryReader = {
  findRun: async () => undefined,
  findRunsByName: async () => [],
  listRuns: async () => [],
};
const deps = { registry: NO_RUNS, env: { HARNESS_RUN_ID: "r-1" }, log: noopLogger };

const line = (type: string, payload: unknown): string =>
  JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", type, payload });

describe("codexAdapter.stop", () => {
  test("SC9: unreadable input lets the turn end", async () => {
    expect(await codexAdapter.stop?.("not json", deps, continueWorkflow)).toBe("");
    expect(await codexAdapter.stop?.("{}", deps, continueWorkflow)).toBe("");
  });

  test("SC9: a continue reply is Codex's block JSON, an allow prints nothing", async () => {
    const stdin = JSON.stringify({
      session_id: "s1",
      transcript_path: null,
      stop_hook_active: false,
    });
    const seen: unknown[] = [];
    const handler = (kind: "continue" | "allow") => ({
      name: "t",
      run: async (input: { agent: string; sessionId: string }) => {
        seen.push([input.agent, input.sessionId]);
        return kind === "continue" ? { kind, message: "keep going" } : { kind };
      },
    });

    const blocked = await codexAdapter.stop?.(stdin, deps, handler("continue"));
    const allowed = await codexAdapter.stop?.(stdin, deps, handler("allow"));

    expect(JSON.parse(blocked ?? "")).toEqual({ decision: "block", reason: "keep going" });
    expect(allowed).toBe("");
    expect(seen[0]).toEqual(["codex", "s1"]);
  });
});

describe("codexAdapter.preToolUse", () => {
  const stdin = (tool_name: string, tool_input: Record<string, unknown>) =>
    JSON.stringify({ session_id: "s1", tool_name, tool_input, cwd: "/repo" });
  const TARGET = ".harness/x/state.json";

  test("SC10: a shell write to state.json and an apply_patch on event.jsonl are denied in Codex's format", async () => {
    const patch = `*** Begin Patch\n*** Add File: notes.md\n+hi\n*** Update File: .harness/x/event.jsonl\n@@\n+x\n*** End Patch`;
    for (const input of [
      stdin("Bash", { command: `rm ${TARGET}` }),
      stdin("exec_command", { command: `mv a ${TARGET}` }),
      stdin("exec_command", { cmd: `mv a ${TARGET}` }),
      stdin("local_shell", { command: `rm ${TARGET}` }),
      stdin("shell", { command: ["bash", "-lc", `rm ${TARGET}`] }),
      stdin("apply_patch", { command: patch }),
    ]) {
      const out = (await codexAdapter.preToolUse?.(input, deps, recordGuard)) ?? "";
      expect(JSON.parse(out)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining("orchestrate next --run x"),
        },
      });
    }
  });

  test("SC10: other tools, harmless commands and unreadable input pass silently", async () => {
    const allowed = [
      stdin("Read", { command: TARGET }),
      stdin("shell", { command: "echo hi" }),
      stdin("apply_patch", { command: "*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch" }),
      "not json",
    ];
    for (const input of allowed) {
      expect(await codexAdapter.preToolUse?.(input, deps, recordGuard)).toBe("");
    }
  });
});

describe("codexAdapter.sessionStart", () => {
  test("a handler runs on a Codex SessionStart with the codex agent", async () => {
    const seen: unknown[] = [];
    const out = await codexAdapter.sessionStart?.(
      JSON.stringify({ session_id: "s1", source: "startup", transcript_path: null }),
      deps,
      { name: "t", run: async (input) => void seen.push(input) },
    );
    expect(out).toBe("");
    expect(seen).toEqual([{ agent: "codex", sessionId: "s1", source: "startup" }]);
  });
});

describe("readCodexTranscript", () => {
  test("SC11: prompts and shell commands come out of a rollout, from every shell shape", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "codex-rollout-")), "rollout.jsonl");
    const lines = [
      line("session_meta", { id: "s1" }),
      line("event_msg", { type: "user_message", message: "go" }),
      line("event_msg", { type: "agent_message", message: "thinking" }),
      line("response_item", {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd: "bun run orchestrate next --run x" }),
      }),
      line("response_item", {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"] }),
      }),
      line("response_item", {
        type: "function_call",
        name: "shell",
        arguments: JSON.stringify({ command: ["git", "status"] }),
      }),
      line("response_item", {
        type: "custom_tool_call",
        name: "exec",
        input: 'const r = await tools.exec_command({cmd: "echo \\"hi\\"", yield_time_ms: 1});',
      }),
      line("response_item", { type: "function_call", name: "update_plan", arguments: "{}" }),
      "{not json",
      line("event_msg", { type: "user_message", message: "why?" }),
    ];
    await writeFile(path, lines.join("\n"));

    expect(await readCodexTranscript(path)).toEqual([
      { kind: "prompt", text: "go" },
      { kind: "command", command: "bun run orchestrate next --run x" },
      { kind: "command", command: "ls -la" },
      { kind: "command", command: "git status" },
      { kind: "command", command: 'echo "hi"' },
      { kind: "prompt", text: "why?" },
    ]);
  });

  test("SC11: no path, or a missing file, is unknown", async () => {
    expect(await readCodexTranscript(undefined)).toBeUndefined();
    expect(await readCodexTranscript(join(tmpdir(), "no-such-rollout.jsonl"))).toBeUndefined();
  });
});
