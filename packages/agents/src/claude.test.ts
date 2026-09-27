import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLogger } from "@harness/core";
import type { ITerminal, Result, TerminalSpec } from "@harness/sdk";
import * as z from "zod";
import { claudeArgs, claudeProvider, claudeRunArgs, interpretOutput } from "./claude.ts";

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
});

type Call =
  | { readonly method: "create"; readonly spec: TerminalSpec; readonly at: number }
  | {
      readonly method: "sendText";
      readonly name: string;
      readonly text: string;
      readonly at: number;
    }
  | {
      readonly method: "sendKeys";
      readonly name: string;
      readonly keys: readonly string[];
      readonly at: number;
    }
  | { readonly method: "kill"; readonly name: string; readonly at: number };

const fakeTerminal = (
  options: { alive?: boolean; createOk?: boolean } = {},
): ITerminal & {
  calls: Call[];
} => {
  const calls: Call[] = [];
  const ok: Result<void> = { ok: true, value: undefined };
  return {
    calls,
    checks: [],
    create: (spec) => {
      calls.push({ method: "create", spec, at: Date.now() });
      return Promise.resolve(options.createOk === false ? { ok: false, error: "boom" } : ok);
    },
    sendText: (name, text) => {
      calls.push({ method: "sendText", name, text, at: Date.now() });
      return Promise.resolve(ok);
    },
    sendKeys: (name, keys) => {
      calls.push({ method: "sendKeys", name, keys, at: Date.now() });
      return Promise.resolve(ok);
    },
    kill: (name) => {
      calls.push({ method: "kill", name, at: Date.now() });
      return Promise.resolve(ok);
    },
    capture: () => Promise.resolve({ ok: true, value: "" }),
    isAlive: () => Promise.resolve(options.alive ?? true),
    list: () => Promise.resolve([]),
    attachCommand: (name) => ["tmux", "attach-session", "-t", name],
  };
};

describe("claudeProvider.prompt", () => {
  test("SC6: a session whose isAlive is false returns ok:false and sends nothing", async () => {
    const terminal = fakeTerminal({ alive: false });
    const provider = claudeProvider({ terminal, newId: () => "s1" });

    const result = await provider.prompt("s1", "hello");

    expect(result).toEqual({ ok: false, error: "session s1 is not running" });
    expect(terminal.calls).toHaveLength(0);
  });

  test("SC7: a live session sends the text, then Enter at least 150ms later", async () => {
    const terminal = fakeTerminal({ alive: true });
    const provider = claudeProvider({ terminal, newId: () => "s1" });

    const result = await provider.prompt("s1", "hello");

    expect(result).toEqual({ ok: true, value: undefined });
    expect(terminal.calls.map((c) => c.method)).toEqual(["sendText", "sendKeys"]);
    const [sendText, sendKeys] = terminal.calls;
    expect(sendText?.method).toBe("sendText");
    expect(sendKeys).toMatchObject({ method: "sendKeys", keys: ["Enter"] });
    expect((sendKeys?.at ?? 0) - (sendText?.at ?? 0)).toBeGreaterThanOrEqual(149);
  });
});

describe("claudeProvider.launch", () => {
  test("a terminal that fails to create the session returns ok:false", async () => {
    const provider = claudeProvider({
      terminal: fakeTerminal({ createOk: false }),
      newId: () => "s1",
    });

    expect(await provider.launch({ cwd: "/repo" })).toEqual({ ok: false, error: "boom" });
  });
});

describe("claudeProvider.launch logging", () => {
  test("SC37: no log line contains the prompt or system-prompt text", async () => {
    const { log, lines } = captureLogger();
    const terminal = fakeTerminal();
    const provider = claudeProvider({ terminal, log, newId: () => "s1" });

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
    const provider = claudeProvider({ terminal: fakeTerminal(), binary });

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
    const provider = claudeProvider({ terminal: fakeTerminal(), binary });

    const result = await provider.run({ prompt: "hi", cwd: process.cwd() });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.sessionId).toBe("s");
  });

  test("SC27: a non-zero exit fails even with an otherwise well-formed body", async () => {
    const binary = fakeClaudeBinary({
      stdout: JSON.stringify({ result: "ok", session_id: "s2", is_error: false }),
      exitCode: 2,
    });
    const provider = claudeProvider({ terminal: fakeTerminal(), binary });

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
    const provider = claudeProvider({ terminal: fakeTerminal(), binary });

    const result = await provider.run({
      prompt: "hi",
      cwd: process.cwd(),
      outputFormat: outputSchema,
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.sessionId).toBe("s3");
  });
});
