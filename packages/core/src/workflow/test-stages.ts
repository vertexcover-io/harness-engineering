import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DemoStage = Readonly<{ consumes?: string; produces?: string }>;

// Writes DIR/NAME/SKILL.md for each demo stage, declaring the artifacts it consumes and produces.
export const writeStages = (dir: string, stages: Readonly<Record<string, DemoStage>>): void => {
  mkdirSync(dir, { recursive: true });
  const zodUrl = import.meta.resolve("zod");
  writeFileSync(
    join(dir, "schemas.ts"),
    `import { z } from ${JSON.stringify(zodUrl)};\nexport const schemas = { "demo.output.v1": z.record(z.string(), z.json()) };\n`,
  );
  for (const [name, { consumes, produces }] of Object.entries(stages)) {
    mkdirSync(join(dir, name), { recursive: true });
    const lines = [
      "---",
      `name: ${name}`,
      `description: demo stage ${name}`,
      "mode: inline",
      "allowed-tools: [Bash]",
      "tier: fast",
      "inputs: { description: in, schema: demo.input.v1 }",
      "outputs: { description: out, schema: demo.output.v1, module: ../schemas.ts }",
      ...(consumes === undefined ? [] : [`consumes: ${consumes}`]),
      ...(produces === undefined ? [] : [`produces: ${produces}`]),
      "protocols: []",
      "scopes: []",
      "---",
      `# ${name}`,
    ];
    writeFileSync(join(dir, name, "SKILL.md"), lines.join("\n"));
  }
};

export const DEMO_STAGES = {
  producer: { produces: "[{ artifact: plan }]" },
  consumer: { consumes: "[{ artifact: plan }]" },
  reader: { consumes: "[{ artifact: plan, optional: true }]" },
} satisfies Record<string, DemoStage>;
