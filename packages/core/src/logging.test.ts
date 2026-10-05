import { describe, expect, test } from "bun:test";
import type { ILogger } from "@yok/sdk";
import { captureLogger, createLogger, resolveLevel } from "./logging.ts";

describe("resolveLevel", () => {
  test.each([
    ["LOG_LEVEL wins over any fallback", { LOG_LEVEL: "info" }, undefined, "info"],
    ["NODE_ENV=production falls back to info", { NODE_ENV: "production" }, undefined, "info"],
    ["NODE_ENV=test falls back to silent", { NODE_ENV: "test" }, undefined, "silent"],
    ["an explicit fallback wins when LOG_LEVEL is unset", {}, "warn", "warn"],
  ] as const)("SC34: %s", (_name, env, fallback, expected) => {
    expect(resolveLevel(env, fallback)).toBe(expected);
  });

  test("SC34: an invalid LOG_LEVEL warns once and uses the fallback", () => {
    const warnings: unknown[][] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      expect(resolveLevel({ LOG_LEVEL: "loud" })).toBe("debug");
    } finally {
      console.warn = original;
    }
    expect(warnings).toHaveLength(1);
  });
});

describe("createLogger", () => {
  test("SC35: redacts token and password, and stamps service, pid and hostname", () => {
    const lines: string[] = [];
    const log = createLogger(
      { service: "t" },
      { level: "debug", destination: { write: (line) => lines.push(line) } },
    );
    log.info({ token: "t", password: "p" }, "hi");

    const line = JSON.parse(lines[0] ?? "{}");
    expect(line).toMatchObject({ service: "t", token: "[Redacted]", password: "[Redacted]" });
    expect(line.pid).toBeNumber();
    expect(line.hostname).toBeString();
  });
});

describe("ILogger", () => {
  test("SC39: a pino logger built by createLogger satisfies ILogger; child bindings and fields both reach the line", () => {
    const { log, lines } = captureLogger();
    const typed: ILogger = log;

    typed.child({ component: "x" }).info({ a: 1 }, "hi");

    expect(lines).toEqual([expect.objectContaining({ component: "x", a: 1, msg: "hi" })]);
  });
});
