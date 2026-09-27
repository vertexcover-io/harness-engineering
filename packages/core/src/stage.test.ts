import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod";
import { loadStage } from "./stage.ts";

const registry = {
  "planning.input.v1": z.object({ task: z.string() }),
  "planning.output.v1": z.object({ summary: z.string() }),
};

const validYaml = `name: planning
description: Turn a selected task into an implementation plan.
run:
  skill: planning
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
`;

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "stage-"));
});

const writeStage = async (fileName: string, yaml: string): Promise<string> => {
  const path = join(dir, fileName);
  await writeFile(path, yaml);
  return path;
};

describe("loadStage", () => {
  test("a valid stage loads with its input and output schemas resolved from the registry", async () => {
    const result = await loadStage(await writeStage("planning.yaml", validYaml), registry);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.stage.name).toBe("planning");
    expect(result.value.stage.produces).toEqual([{ artifact: "plan", optional: false }]);
    expect(result.value.inputSchema).toBe(registry["planning.input.v1"]);
    expect(result.value.outputSchema).toBe(registry["planning.output.v1"]);
  });

  test.each([
    ["a namespaced skill", "  skill: harness:code-review"],
    ["a snake_case command", "  command: test_all"],
    ["a namespaced command", "  command: npm:test_all"],
  ])("accepts %s as the run target", async (_label, run) => {
    const yaml = validYaml.replace("  skill: planning", run);
    const result = await loadStage(await writeStage("planning.yaml", yaml), registry);
    expect(result.ok).toBe(true);
  });

  test.each([
    ["a skill with a space", "  skill: Bad Name"],
    ["a skill with a double colon", "  skill: a::b"],
    ["a skill with an underscore", "  skill: code_review"],
    ["a command with a space", "  command: Bad Name"],
    ["a command with a double colon", "  command: a::b"],
  ])("rejects %s as the run target", async (_label, run) => {
    const yaml = validYaml.replace("  skill: planning", run);
    const result = await loadStage(await writeStage("planning.yaml", yaml), registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/run/);
  });

  test.each([
    ["an unknown field", validYaml.replace("tier:", "extra: 1\ntier:"), /extra/],
    ["a bad mode", validYaml.replace("mode: subagent", "mode: parallel"), /mode/],
    ["duplicate tags", validYaml.replace("[planning, design]", "[design, design]"), /unique/],
    [
      "an artifact entry missing its name",
      validYaml.replace("- artifact: plan", "- optional: true"),
      /produces/,
    ],
    [
      "both skill and command",
      validYaml.replace("  skill: planning", "  skill: planning\n  command: plan"),
      /run/,
    ],
    [
      "an unknown input schema key",
      validYaml.replace("planning.input.v1", "planning.input.v9"),
      /planning\.input\.v9/,
    ],
    [
      "an unknown output schema key",
      validYaml.replace("planning.output.v1", "planning.output.v2"),
      /planning\.output\.v2/,
    ],
    [
      "a model, since a stage asks for a model only through its tier",
      validYaml.replace("tier: balanced", "tier: balanced\nmodel: opus"),
      /model/,
    ],
    ["malformed YAML", "name: [unclosed", /YAML/i],
  ])("rejects %s", async (_label, yaml, message) => {
    const result = await loadStage(await writeStage("planning.yaml", yaml), registry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  test("rejects a stage whose name differs from its filename", async () => {
    const result = await loadStage(await writeStage("plan.yaml", validYaml), registry);
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(/planning.*plan\.yaml|plan\.yaml.*planning/),
    });
  });

  test.each([
    ["a missing file", () => join(dir, "missing.yaml")],
    ["a directory", () => dir],
  ])("returns an error naming the path for %s instead of throwing", async (_label, pathFor) => {
    const path = pathFor();
    expect(await loadStage(path, registry)).toEqual({
      ok: false,
      error: expect.stringContaining(`${path}: `),
    });
  });
});
