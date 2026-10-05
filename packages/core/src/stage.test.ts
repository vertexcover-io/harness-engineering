import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ConfigInput, ConfigSchema } from "@harness/sdk";
import * as z from "zod";
import {
  CreateWorkspaceInputSchema,
  CreateWorkspaceOutputSchema,
} from "../../../skills/create-workspace/scripts/workspace.ts";
import { schemas as qaSchemas } from "../../../skills/qa/scripts/qa.ts";
import { schemas as ticketSchemas } from "../../../skills/ticket-fetcher/scripts/ticket.ts";
import {
  listReferences,
  loadStage,
  resolveExtension,
  resolveReference,
  resolveReferencePath,
  StageSchema,
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

const registry = {
  "planning.input.v1": z.object({ task: z.string() }),
  "planning.output.v1": z.object({ summary: z.string() }),
};

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

describe("loadStage", () => {
  test("WS26 — a skill folder whose SKILL.md names it loads with its schemas resolved", async () => {
    const result = await loadStage(await writeSkill("planning", validFrontmatter), registry);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.stage.name).toBe("planning");
    expect(result.value.stage.references).toEqual({
      rubric: { path: "references/rubric.md", description: "How to grade a plan." },
    });
    expect(result.value.stage.produces).toEqual([{ artifact: "plan", optional: false }]);
    expect(result.value.inputSchema).toBe(registry["planning.input.v1"]);
    expect(result.value.outputSchema).toBe(registry["planning.output.v1"]);
  });

  test("a stage with no inputs or outputs takes any JSON in and plain text out", async () => {
    const bare = validFrontmatter.replace(/inputs:\n.*\n.*\noutputs:\n.*\n.*\n.*\n/, "");
    const result = await loadStage(await writeSkill("planning", bare), registry);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.inputSchema.safeParse({ any: ["thing"] }).success).toBe(true);
    expect(result.value.outputSchema.safeParse("plain text").success).toBe(true);
  });

  test("WS27 — a folder named planning holding name: plan is rejected, naming both", async () => {
    const frontmatter = validFrontmatter.replace("name: planning", "name: plan");
    const result = await loadStage(await writeSkill("planning", frontmatter), registry);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain('"plan"');
    expect(result.error).toContain("planning");
  });

  test("WS27 — a listed reference whose file is missing is rejected, naming the path", async () => {
    const result = await loadStage(await writeSkill("planning", validFrontmatter, {}), registry);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain("references/rubric.md");
  });

  test("WS28 — scopes: [] loads", async () => {
    const frontmatter = validFrontmatter.replace("scopes: [feature]", "scopes: []");
    const result = await loadStage(await writeSkill("planning", frontmatter), registry);
    expect(result.ok).toBe(true);
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
      "an unknown input schema key",
      validFrontmatter.replace("planning.input.v1", "planning.input.v9"),
      /planning\.input\.v9/,
    ],
    [
      "an unknown output schema key",
      validFrontmatter.replace("planning.output.v1", "planning.output.v2"),
      /planning\.output\.v2/,
    ],
    [
      "a model, since a stage asks for a model only through its tier",
      validFrontmatter.replace("tier: balanced", "tier: balanced\nmodel: opus"),
      /model/,
    ],
    ["malformed YAML", "name: [unclosed\n", /YAML/i],
  ])("rejects %s", async (_label, frontmatter, message) => {
    const result = await loadStage(await writeSkill("planning", frontmatter), registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  test("a missing skill folder returns an error naming the path instead of throwing", async () => {
    const skillDir = join(dir, "missing");
    expect(await loadStage(skillDir, registry)).toEqual({
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

const setupResolve = async (extensions: ConfigInput["extensions"]) => {
  const skillsDir = join(dir, "skills");
  const root = join(dir, "repo");
  await writeFiles(join(skillsDir, "demo"), {
    "SKILL.md": `---\n${demoFrontmatter}---\n`,
    "notes.md": "base text\n",
  });
  await writeFiles(root, { "ext/notes.md": "extension text\n", "ext/demo.md": "skill rules\n" });
  const config = ConfigSchema.parse({ version: 2, extensions });
  return { skillsDir, root, config, skill: "demo" };
};

describe("resolveReference", () => {
  test.each([
    ["no extension", undefined, "base text\n"],
    ["replace", { replace: "ext/notes.md" }, "extension text\n"],
    ["extend", { extend: "ext/notes.md" }, "base text\n\nextension text\n"],
  ])("WS29 — with %s", async (_label, notes, expected) => {
    const options = await setupResolve(notes ? { demo: { references: { notes } } } : {});
    expect(await resolveReference({ ...options, ref: "notes" })).toEqual({
      ok: true,
      value: expected,
    });
  });

  test.each([
    ["an unlisted ref", {}, "ghost", 'unknown reference "ghost"; demo has: notes'],
    [
      "an extension naming an unlisted ref",
      { demo: { references: { ghost: { extend: "ext/notes.md" } } } },
      "notes",
      "extensions.demo.references.ghost",
    ],
    [
      "an extension path that does not exist",
      { demo: { references: { notes: { replace: "ext/missing.md" } } } },
      "notes",
      "ext/missing.md",
    ],
    [
      "an add on a key the skill declares",
      { demo: { references: { notes: { add: "ext/notes.md" } } } },
      "notes",
      "already has reference notes",
    ],
    [
      "an unknown reference, listing added keys",
      { demo: { references: { extra: { add: "ext/notes.md" } } } },
      "ghost",
      "notes, extra",
    ],
  ])("WS30 — %s is an error", async (_label, extensions, ref, message) => {
    const options = await setupResolve(extensions);
    const result = await resolveReference({ ...options, ref });
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain(message);
  });
});

describe("resolveReference add", () => {
  test("WS36 — an add on an undeclared key resolves to the project file", async () => {
    const options = await setupResolve({
      demo: { references: { extra: { add: "ext/notes.md" } } },
    });
    expect(await resolveReference({ ...options, ref: "extra" })).toEqual({
      ok: true,
      value: "extension text\n",
    });
  });
});

describe("listReferences", () => {
  test("lists the skill's references, then the project's added ones, each with its description", async () => {
    const options = await setupResolve({
      demo: {
        references: {
          notes: { extend: "ext/notes.md" },
          jira: { add: "ext/notes.md", description: "Jira issues: yourco.atlassian.net URLs." },
          bare: { add: "ext/notes.md" },
        },
      },
    });
    expect(await listReferences(options)).toEqual({
      ok: true,
      value: [
        { name: "notes", description: "Notes." },
        { name: "jira", description: "Jira issues: yourco.atlassian.net URLs." },
        { name: "bare", description: null },
      ],
    });
  });

  test("an extension that does not fit the skill is an error, as it is for a single reference", async () => {
    const options = await setupResolve({
      demo: { references: { notes: { add: "ext/notes.md" } } },
    });
    const result = await listReferences(options);
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain("already has reference notes");
  });
});

describe("resolveReferencePath", () => {
  test.each([
    [
      "no extension",
      "notes",
      undefined,
      (skillsDir: string, _root: string) => join(skillsDir, "demo", "notes.md"),
    ],
    [
      "replace",
      "notes",
      { notes: { replace: "ext/notes.md" } },
      (_s: string, root: string) => join(root, "ext/notes.md"),
    ],
    [
      "add",
      "extra",
      { extra: { add: "ext/notes.md" } },
      (_s: string, root: string) => join(root, "ext/notes.md"),
    ],
  ])(
    "with %s, it is the path of the file the reference reads",
    async (_label, ref, references, expected) => {
      const options = await setupResolve(references ? { demo: { references } } : {});
      expect(await resolveReferencePath({ ...options, ref })).toEqual({
        ok: true,
        value: expected(options.skillsDir, options.root),
      });
    },
  );

  test.each([
    [
      "an extend, which has no single file",
      { notes: { extend: "ext/notes.md" } },
      "notes",
      "replace",
    ],
    [
      "a replace whose file does not exist",
      { notes: { replace: "ext/missing.md" } },
      "notes",
      "ext/missing.md",
    ],
    ["an unlisted ref", {}, "ghost", 'unknown reference "ghost"'],
  ])("%s is an error", async (_label, references, ref, message) => {
    const options = await setupResolve({ demo: { references } });
    const result = await resolveReferencePath({ ...options, ref });
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain(message);
  });
});

describe("a stage path", () => {
  test("WS35 — skill ref on a stage with a / reads its reference from the project folder, with the extension set for its skill name", async () => {
    const root = join(dir, "project");
    await writeFiles(join(root, "stages", "demo"), {
      "SKILL.md": `---\n${demoFrontmatter}---\n`,
      "notes.md": "project text\n",
    });
    await writeFiles(root, { "ext/notes.md": "extension text\n" });
    const extensions = { demo: { references: { notes: { extend: "ext/notes.md" } } } };
    const config = ConfigSchema.parse({ version: 2, extensions });
    const options = { skillsDir: join(dir, "no-skills"), root, config, skill: "stages/demo" };
    expect(await resolveReference({ ...options, ref: "notes" })).toEqual({
      ok: true,
      value: "project text\n\nextension text\n",
    });
  });
});

describe("resolveExtension", () => {
  test.each([
    ["extensions.demo.skill set", { demo: { skill: "ext/demo.md" } }, "skill rules\n"],
    ["no skill extension", {}, ""],
  ])("WS31 — with %s", async (_label, extensions, expected) => {
    const options = await setupResolve(extensions);
    expect(await resolveExtension(options)).toEqual({ ok: true, value: expected });
  });
});

describe("the real create-workspace skill", () => {
  test("WS34 — loads through loadStage with its own schemas, listing select-repos whose file exists", async () => {
    const skillDir = join(import.meta.dir, "..", "..", "..", "skills", "create-workspace");
    const result = await loadStage(skillDir, {
      "create-workspace.input.v1": CreateWorkspaceInputSchema,
      "create-workspace.output.v1": CreateWorkspaceOutputSchema,
    });
    if (!result.ok) throw new Error(result.error);
    const selectRepos = result.value.stage.references["select-repos"];
    expect(selectRepos?.path).toBe("references/select-repos.md");
    expect(existsSync(join(skillDir, selectRepos?.path ?? ""))).toBe(true);
  });
});

describe("the real ticket-fetcher skill", () => {
  const skillDir = join(import.meta.dir, "..", "..", "..", "skills", "ticket-fetcher");

  test("SC24: loads through loadStage with its own schemas, an optional ticket artifact, linear and asana references on disk and a provider variable defaulting to auto", async () => {
    const result = await loadStage(skillDir, ticketSchemas);
    if (!result.ok) throw new Error(result.error);
    const { produces, references, variables } = result.value.stage;
    expect(produces).toEqual([{ artifact: "ticket", optional: true }]);
    expect(references.linear?.path).toBe("references/linear.md");
    expect(references.asana?.path).toBe("references/asana.md");
    expect(existsSync(join(skillDir, references.asana?.path ?? ""))).toBe(true);
    expect(variables.provider?.default).toBe("auto");
  });

  test("SC27: each provider's description names the URLs it handles, which auto matches against", async () => {
    const result = await loadStage(skillDir, ticketSchemas);
    if (!result.ok) throw new Error(result.error);
    const { references } = result.value.stage;
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
    const result = await loadStage(skillDir, {});
    if (!result.ok) throw new Error(result.error);
    expect(result.value.stage.mode).toBe("inline");
    expect(result.value.stage.outputs).toBeUndefined();
    expect(result.value.stage.produces).toEqual([{ artifact: "design", optional: false }]);
    expect(Object.keys(result.value.stage.references).sort()).toEqual(["coverage", "design-doc"]);
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

  test("SC5: loads as an inline stage with qa.output.v1, an optional proof-report artifact and its five references", async () => {
    const result = await loadStage(skillDir, qaSchemas);
    if (!result.ok) throw new Error(result.error);
    const { stage } = result.value;
    expect([stage.name, stage.mode, stage.outputs?.schema]).toEqual([
      "qa",
      "inline",
      "qa.output.v1",
    ]);
    expect(stage.produces).toEqual([{ artifact: "proof-report", optional: true }]);
    expect(Object.keys(stage.references).sort()).toEqual([
      "driving-the-browser",
      "headless-verification",
      "report-template",
      "visual-verification",
      "writing-the-report",
    ]);
  });
});
