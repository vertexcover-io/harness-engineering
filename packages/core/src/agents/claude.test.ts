import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ITerminal,
  type ITerminalHost,
  jsonLogger,
  type Result,
  type TerminalSpec,
} from "@harness/sdk";
import * as z from "zod";
import {
  claudeArgs,
  claudeProvider,
  claudeRunArgs,
  interpretOutput,
  isClaudeBusy,
} from "./claude.ts";
import { claudeHookSettings } from "./claude-hooks.ts";

describe("claudeArgs", () => {
  test("SC1: every option present puts the flags in order with prompt last", () => {
    expect(
      claudeArgs("id-1", {
        model: "opus",
        effort: "high",
        permissionMode: "plan",
        systemPrompt: "be terse",
        prompt: "fix the bug",
      }),
    ).toEqual([
      "--session-id",
      "id-1",
      "--model",
      "opus",
      "--effort",
      "high",
      "--permission-mode",
      "plan",
      "--append-system-prompt",
      "be terse",
      "fix the bug",
    ]);
  });

  test("SC1: omitted options add nothing beyond the session id", () => {
    expect(claudeArgs("id-2", {})).toEqual(["--session-id", "id-2"]);
  });

  test("SC24 — a hook command adds Claude settings with the Stop hook before the prompt", () => {
    const hookCommand = ["/b", "/o.ts", "hook"];
    const args = claudeArgs("id-1", { hookCommand, prompt: "go" });
    expect(args).toEqual(["--session-id", "id-1", "--settings", expect.any(String), "go"]);
    expect(JSON.parse(args[3] ?? "")).toEqual(claudeHookSettings(hookCommand));
  });
});

type Call =
  | { readonly method: "create"; readonly spec: TerminalSpec; readonly at: number }
  | {
      readonly method: "sendText";
      readonly pane: string;
      readonly text: string;
      readonly at: number;
    }
  | {
      readonly method: "sendKeys";
      readonly pane: string;
      readonly keys: readonly string[];
      readonly at: number;
    }
  | { readonly method: "kill"; readonly pane: string; readonly at: number }
  | {
      readonly method: "respawn";
      readonly pane: string;
      readonly spec: Omit<TerminalSpec, "name">;
      readonly at: number;
    };

const ok: Result<void> = { ok: true, value: undefined };

// A pane that records every call against its own name, and shows each of `screens` in turn.
const fakePane = (
  pane: string,
  calls: Call[],
  alive: boolean,
  screens: readonly string[] = [""],
): ITerminal => {
  let captures = 0;
  return {
    sendText: (text) => {
      calls.push({ method: "sendText", pane, text, at: Date.now() });
      return Promise.resolve(ok);
    },
    sendKeys: (keys) => {
      calls.push({ method: "sendKeys", pane, keys, at: Date.now() });
      return Promise.resolve(ok);
    },
    kill: () => {
      calls.push({ method: "kill", pane, at: Date.now() });
      return Promise.resolve(ok);
    },
    capture: () =>
      Promise.resolve({ ok: true, value: screens[Math.min(captures++, screens.length - 1)] ?? "" }),
    rename: () => Promise.resolve(ok),
    respawn: (spec) => {
      calls.push({ method: "respawn", pane, spec, at: Date.now() });
      return Promise.resolve(ok);
    },
    isAlive: () => Promise.resolve(alive),
    attachCommand: () => ["tmux", "attach-session", "-t", pane],
  };
};

const fakeHost = (
  options: { alive?: boolean; createOk?: boolean } = {},
): ITerminalHost & { calls: Call[] } => {
  const calls: Call[] = [];
  const alive = options.alive ?? true;
  return {
    calls,
    checks: [],
    create: (spec) => {
      calls.push({ method: "create", spec, at: Date.now() });
      return Promise.resolve(
        options.createOk === false
          ? { ok: false, error: "boom" }
          : { ok: true, value: fakePane(spec.name, calls, alive) },
      );
    },
    find: (name) => fakePane(name, calls, alive),
    list: () => Promise.resolve([]),
  };
};

