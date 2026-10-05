import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { type ConfigInput, ConfigSchema } from "@yok/sdk";
import { devPluginDir, VERSION } from "@yok/sdk/internal";
import { claudeSettings } from "./agents/claude-hooks.ts";
import {
  findPluginSkills,
  findReference,
  findSkill,
  findWorkflowPath,
  loadSkill,
  orchestrateArgv,
  type SkillScope,
  StageSchema,
  yokSkillsDir,
} from "./stage.ts";
import { compileWorkflow } from "./workflow/compile.ts";

const validStage = {
  name: "planning",
  description: "Turn a selected task into an implementation plan.",
  mode: "subagent",
  tags: ["planning", "design"],
  "allowed-tools": ["Read", "Write"],
  tier: "balanced",
  inputs: { description: "Task context.", schema: "planning.input.v1" },
  outputs: { description: "Planning result.", schema: "planning.output.v1", module: "schemas.ts" },
  consumes: [{ artifact: "design", optional: true }],
  produces: [{ artifact: "plan" }],
  protocols: ["artifact-registration"],
  scopes: ["feature"],
};

describe("orchestrateArgv", () => {
  test("SC21: is YOK_SELF's argv plus orchestrate, and a Claude stop hook built from it shell-quotes each part", () => {
    const saved = process.env.YOK_SELF;
    process.env.YOK_SELF = JSON.stringify(["/b", "--no-env-file", "/c/index.ts"]);
    try {
      const argv = orchestrateArgv();
      const stop = claudeSettings(argv).hooks.Stop.flatMap((group) => group.hooks);
      expect(argv).toEqual(["/b", "--no-env-file", "/c/index.ts", "orchestrate"]);
      expect(stop.map((hook) => hook.command)).toContain(
        "'/b' '--no-env-file' '/c/index.ts' 'orchestrate' 'hook' 'stop' '--agent' 'claude' '--handler' 'continue-workflow'",
      );
    } finally {
      process.env.YOK_SELF = saved;
    }
  });
});

describe("the skills folder", () => {
  const pluginSkills = async (root: string, version: string): Promise<string> => {
    const dir = join(root, "plugins", "cache", "yok", "yok", version, "skills");
    await mkdir(dir, { recursive: true });
    return dir;
  };
  const emptyDir = (): Promise<string> => mkdtemp(join(tmpdir(), "skills-home-"));

  test("SC80: a compiled binary finds the stages in Claude's plugin folder for its own version", async () => {
    const claude = await emptyDir();
    const skills = await pluginSkills(claude, "0.0.1");
    const env = { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: await emptyDir() };

    expect(findPluginSkills(env, "0.0.1")).toEqual({ ok: true, value: skills });
  });

  test("SC81: with only Codex's plugin installed, its folder is used", async () => {
    const codex = await emptyDir();
    const skills = await pluginSkills(codex, "0.0.1");
    const env = { CLAUDE_CONFIG_DIR: await emptyDir(), CODEX_HOME: codex };

    expect(findPluginSkills(env, "0.0.1")).toEqual({ ok: true, value: skills });
  });

  test("SC82: a plugin folder for another version is never used, and the error names the version and the fix", async () => {
    const claude = await emptyDir();
    await pluginSkills(claude, "0.0.2");
    const env = { CLAUDE_CONFIG_DIR: claude, CODEX_HOME: await emptyDir() };

    const result = findPluginSkills(env, "0.0.1", await emptyDir());

    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain("0.0.1");
    expect(result.error).toContain("yok plugin install --agent claude");
    expect(result.error).toContain("--agent codex");
  });

  test("SC83: from source, the repo's skills folder is used even when a plugin folder exists", async () => {
    const claude = await emptyDir();
    await pluginSkills(claude, VERSION);
    const repo = devPluginDir();
    if (repo === undefined) throw new Error("expected a source run");

    expect(yokSkillsDir({ CLAUDE_CONFIG_DIR: claude })).toBe(join(repo, "skills"));
    expect(existsSync(join(repo, "skills", "planning", "SKILL.md"))).toBe(true);
  });

  test("SC84: YOK_SKILLS_DIR wins over every other source", async () => {
    const claude = await emptyDir();
    await pluginSkills(claude, VERSION);

    expect(yokSkillsDir({ YOK_SKILLS_DIR: "/demo/skills", CLAUDE_CONFIG_DIR: claude })).toBe(
      "/demo/skills",
    );
  });
});

