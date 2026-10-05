import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SDK_TYPES from "./sdk-types.json";
import { writeProjectTypes } from "./types.ts";

const REPO = join(import.meta.dir, "..", "..", "..");
const TSC = join(REPO, "node_modules", ".bin", "tsc");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "yok-types-"));
  roots.push(root);
  return root;
};

const typesDir = (root: string): string => join(root, ".yok", "types");
const readType = (root: string, name: string): string =>
  readFileSync(join(typesDir(root), name), "utf8");

const seed = (root: string, files: Readonly<Record<string, string>>): void => {
  mkdirSync(typesDir(root), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(typesDir(root), name), text);
};

describe("writeProjectTypes", () => {
  test("SC100: a project with no .yok/types gets every SDK type file and VERSION 0.0.2", async () => {
    const root = makeRoot();

    expect(await writeProjectTypes(root, "0.0.2")).toBe(true);

    expect(readdirSync(typesDir(root)).sort()).toEqual(
      [...Object.keys(SDK_TYPES.files), "VERSION"].sort(),
    );
    for (const [name, text] of Object.entries(SDK_TYPES.files)) {
      expect([name, readType(root, name)]).toEqual([name, text]);
    }
    expect(readType(root, "VERSION").trim()).toBe("0.0.2");
  });

  test("SC101: types from yok 0.0.1 are replaced by 0.0.2's, and a stray old.d.ts is removed", async () => {
    const root = makeRoot();
    seed(root, { VERSION: "0.0.1\n", "old.d.ts": "export {};" });

    expect(await writeProjectTypes(root, "0.0.2")).toBe(true);

    expect(existsSync(join(typesDir(root), "old.d.ts"))).toBe(false);
    expect(readType(root, "VERSION").trim()).toBe("0.0.2");
  });

  test("SC102: types from yok 0.0.3 stay untouched when 0.0.3 or the older 0.0.2 writes", async () => {
    const root = makeRoot();
    seed(root, { VERSION: "0.0.3\n", "index.d.ts": "keep" });

    expect(await writeProjectTypes(root, "0.0.3")).toBe(false);
    expect(await writeProjectTypes(root, "0.0.2")).toBe(false);

    expect(readType(root, "index.d.ts")).toBe("keep");
    expect(readType(root, "VERSION").trim()).toBe("0.0.3");
  });
});

// No skipLibCheck and no ambient types: the written .d.ts files must stand on zod alone.
const PROJECT_TSCONFIG = {
  compilerOptions: {
    strict: true,
    target: "ESNext",
    module: "Preserve",
    moduleResolution: "bundler",
    noEmit: true,
    types: [],
    paths: { "@yok/sdk": ["./.yok/types/index.d.ts"] },
  },
  include: ["*.ts"],
};

const GOOD_EXTENSION = [
  'import { NonEmptyStringSchema } from "@yok/sdk";',
  'import { z } from "zod";',
  'export const name: string = NonEmptyStringSchema.parse("x");',
  "export const Schema = z.object({ name: NonEmptyStringSchema });",
  "",
].join("\n");

const makeProject = async (): Promise<string> => {
  const project = makeRoot();
  mkdirSync(join(project, "node_modules"));
  symlinkSync(
    realpathSync(join(REPO, "node_modules", "zod")),
    join(project, "node_modules", "zod"),
  );
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify(PROJECT_TSCONFIG));
  writeFileSync(join(project, "good.ts"), GOOD_EXTENSION);
  await writeProjectTypes(project, "0.0.1");
  return project;
};

const tsc = (project: string): { code: number | null; output: string } => {
  const run = spawnSync(TSC, ["--noEmit", "-p", project], { encoding: "utf8" });
  return { code: run.status, output: `${run.stdout}${run.stderr}` };
};

describe("an extension in a project", () => {
  test("SC104: typechecks against the written types with only zod installed, and an ./internal-only import fails", async () => {
    const project = await makeProject();

    expect(tsc(project)).toEqual({ code: 0, output: "" });

    writeFileSync(
      join(project, "bad.ts"),
      'import { appendRunEvent } from "@yok/sdk";\nexport { appendRunEvent };\n',
    );
    const bad = tsc(project);
    expect(bad.code).not.toBe(0);
    expect(bad.output).toContain("has no exported member 'appendRunEvent'");
  });
});
