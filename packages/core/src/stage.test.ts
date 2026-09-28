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
import { loadStage, resolveExtension, resolveReference, StageSchema } from "./stage.ts";

const validStage = {
  name: "planning",
  description: "Turn a selected task into an implementation plan.",
  mode: "subagent",
  tags: ["planning", "design"],
  "allowed-tools": ["Read", "Write"],
  tier: "balanced",
  inputs: { description: "Task context.", schema: "planning.input.v1" },
  outputs: { description: "Planning result.", schema: "planning.output.v1" },
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
  ])("WS30 — %s is an error", async (_label, extensions, ref, message) => {
    const options = await setupResolve(extensions);
    const result = await resolveReference({ ...options, ref });
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain(message);
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
