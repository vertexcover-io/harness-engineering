import { describe, expect, test } from "bun:test";
import { jsonLogger, type LogLevel, noopLogger } from "./logger.ts";

describe("noopLogger", () => {
  test("noopLogger never throws and its child returns another noopLogger", () => {
    expect(() => {
      noopLogger.info({}, "ignored");
      noopLogger.child({ component: "x" }).error({}, "ignored");
    }).not.toThrow();
  });
});

describe("jsonLogger", () => {
  const captured = (level: LogLevel) => {
    const lines: Record<string, unknown>[] = [];
    const log = jsonLogger({ level, write: (line) => lines.push(JSON.parse(line)) });
    return { log, lines };
  };

  test("writes one JSON line per call at or above its level, with child bindings", () => {
    const { log, lines } = captured("warn");

    log.child({ component: "workspace" }).info({ repo: "a" }, "ignored");
    log.child({ component: "workspace" }).error({ repo: "a" }, "setup failed");

    expect(lines).toEqual([
      expect.objectContaining({
        level: "error",
        component: "workspace",
        repo: "a",
        msg: "setup failed",
      }),
    ]);
  });

  test("an Error in the fields keeps its message, stack and cause", () => {
    const { log, lines } = captured("error");
    const cause = new Error("disk full");

    log.error(
      { err: new Error("setup failed", { cause }) },
      "worktree added, but its setup failed",
    );

    expect(lines[0]?.err).toEqual({
      message: "setup failed",
      stack: expect.stringContaining("setup failed"),
      cause: { message: "disk full", stack: expect.stringContaining("disk full") },
    });
  });
});