describe("claudeProvider.prompt", () => {
  test("SC6: a session whose isAlive is false returns ok:false and sends nothing", async () => {
    const host = fakeHost({ alive: false });
    const provider = claudeProvider({ host, newId: () => "s1" });

    const result = await provider.prompt(host.find("s1"), "hello");

    expect(result).toEqual({ ok: false, error: "the agent's terminal is not running" });
    expect(host.calls).toHaveLength(0);
  });

  test("SC7: a live session sends the text into its own pane, then Enter at least 150ms later", async () => {
    const host = fakeHost({ alive: true });
    const provider = claudeProvider({ host, newId: () => "s1" });

    const result = await provider.prompt(host.find("s1"), "hello");

    expect(result).toEqual({ ok: true, value: undefined });
    expect(host.calls.map((c) => c.method)).toEqual(["sendText", "sendKeys"]);
    const [sendText, sendKeys] = host.calls;
    expect(sendText).toMatchObject({ method: "sendText", pane: "s1", text: "hello" });
    expect(sendKeys).toMatchObject({ method: "sendKeys", keys: ["Enter"] });
    expect((sendKeys?.at ?? 0) - (sendText?.at ?? 0)).toBeGreaterThanOrEqual(149);
  });
});

describe("claudeProvider.launch", () => {
  test("a terminal that fails to create the session returns ok:false", async () => {
    const provider = claudeProvider({
      host: fakeHost({ createOk: false }),
      newId: () => "s1",
    });

    expect(await provider.launch({ cwd: "/repo" })).toEqual({ ok: false, error: "boom" });
  });

  test("returns the pane it created, so a later prompt and stop reach it without a name lookup", async () => {
    const host = fakeHost();
    const provider = claudeProvider({ host, newId: () => "s1" });

    const launched = await provider.launch({ cwd: "/repo" });
    if (!launched.ok) throw new Error(launched.error);
    await provider.prompt(launched.value.terminal, "hello");
    await provider.stop(launched.value.terminal);

    expect(launched.value.sessionId).toBe("s1");
    expect(host.calls.map((c) => [c.method, "pane" in c ? c.pane : c.spec.name])).toEqual([
      ["create", "s1"],
      ["sendText", "s1"],
      ["sendKeys", "s1"],
      ["kill", "s1"],
    ]);
  });
});

describe("claudeProvider.relaunch", () => {
  test("replaces the program in the pane with claude on the given session id and first prompt", async () => {
    const host = fakeHost();
    const provider = claudeProvider({ host, binary: "/bin/claude", newId: () => "unused" });

    const result = await provider.relaunch(host.find("%3"), "s-new", {
      cwd: "/repo",
      prompt: "/orchestrate-v2 --resume feat-x",
      env: { HARNESS_RUN_ID: "r-1" },
      hookCommand: ["/usr/bin/bun", "/o.ts", "hook"],
    });

    expect(result).toEqual({ ok: true, value: undefined });
    const [call] = host.calls;
    expect(call).toMatchObject({ method: "respawn", pane: "%3" });
    const spec = call?.method === "respawn" ? call.spec : undefined;
    expect(spec?.cwd).toBe("/repo");
    expect(spec?.env).toEqual({ HARNESS_RUN_ID: "r-1" });
    expect(spec?.argv.slice(0, 3)).toEqual(["/bin/claude", "--session-id", "s-new"]);
    expect(spec?.argv).toContain("--settings");
    expect(spec?.argv.at(-1)).toBe("/orchestrate-v2 --resume feat-x");
  });
});

describe("claudeProvider.launch logging", () => {
  test("SC37: no log line contains the prompt or system-prompt text", async () => {
    const lines: string[] = [];
    const log = jsonLogger({ level: "debug", write: (line) => lines.push(line) });
    const provider = claudeProvider({ host: fakeHost(), log, newId: () => "s1" });

    await provider.launch({
      cwd: "/repo",
      prompt: "SECRET_PROMPT_TEXT",
      systemPrompt: "SECRET_SYSTEM_PROMPT_TEXT",
    });

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("SECRET_PROMPT_TEXT");
    expect(serialized).not.toContain("SECRET_SYSTEM_PROMPT_TEXT");
  });
});

const outputSchema = z.object({ a: z.number() });
const outputJsonSchema = JSON.stringify(z.toJSONSchema(outputSchema));

describe("claudeRunArgs", () => {
  const head = ["-p", "hi", "--output-format", "json"];
  const schemaArgs = ["--json-schema", outputJsonSchema];
  const resume = ["--resume", "s1"];
  const fork = [...resume, "--fork-session"];

  test.each([
    ["no session behaves like a new one", undefined, false, []],
    ["a new session", { mode: "new" }, false, []],
    ["a new session with a schema", { mode: "new" }, true, schemaArgs],
    ["a resumed session", { mode: "resume", id: "s1" }, false, resume],
    [
      "a resumed session with a schema",
      { mode: "resume", id: "s1" },
      true,
      [...resume, ...schemaArgs],
    ],
    ["a forked session", { mode: "fork", id: "s1" }, false, fork],
    ["a forked session with a schema", { mode: "fork", id: "s1" }, true, [...fork, ...schemaArgs]],
  ] as const)("SC25: %s", (_name, session, withSchema, tail) => {
    const request = {
      prompt: "hi",
      cwd: "/repo",
      ...(session === undefined ? {} : { session }),
      ...(withSchema ? { outputFormat: outputSchema } : {}),
    };
    expect(claudeRunArgs(request)).toEqual([...head, ...tail]);
  });
});

