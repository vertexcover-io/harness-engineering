import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflow } from "./compile.ts";
import { evaluateBoolean, resolveValue, type Scope } from "./evaluate.ts";
import { NodeFailure, WorkflowError } from "./types.ts";

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
    const formatOnModule = workflow(
      "\n  - id: a\n    type: exec\n    module: ./x.ts\n    functionName: f\n    input: null\n    output:\n      format: json",
    );
    for (const source of [both, neither, formatOnModule]) {
      expect((await rejection(source)).code).toBe("schema");
    }
    const fn = workflow(
      "\n  - id: a\n    type: exec\n    module: ./x.ts\n    functionName: f\n    input: null",
    );
    await expect(compile(fn)).resolves.toBeDefined();
    await expect(compile(workflow(script("a")))).resolves.toBeDefined();
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

  test("SC29 — output.module and output.zodSchema must come together", async () => {
    const fn = (output: string) =>
      workflow(
        `\n  - id: a\n    type: exec\n    module: ./x.ts\n    functionName: f\n    input: null\n    output: ${output}`,
      );
    for (const output of ["{ zodSchema: inspection }", "{ module: ./schemas.ts }"]) {
      const error = await rejection(fn(output));
      expect(error.code).toBe("schema");
      expect(error.message).toContain("output");
    }
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

  test("SC49 — editing an included workflow changes the parent's hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-hash-"));
    const root = writeIn(dir, "root.yml", workflow(includeNode("a", "./child.yml")));
    writeIn(dir, "child.yml", workflow(script("x")));
    const first = await compileWorkflow(root, { cwd: dir });
    writeIn(dir, "child.yml", workflow(script("y")));
    const second = await compileWorkflow(root, { cwd: dir });
    expect(first.hash).not.toBe(second.hash);
  });

  test("SC50 — an agent node needs a stage or a prompt", async () => {
    const agent = (fields: string) =>
      workflow(`\n  - id: a\n    type: agent\n    adapter: default\n    input: null${fields}`);
    for (const fields of [
      "",
      "\n    prompt: hi\n    command: go",
      "\n    prompt: hi\n    skills: [x]",
    ]) {
      expect((await rejection(agent(fields))).code).toBe("schema");
    }
    for (const fields of [
      "\n    prompt: hi",
      "\n    stage: review",
      "\n    stage: review\n    prompt: hi",
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