describe("StageSchema", () => {
  test("a full stage parses and produce entries default optional to false", () => {
    const stage = StageSchema.parse(validStage);
    expect(stage.produces).toEqual([{ artifact: "plan", optional: false }]);
  });

  test("inputs and outputs are optional", () => {
    const { inputs: _inputs, outputs: _outputs, ...bare } = validStage;
    expect(StageSchema.safeParse(bare).success).toBe(true);
  });

  test("variables default to none, and each declares a description and an optional string default", () => {
    expect(StageSchema.parse(validStage).variables).toEqual({});
    const variables = {
      provider: { description: "Ticket provider", default: "linear" },
      team: { description: "Team key" },
    };
    expect(StageSchema.parse({ ...validStage, variables }).variables).toEqual(variables);
  });

  test.each([
    ["an empty description", { provider: { description: "" } }],
    ["a non-string default", { provider: { description: "d", default: 3 } }],
    ["an unknown field", { provider: { description: "d", required: true } }],
    ["a key that is not a slug", { Provider: { description: "d" } }],
  ])("variables reject %s", (_label, variables) => {
    expect(StageSchema.safeParse({ ...validStage, variables }).success).toBe(false);
  });
});

const validFrontmatter = `name: planning
description: Turn a selected task into an implementation plan.
mode: subagent
tags: [planning, design]
allowed-tools: [Read, Write]
tier: balanced
inputs:
  description: Task context.
  schema: planning.input.v1
outputs:
  description: Planning result.
  schema: planning.output.v1
  module: schemas.ts
consumes:
  - artifact: design
    optional: true
produces:
  - artifact: plan
protocols: [artifact-registration]
scopes: [feature]
references:
  rubric:
    path: references/rubric.md
    description: How to grade a plan.
`;

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stage-"));
});

const writeFiles = async (base: string, files: Readonly<Record<string, string>>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(base, path)), { recursive: true });
    await writeFile(join(base, path), text);
  }
};

const writeSkill = async (
  folder: string,
  frontmatter: string,
  files: Readonly<Record<string, string>> = { "references/rubric.md": "Grade it.\n" },
): Promise<string> => {
  const skillDir = join(dir, folder);
  await writeFiles(skillDir, { "SKILL.md": `---\n${frontmatter}---\n# Body\n`, ...files });
  return skillDir;
};

const projectScope = (
  root: string,
  extensions: ConfigInput["extensions"] = {},
  run?: SkillScope["run"],
): SkillScope => ({
  root,
  config: { config: ConfigSchema.parse({ version: 2, extensions }), path: null, root },
  ...(run === undefined ? {} : { run }),
});

// A skill folder is a path with a "/", so an absolute one loads with no skills folder involved.
const loadAt = (skillDir: string) => loadSkill(skillDir, projectScope(dir));