describe("interpretOutput", () => {
  const out = (fields: Record<string, unknown>): string => JSON.stringify(fields);
  const plain = out({ result: "x", session_id: "s", is_error: false });

  test.each([
    ["stdout that is not JSON", "oops", undefined, "invalid JSON output"],
    [
      "output with no session_id",
      out({ result: "hi", is_error: false }),
      undefined,
      "missing session_id",
    ],
    ["a result that is not JSON under a schema", plain, outputSchema, "not valid JSON"],
  ] as const)("%s is ok:false", (_name, stdout, schema, message) => {
    const result = interpretOutput({ code: 0, stdout, stderr: "" }, schema);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : String(result.error)).toContain(message);
  });

  test("a plain result with no schema is returned as text", () => {
    expect(
      interpretOutput({
        code: 0,
        stdout: out({ result: "hi", session_id: "s", is_error: false }),
        stderr: "",
      }),
    ).toEqual({
      ok: true,
      output: "hi",
      sessionId: "s",
    });
  });

  test("long non-JSON stdout is capped, never logging what follows the first 200 chars", () => {
    const stdout = `${"x".repeat(5000)}SECRET_TAIL`;
    const result = interpretOutput({ code: 0, stdout, stderr: "" });

    expect(result.ok).toBe(false);
    const message = result.ok ? "" : String(result.error);
    expect(message).not.toContain("SECRET_TAIL");
    expect(message).toContain(`${stdout.length}`);
  });

  test("a non-zero exit with long stderr is capped, never logging what follows the first 200 chars", () => {
    const stderr = `${"x".repeat(5000)}SECRET_TAIL`;
    const result = interpretOutput({ code: 1, stdout: "oops", stderr });

    expect(result.ok).toBe(false);
    const message = result.ok ? "" : String(result.error);
    expect(message).not.toContain("SECRET_TAIL");
    expect(message).toContain(`${stderr.length}`);
  });
});

// Writes a temporary executable that prints fixed stdout and exits with a fixed code,
// standing in for the real claude binary.
const fakeClaudeBinary = (options: { stdout: string; exitCode?: number }): string => {
  const path = join(mkdtempSync(join(tmpdir(), "fake-claude-")), "claude");
  writeFileSync(
    path,
    `#!/usr/bin/env bun\nprocess.stdout.write(${JSON.stringify(options.stdout)});\nprocess.exit(${options.exitCode ?? 0});\n`,
  );
  chmodSync(path, 0o755);
  return path;
};

describe("claudeProvider.run", () => {
  test("SC26: a well-formed result parses against the given schema", async () => {
    const binary = fakeClaudeBinary({
      stdout: JSON.stringify({
        result: JSON.stringify({ a: 1 }),
        session_id: "s",
        is_error: false,
      }),
    });
    const provider = claudeProvider({ host: fakeHost(), binary });

    const result = await provider.run({
      prompt: "hi",
      cwd: process.cwd(),
      outputFormat: outputSchema,
    });

    expect(result).toEqual({ ok: true, output: { a: 1 }, sessionId: "s" });
  });

  test("SC27: is_error: true fails, carrying the session id it reported", async () => {
    const binary = fakeClaudeBinary({
      stdout: JSON.stringify({ result: "boom", session_id: "s", is_error: true }),
    });
    const provider = claudeProvider({ host: fakeHost(), binary });

    const result = await provider.run({ prompt: "hi", cwd: process.cwd() });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.sessionId).toBe("s");
  });

  test("SC27: a non-zero exit fails even with an otherwise well-formed body", async () => {
    const binary = fakeClaudeBinary({
      stdout: JSON.stringify({ result: "ok", session_id: "s2", is_error: false }),
      exitCode: 2,
    });
    const provider = claudeProvider({ host: fakeHost(), binary });

    const result = await provider.run({ prompt: "hi", cwd: process.cwd() });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.sessionId).toBe("s2");
  });

  test("SC27: a result failing the schema fails, carrying the session id it reported", async () => {
    const binary = fakeClaudeBinary({
      stdout: JSON.stringify({
        result: JSON.stringify({ a: "nope" }),
        session_id: "s3",
        is_error: false,
      }),
    });
    const provider = claudeProvider({ host: fakeHost(), binary });

    const result = await provider.run({
      prompt: "hi",
      cwd: process.cwd(),
      outputFormat: outputSchema,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.sessionId).toBe("s3");
  });
});

