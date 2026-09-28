import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const filesContaining = (
  pattern: string,
  needle: string | RegExp,
  options?: { excludeTests?: boolean },
): string[] => {
  const matches: string[] = [];
  for (const file of new Glob(pattern).scanSync(".")) {
    if (options?.excludeTests === true && file.includes(".test.")) continue;
    const text = readFileSync(file, "utf8");
    if (typeof needle === "string" ? text.includes(needle) : needle.test(text)) matches.push(file);
  }
  return matches.sort();
};

describe("source boundaries", () => {
  test('SC33: only packages/sdk/src/git.ts calls exec("git"', () => {
    expect(filesContaining("packages/*/src/**/*.ts", 'exec("git"', { excludeTests: true })).toEqual(
      ["packages/sdk/src/git.ts"],
    );
  });

  test("SC40: sdk and agents src never import pino directly", () => {
    // excludeTests: true, so this assertion's own needle text can't match itself.
    expect(
      filesContaining("packages/sdk/src/**/*.ts", 'from "pino', { excludeTests: true }),
    ).toEqual([]);
    expect(
      filesContaining("packages/agents/src/**/*.ts", 'from "pino', { excludeTests: true }),
    ).toEqual([]);
  });

  test("sdk never imports core, so it installs as a library on its own", () => {
    // Built from parts so this file's own needle text can't match itself.
    const coreImport = `from "${["@harness", "core"].join("/")}"`;
    expect(filesContaining("packages/sdk/**/*.ts", coreImport)).toEqual([]);
  });

  // A write can name the file through a variable or helper, so the check is on the path itself:
  // only state.ts may build a path to state.json at all.
  test("EH11 — only packages/sdk/src/state.ts builds a path to state.json, so every write goes through its lock", () => {
    const statePath = /[/"'`]state\.json["'`]/;
    const sources = ["packages/*/src/**/*.ts", "skills/**/*.{ts,mts,js,mjs}"].flatMap((pattern) =>
      filesContaining(pattern, statePath, { excludeTests: true }),
    );
    expect(sources).toEqual(["packages/sdk/src/state.ts"]);
  });

  test("EH12 — no skill script imports @harness/core; skills act on a run through the orchestrate script or the sdk", () => {
    expect(filesContaining("skills/**/*.{ts,mts,js,mjs}", /["']@harness\/core["'/]/)).toEqual([]);
  });
});