describe("loadSkill", () => {
  test("WS26 — a skill folder whose SKILL.md names it loads with its frontmatter and references", async () => {
    const skillDir = await writeSkill("planning", validFrontmatter);
    const result = await loadAt(skillDir);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.name).toBe("planning");
    expect(result.value.dir).toBe(skillDir);
    expect(result.value.frontmatter.produces).toEqual([{ artifact: "plan", optional: false }]);
    expect(result.value.references).toEqual({
      rubric: {
        kind: "file",
        path: join(skillDir, "references/rubric.md"),
        description: "How to grade a plan.",
      },
    });
    expect(result.value.extensionDoc).toBeUndefined();
  });

  test("WS27 — a folder named planning holding name: plan is rejected, naming both", async () => {
    const frontmatter = validFrontmatter.replace("name: planning", "name: plan");
    const result = await loadAt(await writeSkill("planning", frontmatter));
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain('"plan"');
    expect(result.error).toContain("planning");
  });

  test("WS27 — a listed reference whose file is missing is rejected, naming the path", async () => {
    const result = await loadAt(await writeSkill("planning", validFrontmatter, {}));
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain("references/rubric.md");
  });

  test("a SKILL.md with no tier loads with no tier, so its stage runs on the node's or the run's", async () => {
    const frontmatter = validFrontmatter.replace("tier: balanced\n", "");
    const result = await loadAt(await writeSkill("planning", frontmatter));
    if (!result.ok) throw new Error(result.error);
    expect(result.value.frontmatter.tier).toBeUndefined();
  });

  test("WS28 — scopes: [] loads", async () => {
    const frontmatter = validFrontmatter.replace("scopes: [feature]", "scopes: []");
    expect((await loadAt(await writeSkill("planning", frontmatter))).ok).toBe(true);
  });

  test.each([
    [
      "WS28 — a run key",
      validFrontmatter.replace("mode:", "run:\n  skill: planning\nmode:"),
      /run/,
    ],
    ["an unknown field", validFrontmatter.replace("tier:", "extra: 1\ntier:"), /extra/],
    ["a bad mode", validFrontmatter.replace("mode: subagent", "mode: parallel"), /mode/],
    [
      "duplicate tags",
      validFrontmatter.replace("[planning, design]", "[design, design]"),
      /unique/,
    ],
    [
      "an artifact entry missing its name",
      validFrontmatter.replace("- artifact: plan", "- optional: true"),
      /produces/,
    ],
    [
      "a reference path leaving the skill folder",
      validFrontmatter.replace("path: references/rubric.md", "path: ../rubric.md"),
      /references/,
    ],
    [
      "a model, since a stage asks for a model only through its tier",
      validFrontmatter.replace("tier: balanced", "tier: balanced\nmodel: opus"),
      /model/,
    ],
    [
      "a tier that is not camelCase",
      validFrontmatter.replace("tier: balanced", "tier: deep-think"),
      /camelCase/,
    ],
    ["malformed YAML", "name: [unclosed\n", /YAML/i],
  ])("rejects %s", async (_label, frontmatter, message) => {
    const result = await loadAt(await writeSkill("planning", frontmatter));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  test("a folder with no SKILL.md returns an error naming the path instead of throwing", async () => {
    const skillDir = join(dir, "empty");
    await mkdir(skillDir);
    expect(await loadAt(skillDir)).toEqual({
      ok: false,
      error: expect.stringContaining(join(skillDir, "SKILL.md")),
    });
  });
});

const demoFrontmatter = validFrontmatter
  .replace("name: planning", "name: demo")
  .replace(
    /references:\n[\s\S]*$/,
    "references:\n  notes:\n    path: notes.md\n    description: Notes.\n",
  );

// The demo skill in a skills folder, and a project at root whose config extends it.
const setupDemo = async (extensions: ConfigInput["extensions"] = {}) => {
  const skillsDir = join(dir, "skills");
  const root = join(dir, "repo");
  await writeFiles(join(skillsDir, "demo"), {
    "SKILL.md": `---\n${demoFrontmatter}---\n`,
    "notes.md": "base text\n",
  });
  await writeFiles(root, { "ext/notes.md": "extension text\n", "ext/demo.md": "skill rules\n" });
  process.env.YOK_SKILLS_DIR = skillsDir;
  return { skillsDir, root, scope: projectScope(root, extensions) };
};

describe("loadSkill with the project's extensions", () => {
  let savedSkillsDir: string | undefined;
  beforeEach(() => {
    savedSkillsDir = process.env.YOK_SKILLS_DIR;
  });
  afterEach(() => {
    if (savedSkillsDir === undefined) delete process.env.YOK_SKILLS_DIR;
    else process.env.YOK_SKILLS_DIR = savedSkillsDir;
  });

  test.each([
    ["no extension", undefined, (s: string, _r: string) => ({ path: join(s, "demo/notes.md") })],
    [
      "replace",
      { replace: "ext/notes.md" },
      (_s: string, r: string) => ({ path: join(r, "ext/notes.md") }),
    ],
    [
      "extend",
      { extend: "ext/notes.md" },
      (s: string, r: string) => ({
        path: join(s, "demo/notes.md"),
        extraPath: join(r, "ext/notes.md"),
      }),
    ],
  ])("WS29 — with %s, notes reads the file it names", async (_label, notes, expected) => {
    const { skillsDir, root, scope } = await setupDemo(
      notes ? { demo: { references: { notes } } } : {},
    );
    const result = await loadSkill("demo", scope);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.references).toEqual({
      notes: { kind: "file", description: "Notes.", ...expected(skillsDir, root) },
    });
  });

  test("WS36 — an add is listed after the skill's own references, with its description or null", async () => {
    const { root, scope } = await setupDemo({
      demo: {
        references: {
          jira: { add: "ext/notes.md", description: "Jira issues: yourco.atlassian.net URLs." },
          bare: { add: "ext/notes.md" },
        },
      },
    });
    const result = await loadSkill("demo", scope);
    if (!result.ok) throw new Error(result.error);
    const { references } = result.value;
    expect(Object.keys(references)).toEqual(["notes", "jira", "bare"]);
    expect(references.jira).toEqual({
      kind: "file",
      path: join(root, "ext/notes.md"),
      description: "Jira issues: yourco.atlassian.net URLs.",
    });
    expect(references.bare?.description).toBeNull();
  });

  test("SC41: a command extension turns notes into that command, while an added reference still reads its file", async () => {
    const { root, scope } = await setupDemo({
      demo: { references: { notes: { command: "echo hi" }, extra: { add: "ext/notes.md" } } },
    });
    const result = await loadSkill("demo", scope);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.references.notes).toEqual({
      kind: "command",
      command: "echo hi",
      description: "Notes.",
    });
    expect(result.value.references.extra).toMatchObject({ path: join(root, "ext/notes.md") });
  });

  test.each([
    [
      "an extension naming a reference the skill lacks",
      { demo: { references: { ghost: { extend: "ext/notes.md" } } } },
      "extensions.demo.references.ghost: demo has no reference ghost",
    ],
    [
      "a command for a reference the skill lacks",
      { demo: { references: { ghost: { command: "echo hi" } } } },
      "has no reference ghost",
    ],
    [
      "an add on a key the skill declares",
      { demo: { references: { notes: { add: "ext/notes.md" } } } },
      "already has reference notes; use replace or extend",
    ],
    [
      "an extension file that does not exist",
      { demo: { references: { notes: { replace: "ext/missing.md" } } } },
      "extensions.demo.references.notes",
    ],
    [
      "an added file that does not exist",
      { demo: { references: { extra: { add: "ext/missing.md" } } } },
      "ext/missing.md",
    ],
    [
      "an extension doc that does not exist",
      { demo: { skill: "ext/missing.md" } },
      "extensions.demo.skill",
    ],
  ])("WS30 — %s is an error", async (_label, extensions, message) => {
    const { scope } = await setupDemo(extensions);
    const result = await loadSkill("demo", scope);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain(message);
  });

  test("WS31 — extensions.demo.skill becomes the skill's extension doc", async () => {
    const { root, scope } = await setupDemo({ demo: { skill: "ext/demo.md" } });
    const result = await loadSkill("demo", scope);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.extensionDoc).toBe(join(root, "ext/demo.md"));
  });

  test("WS35 — a stage path reads the skill from the project folder, with the extension set for its skill name", async () => {
    const root = join(dir, "project");
    await writeFiles(join(root, "stages", "demo"), {
      "SKILL.md": `---\n${demoFrontmatter}---\n`,
      "notes.md": "project text\n",
    });
    await writeFiles(root, { "ext/notes.md": "extension text\n" });
    process.env.YOK_SKILLS_DIR = join(dir, "no-skills");
    const scope = projectScope(root, {
      demo: { references: { notes: { extend: "ext/notes.md" } } },
    });
    const result = await loadSkill("stages/demo", scope);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.references.notes).toMatchObject({
      path: join(root, "stages/demo/notes.md"),
      extraPath: join(root, "ext/notes.md"),
    });
  });
});