describe("isClaudeBusy", () => {
  test.each([
    ["· Vibing… (3s · ↓ 136 tokens)", true],
    ["✢ Compacting conversation… (15s · ↓ 637 tokens)", true],
    ["  Press up to edit queued messages\n❯ ", true],
    ["✻ Churned for 8s · done 4:40 PM\n❯ ", false],
    ["❯ ", false],
  ])("SC22: %j is busy: %p", (screen, busy) => {
    expect(isClaudeBusy(screen)).toBe(busy);
  });
});

const RULE = "─".repeat(40);
// Claude 2.1.286's empty input box, with its status line below.
const PROMPT = `${RULE}\n❯\n${RULE}\n  Model: Opus | Ctx Used: 8.0%`;
const LIMIT_MENU = [
  "What do you want to do?",
  "❯ 1. Upgrade your plan",
  "  2. Stop and wait for limit to reset",
  "Enter to confirm · Esc to cancel",
].join("\n");

describe("claudeProvider.limitResetWait", () => {
  test("reads the reset from the error message, else from the limit banner on the pane's screen", async () => {
    const now = new Date("2026-10-01T13:00:00Z");
    const provider = claudeProvider({ host: fakeHost() });
    const pane = fakePane("p", [], true, [`● You've hit your limit · resets 4pm (UTC)\n${PROMPT}`]);
    const hour = 3_600_000;
    expect(await provider.limitResetWait(pane, "resets 3pm (UTC)", now)).toEqual({
      ms: 2 * hour + 60_000,
      from: "message",
    });
    expect(await provider.limitResetWait(pane, "Usage limit reached", now)).toEqual({
      ms: 3 * hour + 60_000,
      from: "screen",
    });
  });
});

describe("claudeProvider.promptWhenReady", () => {
  const typedInto = async (...screens: readonly string[]) => {
    const calls: Call[] = [];
    const provider = claudeProvider({ host: fakeHost() });
    const result = await provider.promptWhenReady(fakePane("p", calls, true, screens), "continue");
    const typed = calls.map((c) =>
      c.method === "sendText" ? c.text : c.method === "sendKeys" ? c.keys : c.method,
    );
    return { result, typed };
  };
  const SENT = [["C-u"], "continue", ["Enter"]];

  test.each([
    ["an empty input box", [`● Done.\n${PROMPT}`]],
    [
      "a numbered list in Claude's reply above the input box",
      [`1. Fixed the bug\n2. Added a test\n${PROMPT}`],
    ],
  ])("%s: the input is cleared and the text submitted", async (_, screens) => {
    expect(await typedInto(...screens)).toEqual({
      result: { ok: true, value: "sent" },
      typed: SENT,
    });
  });

  test("an open limit menu is answered with Stop and wait before the text is typed", async () => {
    expect(await typedInto(LIMIT_MENU, PROMPT)).toEqual({
      result: { ok: true, value: "sent" },
      typed: [["Down", "Enter"], ...SENT],
    });
  });

  test.each([
    ["a draft in the input box", `${RULE}\n❯ half a message\n${RULE}`],
    ["a permission dialog", "Do you want to run this command?\n❯ 1. Yes\n  2. No"],
    [
      "an unnumbered dialog",
      "Monthly spend limit reached\n❯ Adjust monthly spend limit: $20.00\n  Wait for limit to reset",
    ],
    [
      "a dialog showing only its footer",
      "Do you want to proceed?\nEnter to confirm · Esc to cancel",
    ],
    ["Claude at work above its input box", `· Vibing… (3s)\n${PROMPT}`],
    ["a bare ❯ outside the input box", "● Done.\n❯\n  ? for shortcuts"],
    [
      "a live limit menu without Stop and wait",
      "What do you want to do?\n❯ 1. Upgrade your plan\n  2. Ask your admin",
    ],
  ])("%s: nothing is typed and the answer is not-ready", async (_, screen) => {
    expect(await typedInto(screen)).toEqual({
      result: { ok: true, value: "not-ready" },
      typed: [],
    });
  });
});
