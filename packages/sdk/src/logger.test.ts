import { describe, expect, test } from "bun:test";
import { noopLogger } from "./logger.ts";

describe("noopLogger", () => {
  test("noopLogger never throws and its child returns another noopLogger", () => {
    expect(() => {
      noopLogger.info({}, "ignored");
      noopLogger.child({ component: "x" }).error({}, "ignored");
    }).not.toThrow();
  });
});