describe("findWorkflowPath", () => {
  test.each([
    ["task", "/shipped/task.yaml"],
    ["task.yaml", "/project/task.yaml"],
    ["flows/task.yml", "/project/flows/task.yml"],
    ["./task", "/project/task"],
    ["/abs/task.yaml", "/abs/task.yaml"],
  ])("%s resolves to %s", (workflow, expected) => {
    expect(findWorkflowPath(workflow, "/project", "/shipped")).toBe(expected);
  });

  test("the default workflows directory ships task.yaml", () => {
    expect(existsSync(findWorkflowPath("task", "/project"))).toBe(true);
  });
});

describe("findReference", () => {
  test("WS30 — an unknown reference names the skill and every key it has, added ones too", async () => {
    const skillDir = await writeSkill("demo", demoFrontmatter, { "notes.md": "n\n" });
    await writeFiles(dir, { "ext/jira.md": "j\n" });
    const scope = projectScope(dir, { demo: { references: { jira: { add: "ext/jira.md" } } } });
    const skill = await loadSkill(skillDir, scope);
    if (!skill.ok) throw new Error(skill.error);
    expect(findReference(skill.value, "ghost")).toEqual({
      ok: false,
      error: 'unknown reference "ghost"; demo has: notes, jira',
    });
    expect(findReference(skill.value, "notes")).toMatchObject({ ok: true });
  });
});

