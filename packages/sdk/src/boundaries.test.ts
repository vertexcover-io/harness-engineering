import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";

const filesContaining = (
  pattern: string,
  needle: string,
  options?: { excludeTests?: boolean },
): string[] => {
  const matches: string[] = [];
  for (const file of new Glob(pattern).scanSync(".")) {
    if (options?.excludeTests === true && file.endsWith(".test.ts")) continue;
    if (readFileSync(file, "utf8").includes(needle)) matches.push(file);
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
});
