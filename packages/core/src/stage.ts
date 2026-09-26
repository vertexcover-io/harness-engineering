import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parse } from "yaml";
import * as z from "zod";
import { type Result, type Stage, StageSchema } from "./contracts.ts";

export type SchemaRegistry = Readonly<Record<string, z.ZodType>>;

export type LoadedStage = {
  readonly stage: Stage;
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
};

const readText = async (path: string): Promise<Result<string>> => {
  try {
    return { ok: true, value: await readFile(path, "utf8") };
  } catch (error) {
    return { ok: false, error: `${path}: cannot read file: ${String(error)}` };
  }
};

const parseYaml = (text: string, path: string): Result<unknown> => {
  try {
    return { ok: true, value: parse(text) };
  } catch (error) {
    return { ok: false, error: `${path}: invalid YAML: ${String(error)}` };
  }
};

export const loadStage = async (
  path: string,
  registry: SchemaRegistry,
): Promise<Result<LoadedStage>> => {
  const text = await readText(path);
  if (!text.ok) return text;
  const yaml = parseYaml(text.value, path);
  if (!yaml.ok) return yaml;
  const parsed = StageSchema.safeParse(yaml.value);
  if (!parsed.success) return { ok: false, error: `${path}: ${z.prettifyError(parsed.error)}` };
  const stage = parsed.data;
  const fileName = basename(path);
  if (fileName !== `${stage.name}.yaml`) {
    return { ok: false, error: `${path}: stage name "${stage.name}" must match ${fileName}` };
  }
  const inputSchema = registry[stage.inputs.schema];
  const outputSchema = registry[stage.outputs.schema];
  if (!inputSchema) return { ok: false, error: `${path}: unknown schema ${stage.inputs.schema}` };
  if (!outputSchema) return { ok: false, error: `${path}: unknown schema ${stage.outputs.schema}` };
  return { ok: true, value: { stage, inputSchema, outputSchema } };
};