describe("findSkill", () => {
  let savedSkillsDir: string | undefined;
  let root: string;
  let skills: string;

  beforeEach(async () => {
    savedSkillsDir = process.env.YOK_SKILLS_DIR;
    root = await mkdtemp(join(tmpdir(), "find-root-"));
    skills = await mkdtemp(join(tmpdir(), "find-skills-"));
    process.env.YOK_SKILLS_DIR = skills;
    await mkdir(join(root, "tools", "my-skill"), { recursive: true });
    await mkdir(join(skills, "ticket-fetcher"), { recursive: true });
  });

  afterEach(() => {
    if (savedSkillsDir === undefined) delete process.env.YOK_SKILLS_DIR;
    else process.env.YOK_SKILLS_DIR = savedSkillsDir;
  });

  test("SC40: without a run, a name with / is a project folder, a bare name a skills-folder skill, and a miss names where it looked", () => {
    const scope = projectScope(root);
    expect(findSkill("tools/my-skill", scope)).toEqual({
      ok: true,
      value: join(root, "tools", "my-skill"),
    });
    expect(findSkill("ticket-fetcher", scope)).toEqual({
      ok: true,
      value: join(skills, "ticket-fetcher"),
    });
    const bare = findSkill("nope", scope);
    const pathed = findSkill("tools/nope", scope);
    if (bare.ok || pathed.ok) throw new Error("expected failures");
    expect(bare.error).toContain(join(skills, "nope"));
    expect(pathed.error).toContain(join(root, "tools", "nope"));
  });

  test("SC58: with a run, the run's stage named ticket-fetcher wins over the skills folder, and a miss names the run's workflow and the skills folder", () => {
    const stageDir = join(root, "stages", "ticket-fetcher");
    const scope = projectScope(
      root,
      {},
      { name: "feat-x", stages: { "ticket-fetcher": stageDir } },
    );
    expect(findSkill("ticket-fetcher", scope)).toEqual({ ok: true, value: stageDir });
    const missing = findSkill("ghost", scope);
    if (missing.ok) throw new Error("expected a failure");
    expect(missing.error).toContain("run feat-x's workflow");
    expect(missing.error).toContain(join(skills, "ghost"));
  });
});

describe("the real create-workspace skill", () => {
  test("WS34 — loads, listing select-repos and the workspace script, each file on disk", async () => {
    const skillDir = join(import.meta.dir, "..", "..", "..", "skills", "create-workspace");
    const result = await loadSkill(skillDir, projectScope(dir));
    if (!result.ok) throw new Error(result.error);
    const { references } = result.value;
    expect(references["select-repos"]).toMatchObject({
      path: join(skillDir, "references/select-repos.md"),
    });
    expect(references.workspace).toMatchObject({ path: join(skillDir, "scripts/workspace.ts") });
  });
});

