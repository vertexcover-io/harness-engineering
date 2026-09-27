import { describe, expect, test } from "bun:test";
import { captureLogger } from "@harness/core";
import type { ILogger } from "./logger.ts";
import { noopLogger } from "./logger.ts";

describe("ILogger", () => {
  test("SC39: a pino logger built by createLogger satisfies ILogger; child bindings and fields both reach the line", () => {
    const { log, lines } = captureLogger();
    const typed: ILogger = log;

    typed.child({ component: "x" }).info({ a: 1 }, "hi");

    expect(lines).toEqual([expect.objectContaining({ component: "x", a: 1, msg: "hi" })]);
  });

  test("noopLogger never throws and its child returns another noopLogger", () => {
    expect(() => {
      noopLogger.info({}, "ignored");
      noopLogger.child({ component: "x" }).error({}, "ignored");
    }).not.toThrow();
  });
});
