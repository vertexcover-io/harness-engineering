import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "packages", "cli", "src", "index.ts");

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "yok-script-")));

const writeFiles = (dir: string, files: Readonly<Record<string, string>>): string => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

type Ran = Readonly<{ code: number | null; stdout: string; stderr: string }>;

const script = (
  args: readonly string[],
  options: Readonly<{ cwd: string; skills?: string }>,
): Ran => {
  const { YOK_RUN_ID: _runId, ...env } = process.env;
  const run = spawnSync("bun", ["--no-env-file", CLI, "orchestrate", "script", ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...env, YOK_HOME: tempDir(), YOK_SKILLS_DIR: options.skills ?? tempDir() },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

describe("yok orchestrate script FILE", () => {
  test("SC53: tools/hello.ts a b prints a,b by relative path and by absolute path", () => {
    const dir = writeFiles(tempDir(), {
      "tools/hello.ts": 'export const main = (argv) => { console.log(argv.join(",")); };\n',
    });
    for (const file of ["tools/hello.ts", join(dir, "tools/hello.ts")]) {
      const ran = script([file, "a", "b"], { cwd: dir });
      expect(ran).toMatchObject({ code: 0, stdout: "a,b\n" });
    }
  });

  test("SC54: a file without main runs its top-level code and sees x --y as its arguments", () => {
    const dir = writeFiles(tempDir(), {
      "tools/plain.ts": "console.log(JSON.stringify(process.argv.slice(2)));\n",
    });
    expect(script(["tools/plain.ts", "x", "--y"], { cwd: dir })).toMatchObject({
      code: 0,
      stdout: '["x","--y"]\n',
    });
  });

  test("SC55: main returning 4 exits 4, setting process.exitCode = 1 exits 1, and a throw exits 1 with its stack", () => {
    const dir = writeFiles(tempDir(), {
      "four.ts": "export const main = () => 4;\n",
      "flag.ts": "export const main = () => { process.exitCode = 1; };\n",
      "boom.ts": 'export const main = () => { throw new Error("boom"); };\n',
    });
    expect(script(["four.ts"], { cwd: dir }).code).toBe(4);
    expect(script(["flag.ts"], { cwd: dir }).code).toBe(1);
    const boom = script(["boom.ts"], { cwd: dir });
    expect(boom.code).toBe(1);
    expect(boom.stderr).toContain("boom");
    expect(boom.stderr).toMatch(/at .*boom\.ts/);
  });

  test("SC56: a missing file exits 1 naming the path it looked for, and an unknown skill lists every place tried", () => {
    const cwd = tempDir();
    const skills = writeFiles(tempDir(), { "ticket-fetcher/SKILL.md": "# ticket\n" });
    const inSkill = script(["--skill", "ticket-fetcher", "scripts/nope.ts"], { cwd, skills });
    expect(inSkill.code).toBe(1);
    expect(inSkill.stderr).toContain(join(skills, "ticket-fetcher", "scripts", "nope.ts"));
    const plain = script(["missing.ts"], { cwd });
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain(join(cwd, "missing.ts"));
    const noSkill = script(["--skill", "nope", "x.ts"], { cwd, skills });
    expect(noSkill.code).toBe(1);
    expect(noSkill.stderr).toContain(join(skills, "nope"));
  });

  test("SC59: --skill demo refuses ../other/x.ts and a symlink to it, never running it, and runs scripts/ok.ts", () => {
    const cwd = tempDir();
    const marker = join(tempDir(), "ran");
    const skills = writeFiles(tempDir(), {
      "demo/scripts/ok.ts": 'console.log("ok");\n',
      "other/x.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n`,
    });
    symlinkSync(join(skills, "other", "x.ts"), join(skills, "demo", "scripts", "link.ts"));
    for (const file of ["../other/x.ts", "scripts/link.ts"]) {
      const ran = script(["--skill", "demo", file], { cwd, skills });
      expect(ran.code).toBe(1);
      expect(ran.stderr).toContain("outside the skill folder");
    }
    expect(existsSync(marker)).toBe(false);
    expect(script(["--skill", "demo", "scripts/ok.ts"], { cwd, skills })).toMatchObject({
      code: 0,
      stdout: "ok\n",
    });
  });
});

const DEMO_SKILL = `---
name: demo
description: A skill with one script reference.
mode: inline
allowed-tools: [Bash]
tier: fast
protocols: []
scopes: []
references:
  tool:
    path: scripts/tool.ts
    description: The script the skill runs.
---
`;

// A git checkout whose config extends the demo skill's tool reference, and the skills folder.
const extendedTool = (tool: unknown): Readonly<{ cwd: string; skills: string }> => {
  const cwd = writeFiles(tempDir(), {
    "orchestrate.config.json": JSON.stringify({
      version: 2,
      extensions: { demo: { references: { tool } } },
    }),
    "tools/mine.ts":
      'export const main = (argv) => { console.log("mine", argv.join(",")); return 3; };\n',
  });
  execFileSync("git", ["init", "-q"], { cwd });
  const skills = writeFiles(tempDir(), {
    "demo/SKILL.md": DEMO_SKILL,
    "demo/scripts/tool.ts": 'console.log("skill tool");\n',
    "demo/scripts/other.ts": 'console.log("other");\n',
  });
  return { cwd, skills };
};

describe("yok orchestrate script --skill with the project's extension", () => {
  test("a replaced reference runs the project's file with the same arguments and exit code, and a file that is no reference runs as it is", () => {
    const options = extendedTool({ replace: "tools/mine.ts" });
    expect(script(["--skill", "demo", "scripts/tool.ts", "a", "--b"], options)).toMatchObject({
      code: 3,
      stdout: "mine a,--b\n",
    });
    expect(script(["--skill", "demo", "scripts/other.ts"], options)).toMatchObject({
      code: 0,
      stdout: "other\n",
    });
  });

  test('a command reference runs through sh with "a b" kept as one word', () => {
    const options = extendedTool({ command: "printf '%s|'" });
    expect(script(["--skill", "demo", "scripts/tool.ts", "a b", "--c"], options)).toMatchObject({
      code: 0,
      stdout: "a b|--c|",
    });
  });

  test("an extended reference is refused, naming its key, and runs nothing", () => {
    const ran = script(["--skill", "demo", "scripts/tool.ts"], extendedTool({ extend: "x.md" }));
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toContain("extensions.demo.references.tool");
  });
});

describe("yok orchestrate script with the SDK", () => {
  const dir = join(REPO_ROOT, ".yok", "tmp", `sdk-user-${process.pid}`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("SC57: a script importing @yok/sdk and zod runs from a folder with no node_modules of its own", () => {
    writeFiles(dir, {
      "sdk-user.ts": `import { NonEmptyStringSchema } from "@yok/sdk";
import * as z from "zod";
export const main = () => {
  NonEmptyStringSchema.parse("x");
  z.object({ a: z.string() }).parse({ a: "b" });
  console.log("ok");
};
`,
    });
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    expect(script([join(dir, "sdk-user.ts")], { cwd: REPO_ROOT })).toMatchObject({
      code: 0,
      stdout: "ok\n",
    });
  });
});

describe("yok orchestrate script --help", () => {
  test("SC47: --help after a skill script reaches its own usage, and yok orchestrate script --help is the command's own", () => {
    const cwd = tempDir();
    const skills = join(REPO_ROOT, "skills");
    for (const [skill, file] of [
      ["create-workspace", "scripts/workspace.ts"],
      ["baseline", "scripts/baseline.ts"],
    ] as const) {
      const ran = script(["--skill", skill, file, "--help"], { cwd, skills });
      expect(ran.code).toBe(0);
      expect(ran.stdout.startsWith(`usage: yok orchestrate script --skill ${skill} ${file}`)).toBe(
        true,
      );
    }
    const own = script(["--help"], { cwd, skills });
    expect(own.code).toBe(0);
    expect(own.stdout).toContain("--skill");
  });
});