describe("the real ticket-fetcher skill", () => {
  const skillDir = join(import.meta.dir, "..", "..", "..", "skills", "ticket-fetcher");

  test("SC24: loads with an optional ticket artifact, linear and asana references and their scripts on disk, and a provider variable defaulting to auto", async () => {
    const result = await loadSkill(skillDir, projectScope(dir));
    if (!result.ok) throw new Error(result.error);
    const { produces, variables } = result.value.frontmatter;
    const paths = Object.fromEntries(
      Object.entries(result.value.references).map(([name, ref]) => [
        name,
        ref.kind === "file" ? relative(skillDir, ref.path) : null,
      ]),
    );
    expect(produces).toEqual([{ artifact: "ticket", optional: true }]);
    expect(paths).toEqual({
      linear: "references/linear.md",
      asana: "references/asana.md",
      validate: "scripts/ticket.ts",
      "linear-api": "scripts/linear.ts",
      "asana-api": "scripts/asana.ts",
    });
    expect(variables.provider?.default).toBe("auto");
  });

  test("SC27: each provider's description names the URLs it handles, which auto matches against", async () => {
    const result = await loadSkill(skillDir, projectScope(dir));
    if (!result.ok) throw new Error(result.error);
    const { references } = result.value;
    expect(references.linear?.description).toContain("linear.app");
    expect(references.asana?.description).toContain("app.asana.com");
  });

  const fetcherWorkflow = async (variables: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "ticket-wf-"));
    const path = join(dir, "wf.yaml");
    await writeFile(
      path,
      `name: t\ninputs:\n  prompt: { type: string, required: true }\nnodes:\n  - id: fetch\n    type: agent\n    stage: ticket-fetcher\n${variables}    input:\n      request: "{{ inputs.prompt }}"\n`,
    );
    return path;
  };

  test("SC25: a workflow that names its provider compiles", async () => {
    const path = await fetcherWorkflow("    variables: { provider: asana }\n");
    const plan = await compileWorkflow(path, { cwd: dirname(path) });
    expect(plan.nodes.map((node) => node.id)).toEqual(["fetch"]);
  });

  test("SC26: a workflow that leaves the provider unset compiles, the stage defaulting it to auto", async () => {
    const path = await fetcherWorkflow("");
    const plan = await compileWorkflow(path, { cwd: dirname(path) });
    const [fetch] = plan.nodes;
    expect(fetch?.type === "agent" && fetch.stage?.variables.provider?.default).toBe("auto");
  });
});

describe("the real design skill", () => {
  const skillDir = join(import.meta.dir, "..", "..", "..", "skills", "design");

  test("DS1: loads as an inline stage with no output schema, producing a design artifact, its references on disk", async () => {
    const result = await loadSkill(skillDir, projectScope(dir));
    if (!result.ok) throw new Error(result.error);
    const { frontmatter, references } = result.value;
    expect(frontmatter.mode).toBe("inline");
    expect(frontmatter.outputs).toBeUndefined();
    expect(frontmatter.produces).toEqual([{ artifact: "design", optional: false }]);
    expect(Object.keys(references).sort()).toEqual(["coverage", "design-doc"]);
  });

  test("DS2: a workflow that feeds it the ticket-fetcher's task compiles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-wf-"));
    const path = join(dir, "wf.yaml");
    await writeFile(
      path,
      'name: t\ninputs:\n  prompt: { type: string, required: true }\nnodes:\n  - id: fetch\n    type: agent\n    stage: ticket-fetcher\n    variables: { provider: linear }\n    input:\n      request: "{{ inputs.prompt }}"\n  - id: design\n    type: agent\n    stage: design\n    dependsOn: [fetch]\n    input:\n      task: "{{ nodes.fetch.output.task }}"\n',
    );
    const plan = await compileWorkflow(path, { cwd: dir });
    expect(plan.nodes.map((node) => node.id)).toEqual(["fetch", "design"]);
  });
});

describe("the real qa skill", () => {
  const skillDir = join(import.meta.dir, "..", "..", "..", "skills", "qa");

  test("SC5: loads as an inline stage with qa.output.v1, an optional proof-report artifact, its six references and its report-media script", async () => {
    const result = await loadSkill(skillDir, projectScope(dir));
    if (!result.ok) throw new Error(result.error);
    const stage = result.value.frontmatter;
    expect([stage.name, stage.mode, stage.outputs?.schema]).toEqual([
      "qa",
      "inline",
      "qa.output.v1",
    ]);
    expect(stage.produces).toEqual([{ artifact: "proof-report", optional: true }]);
    expect(Object.keys(result.value.references).sort()).toEqual([
      "driving-the-browser",
      "headless-verification",
      "report-media",
      "report-template",
      "stack-up",
      "visual-verification",
      "writing-the-report",
    ]);
  });

  test("takes an environment variable that defaults to the config's default entry", async () => {
    const result = await loadSkill(skillDir, projectScope(dir));
    if (!result.ok) throw new Error(result.error);
    expect(result.value.frontmatter.variables.environment?.default).toBe("default");
  });
});
