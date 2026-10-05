import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Notifier } from "@yok/sdk";
import { compileWorkflow } from "./compile.ts";
import { evaluateBoolean, resolveValue, type Scope } from "./evaluate.ts";
import { DEMO_STAGES, writeStages } from "./test-stages.ts";
import { NodeFailure, WorkflowError, type WorkflowErrorCode } from "./types.ts";

let workflowCount = 0;
const workflowDir = mkdtempSync(join(tmpdir(), "wf-yaml-"));
const compile = (source: string) => {
  workflowCount += 1;
  const path = join(workflowDir, `workflow-${workflowCount}.yml`);
  writeFileSync(path, source);
  return compileWorkflow(path);
};

const rejection = async (source: string): Promise<WorkflowError> => {
  try {
    await compile(source);
  } catch (error) {
    if (error instanceof WorkflowError) return error;
    throw error;
  }
  throw new Error("expected compileWorkflow to reject");
};

const script = (id: string, extra = ""): string => `
  - id: ${id}
    type: exec
    runtime: sh
    script: "true"
    input: null${extra}`;

const workflow = (nodes: string): string => `name: test\nnodes:${nodes}\n`;

const resolveFailure = (value: string, scope: Scope): NodeFailure => {
  try {
    resolveValue(value, scope);
  } catch (error) {
    if (error instanceof NodeFailure) return error;
    throw error;
  }
  throw new Error(`expected ${value} to fail`);
};

