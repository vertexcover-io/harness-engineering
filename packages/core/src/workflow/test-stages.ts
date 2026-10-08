import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DemoStage = Readonly<{
  consumes?: string;
  produces?: string;
  verifiers?: string;
  variables?: string;
  tier?: string;
  references?: string;
  summary?: string;
}>;

// Functions the demo stages name as verifiers; `args.file` makes `record` write what it was given.
const VERIFIERS_MODULE = `
import { writeFileSync } from "node:fs";
export const pass = () => ({ pass: true, findings: [] });
export const fail = () => ({ pass: false, findings: [{ message: "fail one", path: "a.ts", line: 3, hint: "fix a" }] });
export const failLong = () => ({ pass: false, findings: [{ message: "a long finding ".repeat(50) }] });
export const failTwo = () => ({ pass: false, findings: [{ message: "fail two" }] });
export const throws = () => { throw new Error("boom"); };
export const slow = (input, context) => new Promise((resolve) => context.signal.addEventListener("abort", () => resolve({ pass: true })));
export const badShape = () => ({ pass: false, findings: [] });
export const record = (input, context) => {
  writeFileSync(input.args.file, JSON.stringify({ input, cwd: context.cwd, attempt: context.attempt }));
  return { pass: true, findings: [] };
};
`;

// Writes DIR/NAME/SKILL.md for each demo stage, declaring the artifacts it consumes and produces
// and the variables and references it takes.
export const writeStages = (dir: string, stages: Readonly<Record<string, DemoStage>>): void => {
  mkdirSync(dir, { recursive: true });
  const zodUrl = import.meta.resolve("zod");
  writeFileSync(
    join(dir, "schemas.ts"),
    `import { z } from ${JSON.stringify(zodUrl)};\nexport const schemas = { "demo.output.v1": z.record(z.string(), z.json()) };\n`,
  );
  writeFileSync(join(dir, "verifiers.ts"), VERIFIERS_MODULE);
  for (const [name, stage] of Object.entries(stages)) {
    const { consumes, produces, verifiers, variables, references, tier, summary } = stage;
    mkdirSync(join(dir, name), { recursive: true });
    const lines = [
      "---",
      `name: ${name}`,
      `description: demo stage ${name}`,
      ...(summary === undefined ? [] : [`summary: ${summary}`]),
      "mode: inline",
      "allowed-tools: [Bash]",
      ...(tier === undefined ? [] : [`tier: ${tier}`]),
      "inputs: { description: in, schema: demo.input.v1 }",
      "outputs: { description: out, schema: demo.output.v1, module: ../schemas.ts }",
      ...(consumes === undefined ? [] : [`consumes: ${consumes}`]),
      ...(produces === undefined ? [] : [`produces: ${produces}`]),
      ...(verifiers === undefined ? [] : [`verifiers: ${verifiers}`]),
      ...(variables === undefined ? [] : [`variables: ${variables}`]),
      ...(references === undefined ? [] : [`references: ${references}`]),
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
  thinker: { tier: "deep" },
  quick: { tier: "fast" },
  summarized: { summary: "Say how many files changed." },
  plain: {},
  tuned: {
    variables:
      "{ tone: { description: How to write, default: plain }, audience: { description: Who reads it } }",
  },
} satisfies Record<string, DemoStage>;
