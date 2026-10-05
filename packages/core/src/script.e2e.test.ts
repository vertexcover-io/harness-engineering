import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  options: Readonly<{ cwd: string; skills?: string; command?: readonly string[] }>,
): Ran => {
  const { YOK_RUN_ID: _runId, ...env } = process.env;
  const command = options.command ?? ["script"];
  const run = spawnSync("bun", ["--no-env-file", CLI, "orchestrate", ...command, ...args], {
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

  test("SC56: a missing file exits 1 naming the path it looked for", () => {
    const cwd = tempDir();
    const plain = script(["missing.ts"], { cwd });
    expect(plain.code).toBe(1);
    expect(plain.stderr).toContain(join(cwd, "missing.ts"));
  });
});

const DEMO_SKILL = `---
name: demo
description: A skill with a script reference and a text one.
mode: inline
allowed-tools: [Bash]
tier: fast
protocols: []
scopes: []
references:
  tool:
    path: scripts/tool.ts
    description: The script the skill runs.
  notes:
    path: notes.md
    description: Notes to read.
---
`;

// A git checkout whose config extends the demo skill's tool reference, and the skills folder.
const extendedTool = (tool?: unknown): Readonly<{ cwd: string; skills: string }> => {
  const extensions = tool === undefined ? {} : { demo: { references: { tool } } };
  const cwd = writeFiles(tempDir(), {
    "orchestrate.config.json": JSON.stringify({ version: 2, extensions }),
    "tools/mine.ts":
      'export const main = (argv) => { console.log("mine", argv.join(",")); return 3; };\n',
    "x.md": "more\n",
  });
  execFileSync("git", ["init", "-q"], { cwd });
  const skills = writeFiles(tempDir(), {
    "demo/SKILL.md": DEMO_SKILL,
    "demo/notes.md": "notes\n",
    "demo/scripts/tool.ts":
      'export const main = (argv) => { console.log("skill tool", argv.join(",")); };\n',
  });
  return { cwd, skills };
};

const skillRun = (args: readonly string[], options: Readonly<{ cwd: string; skills: string }>) =>
  script(args, { ...options, command: ["skill", "run"] });

describe("yok orchestrate skill run STAGE.REF", () => {
  test("a shipped script reference runs with its arguments, options included", () => {
    expect(skillRun(["demo.tool", "a", "--b"], extendedTool())).toMatchObject({
      code: 0,
      stdout: "skill tool a,--b\n",
    });
  });

  test("a replaced reference runs the project's file with the same arguments and exit code", () => {
    const options = extendedTool({ replace: "tools/mine.ts" });
    expect(skillRun(["demo.tool", "a", "--b"], options)).toMatchObject({
      code: 3,
      stdout: "mine a,--b\n",
    });
  });

  test('a command reference runs through sh with "a b" kept as one word', () => {
    const options = extendedTool({ command: "printf '%s|'" });
    expect(skillRun(["demo.tool", "a b", "--c"], options)).toMatchObject({
      code: 0,
      stdout: "a b|--c|",
    });
  });

  test.each([
    ["a text reference", undefined, "demo.notes"],
    ["an extended script, which reads as text", { extend: "x.md" }, "demo.tool"],
  ])("%s is refused, pointing at skill ref, and runs nothing", (_label, tool, target) => {
    const ran = skillRun([target], extendedTool(tool));
    expect(ran.code).toBe(1);
    expect(ran.stdout).toBe("");
    expect(ran.stderr).toContain(`${target} is text; read it with skill ref`);
  });

  test("an unknown skill exits 1 listing every place tried", () => {
    const options = extendedTool();
    const ran = skillRun(["nope.tool"], options);
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain(join(options.skills, "nope"));
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

describe("--help after a skill's script", () => {
  test("SC47: reaches the script's own usage, and yok orchestrate script --help is the command's own", () => {
    const cwd = tempDir();
    const skills = join(REPO_ROOT, "skills");
    for (const [target, file] of [
      ["create-workspace.workspace", "workspace.ts"],
      ["baseline.script", "baseline.ts"],
    ] as const) {
      const ran = skillRun([target, "--help"], { cwd, skills });
      expect(ran.code).toBe(0);
      expect(ran.stdout.startsWith(`usage: ${file}`)).toBe(true);
    }
    const own = script(["--help"], { cwd, skills });
    expect(own.code).toBe(0);
    expect(own.stdout).toContain("Run a script file");
  });
});