describe("compile", () => {
  test("SC1: a top-level agent: codex reaches the plan, a missing key means claude, and agent: pi is a schema error", async () => {
    expect((await compile(`agent: codex\n${workflow(script("a"))}`)).agent).toBe("codex");
    expect((await compile(workflow(script("a")))).agent).toBe("claude");
    expect((await rejection(`agent: pi\n${workflow(script("a"))}`)).code).toBe("schema");
  });

  test("SC19: a top-level tiers: set reaches the plan, a missing key compiles to {}, and a bad entry or a top-level tier is a schema error", async () => {
    const tiers = "tiers:\n  default: deep\n  models:\n    deep: { model: opus-x, effort: high }\n";
    expect((await compile(`${tiers}${workflow(script("a"))}`)).tiers).toEqual({
      default: "deep",
      models: { deep: { model: "opus-x", effort: "high" } },
    });
    expect((await compile(workflow(script("a")))).tiers).toEqual({});
    const bad = [
      "tiers:\n  models:\n    deep: { effort: high }\n",
      "tiers:\n  models:\n    deep: { model: opus-x, effort: extreme }\n",
      "tiers:\n  models:\n    deep-think: { model: opus-x }\n",
      "tiers:\n  deep: { model: opus-x }\n",
      "tier: deep\n",
    ];
    for (const entry of bad) {
      expect((await rejection(`${entry}${workflow(script("a"))}`)).code).toBe("schema");
    }
  });

  test("a top-level env and envFile reach the plan, a missing env is empty, and a lowercase env name is a schema error", async () => {
    const plan = await compile(
      `env: { API_URL: "http://x" }\nenvFile: ../shared/dev.env\n${workflow(script("a"))}`,
    );
    expect(plan.env).toEqual({ API_URL: "http://x" });
    expect(plan.envFile).toBe("../shared/dev.env");
    expect((await compile(workflow(script("a")))).env).toEqual({});
    expect((await rejection(`env: { apiUrl: x }\n${workflow(script("a"))}`)).code).toBe("schema");
    expect((await compile(`envFile: /etc/x.env\n${workflow(script("a"))}`)).envFile).toBe(
      "/etc/x.env",
    );
  });

  test("an included workflow's env and envFile are ignored: the plan keeps only the top workflow's", async () => {
    const childPath = join(workflowDir, "child-with-env.yml");
    writeFileSync(
      childPath,
      `name: child\nenvFile: child.env\nenv: { FOO_TOKEN: abc }\nnodes:${script("c")}\n`,
    );
    const plan = await compile(
      `env: { TOP: "1" }\n${workflow(`\n  - id: child\n    type: include\n    workflow: ${childPath}\n    input: null`)}`,
    );
    expect(plan.env).toEqual({ TOP: "1" });
    expect(plan.envFile).toBeUndefined();
  });

  test("resolves workflow.yaml output schemas before an exec or agent runs", async () => {
    const modulePath = join(workflowDir, "compile-output-schemas.ts");
    writeFileSync(
      modulePath,
      `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};\nexport const schemas = { answer: z.object({ answer: z.number() }) };\n`,
    );
    const output = `\n    output: { module: ${modulePath}, zodSchema: answer }`;
    const source = workflow(
      script("compute", output) +
        `\n  - id: review\n    type: agent\n    prompt: Review\n    input: null${output}`,
    );
    const plan = await compile(source);
    expect(plan.nodes[0]).toHaveProperty("outputSchema");
    expect(plan.nodes[1]).toHaveProperty("outputSchema");
  });

  test("rejects broken workflow.yaml schema references in nested and included nodes", async () => {
    const missing = join(workflowDir, "missing-output-schema.ts");
    const nested = workflow(
      `\n  - id: repeat\n    type: loop\n    input: null\n    maxIterations: 1\n    until: "{{ true }}"\n    nodes:\n      - id: inner\n        type: exec\n        runtime: sh\n        script: "true"\n        input: null\n        output: { module: ${missing}, zodSchema: answer }`,
    );
    expect((await rejection(nested)).code).toBe("missing-module");

    const includedPath = join(workflowDir, "included-with-missing-schema.yml");
    writeFileSync(
      includedPath,
      workflow(script("inside", `\n    output: { module: ${missing}, zodSchema: answer }`)),
    );
    const included = workflow(
      `\n  - id: child\n    type: include\n    workflow: ${includedPath}\n    input: null`,
    );
    expect((await rejection(included)).code).toBe("missing-module");
  });

  test("SC1 — an unknown node field is rejected with its path", async () => {
    const error = await rejection(workflow(script("a", "\n    comand: x")));
    expect(error.code).toBe("schema");
    expect(error.message).toContain("nodes.0");
    expect(error.message).toContain("comand");
  });

  test("SC2 — malformed YAML is rejected before any shape check", async () => {
    const error = await rejection("name: test\nnodes:\n  - id: a\n    input: { from: x\n");
    expect(error.code).toBe("yaml");
  });

  test("SC3 — a node without input is rejected", async () => {
    const error = await rejection(
      workflow("\n  - id: a\n    type: exec\n    runtime: sh\n    script: 'true'"),
    );
    expect(error.code).toBe("schema");
    expect(error.message).toContain("input");
    await expect(compile(workflow(script("a")))).resolves.toBeDefined();
  });

  test("SC4 — an exec node must be exactly a script or exactly a function", async () => {
    const both = workflow(script("a", "\n    module: ./x.ts\n    functionName: f"));
    const neither = workflow("\n  - id: a\n    type: exec\n    input: null");
    for (const source of [both, neither]) {
      expect((await rejection(source)).code).toBe("schema");
    }
    const fn = workflow(
      "\n  - id: a\n    type: exec\n    module: ./x.ts\n    functionName: f\n    input: null",
    );
    await expect(compile(fn)).resolves.toBeDefined();
    await expect(compile(workflow(script("a")))).resolves.toBeDefined();
  });

  test("IW7 — an exec node runs inline unless it asks for background, and any other mode is rejected", async () => {
    const [plain, background] = await Promise.all([
      compile(workflow(script("a"))),
      compile(workflow(script("a", "\n    mode: background"))),
    ]);
    expect(plain.nodes[0]).toMatchObject({ mode: "inline" });
    expect(background.nodes[0]).toMatchObject({ mode: "background" });
    const error = await rejection(workflow(script("a", "\n    mode: later")));
    expect(error.code).toBe("schema");
  });

  test("SC5 — two nodes with the same id are rejected", async () => {
    const error = await rejection(workflow(script("build") + script("build")));
    expect(error.code).toBe("duplicate-id");
    expect(error.message).toContain("build");
  });

  test("SC6 — an id containing a dot or brackets is rejected", async () => {
    for (const id of ["a.b", "'fix[1]'"]) {
      expect((await rejection(workflow(script(id)))).code).toBe("schema");
    }
  });

  test("SC61 — an id that names an object prototype key is rejected", async () => {
    for (const id of ["__proto__", "prototype", "constructor"]) {
      expect((await rejection(workflow(script(id)))).code).toBe("schema");
    }
  });

  test("an always: true node that reads another node is rejected, since that node may never have run", async () => {
    const error = await rejection(
      workflow(
        `${script("a")}${script("c", "\n    always: true\n    dependsOn: [a]\n    when: \"{{ nodes.a.status == 'failed' }}\"")}`,
      ),
    );
    expect(error.code).toBe("invalid-reference");
    expect(error.message).toContain("always");
    expect(error.message).toContain("nodes.a.status");
  });

  test("SC7 — a dependency on a node that does not exist is rejected", async () => {
    const error = await rejection(workflow(script("b", "\n    dependsOn: [a]")));
    expect(error.code).toBe("missing-dependency");
    expect(error.message).toContain("b");
    expect(error.message).toContain('"a"');
  });

  test("SC8 — a cycle is rejected and no module is imported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-sc8-"));
    const marker = join(dir, "imported");
    const modulePath = join(dir, "side-effect.ts");
    writeFileSync(
      modulePath,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\nexport const f = () => 1;\n`,
    );
    const source = workflow(`
  - id: a
    type: exec
    module: ${modulePath}
    functionName: f
    input: null
    dependsOn: [b]
${script("b", "\n    dependsOn: [a]").slice(1)}`);
    const error = await rejection(source);
    expect(error.code).toBe("cycle");
    expect(error.message).toContain("a");
    expect(error.message).toContain("b");
    expect(existsSync(marker)).toBe(false);
  });

  test("SC9 — reading a node that is not a dependency is rejected", async () => {
    const source = workflow(
      script("a") +
        script("b", "\n    dependsOn: [a]") +
        '\n  - id: d\n    type: exec\n    runtime: sh\n    script: "true"\n    input: "{{ nodes.b.output }}"',
    );
    const error = await rejection(source);
    expect(error.code).toBe("invalid-reference");
    expect(error.message).toContain("d");
    expect(error.message).toContain('"b"');
  });

  test("SC10 — a node may read any transitive dependency", async () => {
    const source = workflow(
      script("a") +
        script("b", "\n    dependsOn: [a]") +
        '\n  - id: c\n    type: exec\n    runtime: sh\n    script: "true"\n    dependsOn: [b]\n    input: "{{ nodes.a.output }}"',
    );
    await expect(compile(source)).resolves.toBeDefined();
  });

  test("SC11 — compiled nodes come out in dependency order, stable by declaration", async () => {
    const plan = await compile(
      workflow(script("b", "\n    dependsOn: [a]") + script("a") + script("c")),
    );
    expect(plan.nodes.map((node) => node.id)).toEqual(["a", "b", "c"]);
  });
});

describe("evaluate", () => {
  test("SC12 — a whole-value expression keeps its type; an embedded one becomes text", () => {
    const scope: Scope = { inputs: { count: 3, tags: ["a"] }, nodes: {} };
    expect(resolveValue("{{ inputs.count }}", scope)).toBe(3);
    expect(resolveValue("{{ inputs.tags }}", scope)).toEqual(["a"]);
    expect(resolveValue("count={{ inputs.count }} tags={{ inputs.tags }}", scope)).toBe(
      'count=3 tags=["a"]',
    );
    expect(resolveValue({ from: "{{ inputs.count }}" }, scope)).toEqual({ from: 3 });
    expect(resolveValue("{{ inputs }}", scope)).toEqual({ count: 3, tags: ["a"] });
  });

  test("SC13 — prototype keys and inherited properties never resolve", () => {
    const scope: Scope = { inputs: { a: {} }, nodes: {} };
    for (const value of [
      "{{ inputs.a.__proto__ }}",
      "{{ inputs.constructor }}",
      "{{ inputs.a.toString }}",
    ]) {
      expect(resolveFailure(value, scope).kind).toBe("resolution");
    }
  });

  test("SC14 — a missing field or a non-completed node's output fails resolution", () => {
    const scope: Scope = {
      inputs: {},
      nodes: { a: { status: "completed", output: { x: 1, y: null } }, b: { status: "skipped" } },
    };
    expect(resolveValue("{{ nodes.a.output.x }}", scope)).toBe(1);
    expect(resolveValue("{{ nodes.a.output.y }}", scope)).toBeNull();
    const missing = resolveFailure("{{ nodes.a.output.z }}", scope);
    expect(missing.kind).toBe("resolution");
    expect(missing.message).toContain("z");
    const skipped = resolveFailure("{{ nodes.b.output }}", scope);
    expect(skipped.kind).toBe("resolution");
    expect(skipped.message).toContain("skipped");
    expect(resolveValue("{{ nodes.b.status }}", scope)).toBe("skipped");
  });
});

const switchWorkflow = (cases: string, childInput = '"{{ inputs }}"'): string => `name: t
nodes:
  - id: inspect
    type: exec
    runtime: sh
    script: "true"
    input: null
  - id: decide
    type: switch
    dependsOn: [inspect]
    input: "{{ nodes.inspect.output }}"
    expression: "{{ nodes.inspect.output.exitCode }}"
    cases:
${cases}
      - id: repair
        value: needs-fix
        nodes:
          - id: fix
            type: exec
            runtime: sh
            script: "true"
            input: ${childInput}
`;

const switchCase = (id: string, value: string): string => `      - id: ${id}
        value: ${value}
        nodes:
          - id: child
            type: exec
            runtime: sh
            script: "true"
            input: null`;

describe("conditions and switch", () => {
  test("SC25 — conditions evaluate comparisons, and/or/not and parentheses", () => {
    const scope: Scope = { inputs: { n: 3, s: "a", flag: true }, nodes: {} };
    expect(evaluateBoolean("{{ inputs.n > 2 and not inputs.flag }}", scope)).toBe(false);
    expect(evaluateBoolean("{{ (inputs.n == 3 or false) and inputs.s == 'a' }}", scope)).toBe(true);
    expect(evaluateBoolean("{{ inputs.n == '3' }}", scope)).toBe(false);
    for (const text of ["{{ inputs.n < 'b' }}", "{{ inputs.flag and 1 }}"]) {
      expect(() => evaluateBoolean(text, scope)).toThrow(NodeFailure);
    }
  });

  test("SC26 — anything outside the grammar is rejected at compile", async () => {
    for (const when of [
      "{{ inputs.n + 1 }}",
      "{{ run(inputs.n) }}",
      "{{ inputs.a }} and {{ inputs.b }}",
    ]) {
      const error = await rejection(workflow(script("a", `\n    when: "${when}"`)));
      expect(error.code).toBe("invalid-expression");
    }
  });

  test("SC27 — repeated case ids or values, and a case named default, are rejected", async () => {
    const sources = [
      switchWorkflow(`${switchCase("one", "1")}\n${switchCase("two", "1")}`),
      switchWorkflow(`${switchCase("a", "1")}\n${switchCase("a", "2")}`),
      switchWorkflow(switchCase("default", "1")),
    ];
    for (const source of sources) {
      expect((await rejection(source)).code).toBe("schema");
    }
    await expect(
      compile(switchWorkflow(`${switchCase("one", "1")}\n${switchCase("two", '"1"')}`)),
    ).resolves.toBeDefined();
  });

  test("SC28 — a switch child reads the switch input and its siblings, never outer nodes", async () => {
    const error = await rejection(switchWorkflow("", '"{{ nodes.inspect.output }}"'));
    expect(error.code).toBe("invalid-reference");
    expect(error.path).toBe("decide.repair.fix");
    await expect(compile(switchWorkflow(""))).resolves.toBeDefined();
  });

  test("SC29 — an output schema is a zodSchema from output.module, or the built-in Json with no module", async () => {
    const exec = (output: string) =>
      workflow(
        `\n  - id: a\n    type: exec\n    module: ./x.ts\n    functionName: f\n    input: null\n    output: ${output}`,
      );
    const agent = (output: string) =>
      workflow(
        `\n  - id: a\n    type: agent\n    prompt: p\n    input: null\n    output: ${output}`,
      );
    const rejected: [string, string][] = [
      ["{ module: ./schemas.ts }", "zodSchema"],
      ["{ zodSchema: inspection }", "output.module is required unless zodSchema is Json"],
      ["{}", "zodSchema"],
    ];
    for (const [output, message] of rejected) {
      for (const source of [exec(output), agent(output)]) {
        const error = await rejection(source);
        expect(error.code).toBe("schema");
        expect(error.message).toContain("output");
        expect(error.message).toContain(message);
      }
    }
    const schemaPath = join(workflowDir, "sc29-schemas.ts");
    writeFileSync(
      schemaPath,
      `import { z } from ${JSON.stringify(import.meta.resolve("zod"))};\nexport const schemas = { inspection: z.object({ status: z.string() }) };\n`,
    );
    for (const output of [
      "{ zodSchema: Json }",
      `{ module: ${schemaPath}, zodSchema: inspection }`,
    ]) {
      await expect(compile(exec(output))).resolves.toBeDefined();
      await expect(compile(agent(output))).resolves.toBeDefined();
    }
    await expect(
      compile(workflow(script("a", "\n    output: { zodSchema: Json }"))),
    ).resolves.toBeDefined();
  });

  test("output.format is not a field of an exec node", async () => {
    const error = await rejection(
      workflow(script("a", "\n    output: { zodSchema: Json, format: json }")),
    );
    expect(error.code).toBe("schema");
    expect(error.message).toContain("format");
  });
});

describe("workflow files", () => {
  test("SC60 — a workflow path that cannot be read is rejected", async () => {
    const missing = join(workflowDir, "nope.yml");
    await expect(compileWorkflow(missing)).rejects.toMatchObject({
      code: "missing-workflow",
      path: missing,
    });
  });
});

const includeNode = (id: string, file: string): string => `
  - id: ${id}
    type: include
    workflow: ${file}
    input: {}`;

const writeIn = (dir: string, name: string, source: string): string => {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
};

const compileRejection = async (path: string, cwd: string): Promise<WorkflowError> => {
  try {
    await compileWorkflow(path, { cwd });
  } catch (error) {
    if (error instanceof WorkflowError) return error;
    throw error;
  }
  throw new Error("expected compileWorkflow to reject");
};

describe("workflow doctor declarations", () => {
  const declared = (check: string, key: string, fix = "fix it"): string =>
    `  - check: ${check}\n    key: ${key}\n    fix: ${fix}\n`;

  test("a workflow without doctor compiles to an empty list", async () => {
    expect((await compile(workflow(script("a")))).doctor).toEqual([]);
  });

  test("declarations are kept in order", async () => {
    const plan = await compile(
      `name: test\ndoctor:\n${declared("env", "A")}${declared("binary", "bun")}nodes:${script("a")}\n`,
    );
    expect(plan.doctor.map((d) => `${d.check}:${d.key}`)).toEqual(["env:A", "binary:bun"]);
  });

  test.each<[string, Notifier | undefined]>([
    ["notifier: { type: slack }", { enabled: true, type: "slack" }],
    ["notifier: { enabled: false }", { enabled: false, type: "slack" }],
    ["", undefined],
  ])(
    "SC208: a workflow with %p carries its notifier on the plan and declares nothing to the doctor",
    async (block, expected) => {
      const plan = await compile(`name: test\n${block}\nnodes:${script("a")}\n`);

      expect(plan.notifier).toEqual(expected);
      expect(plan.doctor).toEqual([]);
    },
  );

  test.each([
    ["an unknown check kind", "  - check: network\n    key: x\n    fix: y\n"],
    ["an unknown field", "  - check: env\n    key: x\n    fix: y\n    optional: true\n"],
    ["an empty key", '  - check: env\n    key: ""\n    fix: y\n'],
    ["a missing fix", "  - check: env\n    key: x\n"],
  ])("%s is a schema error", async (_label, entry) => {
    const error = await rejection(`name: test\ndoctor:\n${entry}nodes:${script("a")}\n`);
    expect(error.code).toBe("schema");
  });

  test("included workflows add their checks, recursively, without identical duplicates", async () => {
    const leaf = join(workflowDir, "doctor-leaf.yml");
    writeFileSync(
      leaf,
      `name: leaf\ndoctor:\n${declared("env", "SHARED")}${declared("file", "leaf.txt")}nodes:${script("x")}\n`,
    );
    const mid = join(workflowDir, "doctor-mid.yml");
    writeFileSync(
      mid,
      `name: mid\ndoctor:\n${declared("env", "SHARED")}${declared("binary", "mid")}nodes:\n  - id: leaf\n    type: include\n    workflow: ${leaf}\n    input: null\n`,
    );
    const plan = await compile(
      `name: top\ndoctor:\n${declared("env", "TOP")}nodes:\n  - id: mid\n    type: include\n    workflow: ${mid}\n    input: null\n`,
    );
    expect(plan.doctor.map((d) => `${d.check}:${d.key}`)).toEqual([
      "env:TOP",
      "env:SHARED",
      "binary:mid",
      "file:leaf.txt",
    ]);
  });

  test("the same key with a different fix is kept as a separate entry", async () => {
    const other = join(workflowDir, "doctor-other-fix.yml");
    writeFileSync(
      other,
      `name: o\ndoctor:\n${declared("env", "K", "second")}nodes:${script("x")}\n`,
    );
    const plan = await compile(
      `name: top\ndoctor:\n${declared("env", "K", "first")}nodes:\n  - id: o\n    type: include\n    workflow: ${other}\n    input: null\n`,
    );
    expect(plan.doctor).toHaveLength(2);
  });
});

describe("includes, loops and agents", () => {
  test("SC46 — a recursive include is rejected with its chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-inc-"));
    const root = writeIn(dir, "root.yml", workflow(includeNode("a", "./a.yml")));
    writeIn(dir, "a.yml", workflow(includeNode("b", "./b.yml")));
    writeIn(dir, "b.yml", workflow(includeNode("a", "./a.yml")));
    const error = await compileRejection(root, dir);
    expect(error.code).toBe("include-recursion");
    expect(error.message).toMatch(/root\.yml -> .*a\.yml -> .*b\.yml -> .*a\.yml/);
  });

  test("SC47 — includes past the depth or size limit are rejected", async () => {
    const deep = mkdtempSync(join(tmpdir(), "wf-deep-"));
    for (let level = 0; level < 10; level += 1) {
      writeIn(deep, `w${level}.yml`, workflow(includeNode("next", `./w${level + 1}.yml`)));
    }
    writeIn(deep, "w10.yml", workflow(script("leaf")));
    expect((await compileRejection(join(deep, "w0.yml"), deep)).code).toBe("include-limit");

    const wide = mkdtempSync(join(tmpdir(), "wf-wide-"));
    writeIn(
      wide,
      "big.yml",
      workflow(Array.from({ length: 600 }, (_, i) => script(`n${i}`)).join("")),
    );
    const root = writeIn(
      wide,
      "root.yml",
      workflow(includeNode("one", "./big.yml") + includeNode("two", "./big.yml")),
    );
    expect((await compileRejection(root, wide)).code).toBe("include-limit");
  });

  test("SC48 — an include whose file cannot be read is rejected at compile", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-miss-"));
    const root = writeIn(dir, "root.yml", workflow(includeNode("a", "./missing.yml")));
    const error = await compileRejection(root, dir);
    expect(error.code).toBe("missing-workflow");
    expect(error.message).toContain("missing.yml");
  });

  test("SC49 — an include node holds the included workflow, compiled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-include-"));
    const root = writeIn(dir, "root.yml", workflow(includeNode("a", "./child.yml")));
    writeIn(
      dir,
      "child.yml",
      `name: child\ninputs:\n  word: { type: string, default: hi }\nnodes:${script("x")}\n`,
    );
    const [include] = (await compileWorkflow(root, { cwd: dir })).nodes;
    expect(include).toMatchObject({
      type: "include",
      plan: { name: "child", inputs: { word: { type: "string" } }, nodes: [{ id: "x" }] },
    });
  });

  test("SC50 — an agent node needs a stage or a prompt", async () => {
    const agent = (fields: string) =>
      workflow(`\n  - id: a\n    type: agent\n    input: null${fields}`);
    for (const fields of [
      "",
      "\n    prompt: hi\n    command: go",
      "\n    prompt: hi\n    skills: [x]",
      "\n    prompt: hi\n    adapter: claude",
    ]) {
      expect((await rejection(agent(fields))).code).toBe("schema");
    }
    for (const fields of [
      "\n    prompt: hi",
      "\n    stage: create-workspace",
      "\n    stage: create-workspace\n    prompt: hi",
    ]) {
      await expect(compile(agent(fields))).resolves.toBeDefined();
    }
  });

  test("SC51 — until reads the iteration, never outer nodes, and iteration is loop-only", async () => {
    const loop = workflow(
      `${script("inspect")}\n  - id: fix\n    type: loop\n    dependsOn: [inspect]\n    maxIterations: 3\n    until: "{{ nodes.inspect.output.done }}"\n    input: null\n    nodes:${script("step").replaceAll("\n  ", "\n      ")}`,
    );
    expect((await rejection(loop)).code).toBe("invalid-reference");
    const outside = workflow(script("a").replace("input: null", 'input: "{{ iteration.index }}"'));
    expect((await rejection(outside)).code).toBe("invalid-reference");
  });

  test("SC62 — an until outside the grammar is rejected at compile", async () => {
    const loop = workflow(
      `\n  - id: fix\n    type: loop\n    maxIterations: 3\n    until: "{{ inputs.n + 1 }}"\n    input: null\n    nodes:${script("step").replaceAll("\n  ", "\n      ")}`,
    );
    expect((await rejection(loop)).code).toBe("invalid-expression");
  });
});

const stageNode = (id: string, stage: string, extra = ""): string => `
  - { id: ${id}, type: agent, stage: ${stage}, input: {}${extra} }`;

// Compiles SOURCE in a fresh project whose stages/ folder holds the demo stages.
const compileWithStages = async (source: string) => {
  const project = mkdtempSync(join(tmpdir(), "wf-project-"));
  writeStages(join(project, "stages"), DEMO_STAGES);
  const path = join(project, "workflow.yml");
  writeFileSync(path, source);
  return { project, plan: await compileWorkflow(path, { cwd: project }) };
};

const stagesRejection = async (source: string): Promise<WorkflowError> => {
  try {
    await compileWithStages(source);
  } catch (error) {
    if (error instanceof WorkflowError) return error;
    throw error;
  }
  throw new Error("expected compileWorkflow to reject");
};

describe("compile with stages", () => {
  test("SC8: a stage whose SKILL.md says tier: fast compiles with PlanStage.tier fast", async () => {
    const { plan } = await compileWithStages(workflow(stageNode("make", "stages/quick")));
    const make = plan.nodes.find((node) => node.id === "make");
    if (make?.type !== "agent" || make.stage === undefined) throw new Error("expected a stage");
    expect(make.stage.tier).toBe("fast");
  });

  test("an agent node's tier: deep reaches the plan beside its stage's tier: fast, and a prompt agent node's tier: fast too", async () => {
    const { plan } = await compileWithStages(
      workflow(
        `${stageNode("make", "stages/quick", ", tier: deep")}\n  - { id: ask, type: agent, prompt: hi, input: {}, tier: fast }`,
      ),
    );
    expect(plan.nodes).toMatchObject([
      { id: "make", tier: "deep", stage: { tier: "fast" } },
      { id: "ask", tier: "fast" },
    ]);
  });

  test.each([
    ["an exec node", script("a", "\n    tier: deep")],
    ["a context node", "\n  - { id: a, type: context, action: new, tier: deep }"],
    [
      "a loop node",
      `\n  - id: fix\n    type: loop\n    tier: deep\n    maxIterations: 1\n    until: "{{ true }}"\n    input: null\n    nodes:${script("step").replaceAll("\n  ", "\n      ")}`,
    ],
    ["an agent node, when not camelCase", stageNode("make", "stages/quick", ", tier: deep-think")],
  ])("a tier on %s is a schema error", async (_label, nodes) => {
    expect((await stagesRejection(workflow(nodes))).code).toBe("schema");
  });

  test("a stage with no outputs compiles with no output schema, so its output is plain text", async () => {
    const project = mkdtempSync(join(tmpdir(), "wf-stage-no-outputs-"));
    writeStages(join(project, "stages"), DEMO_STAGES);
    const skill = join(project, "stages", "producer", "SKILL.md");
    const source = await Bun.file(skill).text();
    writeFileSync(skill, source.replace(/^(inputs|outputs): .*\n/gm, ""));
    const path = join(project, "workflow.yml");
    writeFileSync(path, workflow(stageNode("make", "stages/producer")));

    const plan = await compileWorkflow(path, { cwd: project });
    const make = plan.nodes.find((node) => node.id === "make");
    if (make?.type !== "agent" || make.stage === undefined) throw new Error("expected a stage");
    expect(make.stage.output).toBeUndefined();
  });

  test("a stage without a resolvable output schema is rejected before execution", async () => {
    const project = mkdtempSync(join(tmpdir(), "wf-stage-schema-"));
    writeStages(join(project, "stages"), DEMO_STAGES);
    const skill = join(project, "stages", "producer", "SKILL.md");
    const source = await Bun.file(skill).text();
    writeFileSync(skill, source.replace(", module: ../schemas.ts", ""));
    const path = join(project, "workflow.yml");
    writeFileSync(path, workflow(stageNode("make", "stages/producer")));

    try {
      await compileWorkflow(path, { cwd: project });
      throw new Error("expected a missing schema error");
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      expect(error.code).toBe("missing-schema");
      expect(error.message).toContain("outputs.module");
    }
  });

  test.each<[string, string, WorkflowErrorCode]>([
    ["a missing module", "{ id: v, module: ../nope.ts, functionName: pass }", "missing-module"],
    [
      "a missing function",
      "{ id: v, module: ../verifiers.ts, functionName: nope }",
      "missing-export",
    ],
  ])("a verifier with %s fails compile", async (_name, verifier, code) => {
    const project = mkdtempSync(join(tmpdir(), "wf-verifier-"));
    writeStages(join(project, "stages"), { producer: { verifiers: `[${verifier}]` } });
    const path = join(project, "workflow.yml");
    writeFileSync(path, workflow(stageNode("make", "stages/producer")));
    const error = await compileWorkflow(path, { cwd: project }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkflowError);
    expect((error as WorkflowError).code).toBe(code);
  });

  test.each([
    ["both", "{ id: v, module: ../verifiers.ts, functionName: pass, runtime: sh, script: ok }"],
    ["neither", "{ id: v }"],
    ["a module without a function", "{ id: v, module: ../verifiers.ts }"],
    ["a runtime without a script", "{ id: v, runtime: sh }"],
  ])("a verifier needs a function or a script, so %s fails compile", async (_name, verifier) => {
    const project = mkdtempSync(join(tmpdir(), "wf-verifier-shape-"));
    writeStages(join(project, "stages"), { producer: { verifiers: `[${verifier}]` } });
    const path = join(project, "workflow.yml");
    writeFileSync(path, workflow(stageNode("make", "stages/producer")));
    const error = await compileWorkflow(path, { cwd: project }).catch((caught: unknown) => caught);
    expect((error as WorkflowError).code).toBe("missing-stage");
    expect((error as WorkflowError).message).toContain(
      "runtime + script, or module + functionName",
    );
  });

  test("a stage cannot override its own output schema in the workflow node", async () => {
    const error = await stagesRejection(
      workflow(
        stageNode("make", "stages/producer", ", output: { module: ./other.ts, zodSchema: other }"),
      ),
    );
    expect(error.code).toBe("schema");
    expect(error.message).toContain("SKILL.md");
  });

  test("a required consumed artifact cannot depend only on an optional producer", async () => {
    const project = mkdtempSync(join(tmpdir(), "wf-optional-producer-"));
    writeStages(join(project, "stages"), {
      producer: { produces: "[{ artifact: plan, optional: true }]" },
      consumer: DEMO_STAGES.consumer,
    });
    const path = join(project, "workflow.yml");
    writeFileSync(
      path,
      workflow(
        `${stageNode("make", "stages/producer")}${stageNode("use", "stages/consumer", ", dependsOn: [make]")}`,
      ),
    );
    try {
      await compileWorkflow(path, { cwd: project });
      throw new Error("expected a missing artifact error");
    } catch (error) {
      if (!(error instanceof WorkflowError)) throw error;
      expect(error.code).toBe("missing-artifact");
      expect(error.message).toContain("optional");
    }
  });

  test("a required consumed artifact cannot depend only on a producer that may fail", async () => {
    const error = await stagesRejection(
      workflow(
        `${stageNode("make", "stages/producer", ", allowFailure: true")}${stageNode("use", "stages/consumer", ", dependsOn: [make]")}`,
      ),
    );
    expect(error.code).toBe("missing-artifact");
    expect(error.message).toContain("allowFailure");
  });

  test("SC6: an always: true stage that needs a required artifact is refused, naming the node, the artifact and always", async () => {
    const error = await stagesRejection(
      workflow(
        `${stageNode("make", "stages/producer")}${stageNode("use", "stages/consumer", ", always: true, dependsOn: [make]")}`,
      ),
    );
    expect(error.code).toBe("missing-artifact");
    expect(error.path).toBe("use");
    expect(error.message).toContain('"plan"');
    expect(error.message).toContain("may never be written before it starts: it is always: true");
    expect(error.message).not.toContain("no node it depends on produces it");
  });

  test("an always: true loop around a stage that needs a required artifact is refused at that stage", async () => {
    const error = await stagesRejection(
      workflow(`${stageNode("make", "stages/producer")}
  - id: retry
    type: loop
    always: true
    dependsOn: [make]
    until: "{{ iteration.index >= 1 }}"
    maxIterations: 2
    input: {}
    nodes:
      - { id: use, type: agent, stage: stages/consumer, input: {} }`),
    );
    expect(error.code).toBe("missing-artifact");
    expect(error.path).toBe("retry.use");
    expect(error.message).toContain(
      "may never be written before it starts: it is inside an always: true node",
    );
    expect(error.message).not.toContain("no node it depends on produces it");
  });

  test("a required consumed artifact cannot depend only on a container that may fail", async () => {
    const error = await stagesRejection(
      workflow(`
  - id: retry
    type: loop
    allowFailure: true
    until: "{{ iteration.index >= 1 }}"
    maxIterations: 2
    input: {}
    nodes:
      - { id: make, type: agent, stage: stages/producer, input: {} }${stageNode("use", "stages/consumer", ", dependsOn: [retry]")}`),
    );
    expect(error.code).toBe("missing-artifact");
  });

  test("a consumer cannot rely on an artifact produced by only one switch case", async () => {
    const source = workflow(`
  - id: choice
    type: switch
    expression: "{{ inputs.route }}"
    input: {}
    cases:
      - id: make
        value: make
        nodes:
          - { id: producer, type: agent, stage: stages/producer, input: {} }
      - id: skip
        value: skip
        nodes:
          - { id: noop, type: wait, durationMs: 1, input: null }
  - { id: use, type: agent, stage: stages/consumer, input: {}, dependsOn: [choice] }`);
    const error = await stagesRejection(source);
    expect(error.code).toBe("missing-artifact");
    expect(error.message).toContain("plan");
  });

  test("IW31 — a stage that needs an artifact compiles when it depends on the node producing it, and the plan lists each stage's artifacts", async () => {
    const { project, plan } = await compileWithStages(
      workflow(
        `${stageNode("make", "stages/producer")}${stageNode("use", "stages/consumer", ", dependsOn: [make]")}`,
      ),
    );
    const [make, use] = plan.nodes;
    expect(make).toMatchObject({ stage: { produces: [{ artifact: "plan" }] } });
    expect(use).toMatchObject({
      stage: {
        ref: "stages/consumer",
        name: "consumer",
        skill: join(project, "stages/consumer/SKILL.md"),
        consumes: [{ artifact: "plan" }],
      },
    });
  });

  test("IW32 — a stage that needs an artifact no node before it produces is rejected, naming the stage, the artifact and the fix", async () => {
    const error = await stagesRejection(
      workflow(`${stageNode("use", "stages/consumer")}${stageNode("make", "stages/producer")}`),
    );
    expect(error.code).toBe("missing-artifact");
    expect(error.message).toContain("use");
    expect(error.message).toContain("plan");
    expect(error.message).toContain("dependsOn");
  });

  test.each([
    [
      "a consumer inside a loop that depends on the producer",
      `${stageNode("make", "stages/producer")}
  - id: fix
    type: loop
    dependsOn: [make]
    until: "{{ true }}"
    maxIterations: 1
    input: {}
    nodes:${stageNode("use", "stages/consumer").replaceAll("\n  ", "\n      ")}`,
    ],
    [
      "a consumer depending on a switch whose case holds the producer",
      `
  - id: pick
    type: switch
    expression: "{{ 'a' }}"
    input: {}
    cases:
      - id: a
        value: a
        nodes:${stageNode("make", "stages/producer").replaceAll("\n  ", "\n          ")}${stageNode("use", "stages/consumer", ", dependsOn: [pick]")}`,
    ],
    ["a stage whose artifact is optional", stageNode("read", "stages/reader")],
  ])(
    "IW33 — artifacts reach every node that is guaranteed to come after their producer: %s",
    async (_label, nodes) => {
      await expect(compileWithStages(workflow(nodes))).resolves.toBeDefined();
    },
  );

  test("IW34 — a stage name reads yok's own skills folder, a stage path reads the project root, and a stage in neither is rejected", async () => {
    const { plan } = await compileWithStages(workflow(stageNode("ws", "create-workspace")));
    expect(plan.nodes[0]).toMatchObject({
      stage: { skill: expect.stringMatching(/\/skills\/create-workspace\/SKILL\.md$/) },
    });
    for (const stage of ["nowhere", "stages/nowhere"]) {
      const error = await stagesRejection(workflow(stageNode("x", stage)));
      expect(error.code).toBe("missing-stage");
      expect(error.message).toContain(stage);
    }
  });
});

describe("stage variables", () => {
  const tuned = (variables: string, extra = "") =>
    workflow(stageNode("say", "stages/tuned", `, variables: ${variables}${extra}`));

  test("a node setting a variable its skill does not declare is rejected, naming the known ones", async () => {
    const error = await stagesRejection(tuned("{ audience: devs, volume: loud }"));
    expect(error.code).toBe("schema");
    expect(error.message).toContain('"volume"');
    expect(error.message).toContain("tone, audience");
  });

  test("a node leaving out a variable its skill gives no default is rejected, naming it", async () => {
    const error = await stagesRejection(tuned("{ tone: loud }"));
    expect(error.code).toBe("schema");
    expect(error.message).toContain('"audience"');
  });

  test("a prompt-only agent node cannot set variables", async () => {
    const error = await rejection(
      workflow(
        "\n  - { id: ask, type: agent, prompt: hi, input: null, variables: { tone: loud } }",
      ),
    );
    expect(error.code).toBe("schema");
    expect(error.message).toContain("variables");
    expect(error.message).toContain("stage");
  });

  test.each([
    [
      "reads a node it does not depend on",
      '{ audience: "{{ nodes.other.output }}" }',
      "invalid-reference",
    ],
    ["mixes text and an expression", '{ audience: "all {{ inputs.who }}" }', "invalid-expression"],
  ] as const)("a variable that %s is rejected", async (_label, variables, code) => {
    const other = "\n  - { id: other, type: wait, durationMs: 1, input: null }";
    const error = await stagesRejection(`${tuned(variables)}${other}\n`);
    expect(error.code).toBe(code);
    expect(error.message).toContain("say");
  });
});

describe("compiled node placement", () => {
  test("IW42 — every compiled node lists the ids of the containers around it, through switches, loops and includes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-parents-"));
    writeIn(dir, "child.yml", workflow(script("c")));
    const root = writeIn(
      dir,
      "root.yml",
      `name: t
nodes:
  - id: top
    type: exec
    runtime: sh
    script: "true"
    input: null
  - id: fix
    type: loop
    until: "{{ true }}"
    maxIterations: 1
    input: null
    nodes:
      - id: pick
        type: switch
        expression: "{{ 'a' }}"
        input: null
        cases:
          - id: a
            value: a
            nodes:
              - { id: sub, type: include, workflow: ./child.yml, input: {} }
`,
    );
    const plan = await compileWorkflow(root, { cwd: dir });
    const [top, fix] = plan.nodes;
    expect(top?.parents).toEqual([]);
    expect(fix?.parents).toEqual([]);
    if (fix?.type !== "loop") throw new Error("fix is not a loop");
    const [pick] = fix.nodes;
    expect(pick?.parents).toEqual(["fix"]);
    if (pick?.type !== "switch") throw new Error("pick is not a switch");
    const [sub] = pick.cases[0]?.nodes ?? [];
    expect(sub?.parents).toEqual(["fix", "pick"]);
    if (sub?.type !== "include") throw new Error("sub is not an include");
    expect(sub.plan.nodes[0]?.parents).toEqual(["fix", "pick", "sub"]);
  });

  test("a context node compiles with action new or compact; agent nodes take no context", async () => {
    const plan = await compile(workflow("\n  - id: fresh\n    type: context\n    action: new"));
    expect(plan.nodes[0]).toMatchObject({
      id: "fresh",
      type: "context",
      action: "new",
      input: null,
    });
    const badAction = await rejection(
      workflow("\n  - id: fresh\n    type: context\n    action: clear"),
    );
    expect(badAction.message).toContain("action");
    const steered = await compile(
      workflow("\n  - id: slim\n    type: context\n    action: compact\n    prompt: keep the plan"),
    );
    expect(steered.nodes[0]).toMatchObject({ action: "compact", prompt: "keep the plan" });
    const promptOnNew = await rejection(
      workflow("\n  - id: fresh\n    type: context\n    action: new\n    prompt: x"),
    );
    expect(promptOnNew.message).toContain("prompt");
    const agent =
      "\n  - id: ask\n    type: agent\n    prompt: hi\n    input: null\n    context: clear";
    expect((await rejection(workflow(agent))).message).toContain("context");
  });
});

describe("the shipped task workflow", () => {
  const TASK_WORKFLOW = join(import.meta.dir, "..", "..", "..", "..", "workflows", "task.yaml");

  test("compiles with ticket-fetcher first, its task feeding create-workspace, and the Linear checks", async () => {
    const plan = await compileWorkflow(TASK_WORKFLOW);

    expect(plan.nodes.map((node) => node.id).slice(0, 2)).toEqual([
      "ticket-fetcher",
      "create-workspace",
    ]);
    expect(plan.doctor.map((d) => `${d.check}:${d.key}`)).toEqual([
      "env:LINEAR_API_KEY",
      "binary:bun",
      "binary:gh",
    ]);
    const workspace = plan.nodes.find((node) => node.id === "create-workspace");
    expect(workspace).toMatchObject({
      dependsOn: ["ticket-fetcher"],
      input: { request: "{{ nodes.ticket-fetcher.output.task }}" },
    });
  });

  test("takes an optional environment input that defaults to the config's default entry", async () => {
    const plan = await compileWorkflow(TASK_WORKFLOW);

    expect(plan.inputs.environment).toEqual({
      type: "string",
      required: false,
      default: "default",
    });
  });

  test("runs the design stage after the baseline, fed the ticket-fetcher's task", async () => {
    const plan = await compileWorkflow(TASK_WORKFLOW);

    expect(plan.nodes.find((node) => node.id === "design")).toMatchObject({
      dependsOn: ["baseline"],
      input: { task: "{{ nodes.ticket-fetcher.output.task }}" },
    });
  });

  test("SC10: runs planning, implement and code-review in that order, each in the run's workspace", async () => {
    const plan = await compileWorkflow(TASK_WORKFLOW);
    const workspace = "{{ nodes.create-workspace.output }}";

    expect(plan.nodes.slice(-7, -4)).toMatchObject([
      {
        id: "planning",
        stage: { ref: "planning" },
        dependsOn: ["design"],
        input: { task: "{{ nodes.ticket-fetcher.output.task }}", workspace },
      },
      {
        id: "implement",
        stage: { ref: "implement" },
        dependsOn: ["planning"],
        input: { workspace },
      },
      {
        id: "code-review",
        stage: { ref: "code-review" },
        dependsOn: ["implement"],
        input: { workspace },
      },
    ]);
  });

  test("SC8: runs a qa loop after code-review that re-runs implement with qa's bugs until qa stops failing", async () => {
    const plan = await compileWorkflow(TASK_WORKFLOW);

    expect(plan.nodes.at(-4)).toMatchObject({
      id: "qa-loop",
      type: "loop",
      dependsOn: ["code-review"],
      until: "{{ iteration.nodes.qa.output.status != 'FAIL' }}",
      maxIterations: 4,
      input: {
        workspace: "{{ nodes.create-workspace.output }}",
        task: "{{ nodes.ticket-fetcher.output.task }}",
        environment: "{{ inputs.environment }}",
      },
      nodes: [
        {
          id: "fix",
          stage: { ref: "implement" },
          when: "{{ iteration.index > 1 }}",
          dependsOn: [],
          input: { workspace: "{{ inputs.workspace }}", feedback: "{{ iteration.previous.bugs }}" },
        },
        {
          id: "qa",
          stage: { ref: "qa", output: { name: "qa.output.v1" } },
          dependsOn: [],
          variables: { environment: "{{ inputs.environment }}" },
          input: {
            workspace: "{{ inputs.workspace }}",
            task: "{{ inputs.task }}",
            round: "{{ iteration.index }}",
            rounds: "{{ iteration.max }}",
          },
        },
      ],
    });
  });

  test("SC20: the last node is an always, allow-failure retro after pr, with input {}", async () => {
    const plan = await compileWorkflow(TASK_WORKFLOW);

    expect(plan.nodes.at(-1)).toMatchObject({
      id: "retro",
      type: "agent",
      stage: { ref: "retro" },
      dependsOn: ["pr"],
      always: true,
      allowFailure: true,
      input: {},
    });
  });

  test("runs git-commit then visual-pr after the qa loop, each in the run's workspace", async () => {
    const plan = await compileWorkflow(TASK_WORKFLOW);
    const workspace = "{{ nodes.create-workspace.output }}";

    expect(plan.nodes.slice(-3, -1)).toMatchObject([
      {
        id: "commit",
        stage: { ref: "git-commit" },
        dependsOn: ["qa-loop"],
        when: "{{ nodes.qa-loop.output.status != 'BLOCKED' }}",
        input: { workspace },
      },
      {
        id: "pr",
        stage: { ref: "visual-pr" },
        dependsOn: ["commit"],
        input: { workspace, task: "{{ nodes.ticket-fetcher.output.task }}" },
      },
    ]);
  });
});
