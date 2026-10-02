import { describe, expect, test } from "bun:test";
import { shouldOpenBrowser } from "./client.ts";

const base = { noOpen: false, isTTY: true, env: {}, platform: "darwin" as NodeJS.Platform };

describe("shouldOpenBrowser", () => {
  test("SC5: opens only for a person at a terminal, outside CI, with a display on Linux", () => {
    const cases: readonly (readonly [string, Parameters<typeof shouldOpenBrowser>[0], boolean])[] =
      [
        ["plain terminal", base, true],
        ["--no-open", { ...base, noOpen: true }, false],
        ["no TTY", { ...base, isTTY: false }, false],
        ["CI unset", { ...base, env: {} }, true],
        ["CI empty", { ...base, env: { CI: "" } }, true],
        ["CI false", { ...base, env: { CI: "false" } }, true],
        ["CI true", { ...base, env: { CI: "true" } }, false],
        ["darwin without DISPLAY", { ...base, platform: "darwin" }, true],
        ["linux without display", { ...base, platform: "linux" }, false],
        ["linux with DISPLAY", { ...base, platform: "linux", env: { DISPLAY: ":0" } }, true],
        [
          "linux with WAYLAND_DISPLAY",
          { ...base, platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" } },
          true,
        ],
      ];
    for (const [label, input, expected] of cases) {
      expect([label, shouldOpenBrowser(input)]).toEqual([label, expected]);
    }
  });
});
