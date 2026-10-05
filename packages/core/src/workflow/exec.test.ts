import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonValue } from "@yok/sdk";
import { compileWorkflow } from "./compile.ts";
import { runStepLeaf } from "./exec.ts";
import { type NodeRecord, type PlanNode, WorkflowError } from "./types.ts";

const makeRoot = (): string => mkdtempSync(join(tmpdir(), "wf-run-"));

const writeFile = (root: string, relative: string, content: string): string => {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

// Compiles one node, written as its workflow.yaml lines, the way `orchestrate exec` sees it.
const compileNode = async (root: string, lines: string): Promise<PlanNode> => {
  const path = writeFile(root, "workflow.yml", `name: t\nnodes:\n  - id: a\n${lines}\n`);
  const [node] = (await compileWorkflow(path, { cwd: root })).nodes;
  if (node === undefined) throw new Error("no node compiled");
  return node;
};

const runLeaf = async (
  root: string,
  lines: string,
  input: JsonValue = null,
): Promise<NodeRecord> => {
  const node = await compileNode(root, lines);
  if (node.type !== "exec" && node.type !== "wait") throw new Error(`a is a ${node.type} node`);
  return runStepLeaf(node, input, { cwd: root, path: "nr-a" });
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const lines = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];

describe("exec scripts", () => {
  test("SC15 — a script with the built-in Json schema reads its input on stdin, its parsed stdout is the output, and the process record is kept apart", async () => {
    const record = await runLeaf(
      makeRoot(),
      "    type: exec\n    runtime: sh\n    script: cat\n    input: null\n    output: { zodSchema: Json }",
      { n: 41 },
    );
    expect(record).toMatchObject({ status: "completed", attempts: 1 });
    expect(record.output).toEqual({ n: 41 });
    expect(record.process).toEqual({ stdout: '{"n":41}', stderr: "", exitCode: 0 });
  });

  test("SC64 — a script with no output schema has its stdout text as its output", async () => {
    const record = await runLeaf(
      makeRoot(),
      "    type: exec\n    runtime: sh\n    script: echo hi\n    input: null",
    );
    expect(record).toMatchObject({ status: "completed", output: "hi\n" });
    expect(record.process).toEqual({ stdout: "hi\n", stderr: "", exitCode: 0 });
  });

  test("SC16 — script stdout that is not JSON fails a node with an output schema and keeps its process record", async () => {
    const record = await runLeaf(
      makeRoot(),
      "    type: exec\n    runtime: sh\n    script: echo not json\n    input: null\n    output: { zodSchema: Json }",
    );
    expect(record.status).toBe("failed");
    expect(record.error?.kind).toBe("validation");
    expect(record.process).toEqual({ stdout: "not json\n", stderr: "", exitCode: 0 });
  });

  test("SC17 — a nonzero exit fails the node and keeps its process record, with no output", async () => {
    const record = await runLeaf(
      makeRoot(),
      '    type: exec\n    runtime: sh\n    script: "echo boom >&2; exit 3"\n    input: null',
    );
    expect(record.status).toBe("failed");
    expect(record.error?.kind).toBe("exit");
    expect(record.process).toEqual({ stdout: "", stderr: "boom\n", exitCode: 3 });
    expect(record.output).toBeUndefined();
  });

  test("SC18 — a timeout kills the script and every process it started", async () => {
    const root = makeRoot();
    const pidFile = join(root, "pid");
    const started = Date.now();
    const record = await runLeaf(
      root,
      `    type: exec\n    runtime: sh\n    script: "sleep 30 & echo $! > ${pidFile}; wait"\n    timeoutMs: 200\n    input: null`,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(record.status).toBe("failed");
    expect(record.error?.kind).toBe("timeout");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const deadline = Date.now() + 1000;
    while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
    expect(isAlive(pid)).toBe(false);
  });

  test("SC19 — output past 1 MiB is cut off and the node still completes", async () => {
    const record = await runLeaf(
      makeRoot(),
      `    type: exec
    runtime: bun
    input: null
    script: |
      process.stdout.write("a".repeat(1_200_000));
      process.stderr.write("b".repeat(1_200_000));`,
    );
    expect(record.status).toBe("completed");
    expect(record.process?.stdout).toBe("a".repeat(1_048_576));
    expect(record.process?.stderr).toBe("b".repeat(1_048_576));
  });
});

const echoModule = `
const echo = (input, context) => ({ input, context: { path: context.path, cwd: context.cwd, attempt: context.attempt } });
export { echo };
export default echo;
`;

const fnLines = (module: string, fn: string, extra = ""): string =>
  `    type: exec\n    module: ${module}\n    functionName: ${fn}\n    input: null${extra}`;

describe("exec functions", () => {
  test("SC20 — module functions resolve from the run cwd and receive input and context", async () => {
    const root = makeRoot();
    const absolute = writeFile(root, "fns/echo.ts", echoModule);
    mkdirSync(join(root, "sub"));
    const named = await runLeaf(root, fnLines("./fns/echo.ts", "echo", "\n    cwd: sub"), {
      value: 1,
    });
    expect(named.output).toEqual({
      input: { value: 1 },
      context: { path: "nr-a", cwd: join(root, "sub"), attempt: 1 },
    });
    expect(named.process).toBeUndefined();
    expect((await runLeaf(root, fnLines("./fns/echo.ts", "default"))).status).toBe("completed");
    expect((await runLeaf(root, fnLines(absolute, "echo"))).status).toBe("completed");
  });

  test("SC21 — a missing module or export fails the node, naming what is missing", async () => {
    const root = makeRoot();
    writeFile(root, "fns/echo.ts", echoModule);
    const noExport = await runLeaf(root, fnLines("./fns/echo.ts", "nope"));
    expect(noExport.status).toBe("failed");
    expect(noExport.error?.message).toContain("nope");
    const noModule = await runLeaf(root, fnLines("./fns/missing.ts", "echo"));
    expect(noModule.status).toBe("failed");
    expect(noModule.error?.message).toContain("missing.ts");
  });

  test("SC22 — a function returning a non-JSON value fails its node", async () => {
    const root = makeRoot();
    writeFile(root, "fns/nothing.ts", "export const nothing = () => undefined;\n");
    const record = await runLeaf(root, fnLines("./fns/nothing.ts", "nothing"));
    expect(record.status).toBe("failed");
    expect(record.error?.kind).toBe("validation");
  });

  test("SC63 — a function timeout aborts the signal it gave that attempt before the retry", async () => {
    const root = makeRoot();
    writeFile(
      root,
      "fns/hang.ts",
      `let first;
export const hang = (_input, context) => {
  if (context.attempt === 1) {
    first = context.signal;
    return new Promise(() => undefined);
  }
  return { firstAborted: first.aborted };
};
`,
    );
    const record = await runLeaf(
      root,
      fnLines("./fns/hang.ts", "hang", "\n    timeoutMs: 20\n    retry: { maxAttempts: 2 }"),
    );
    expect(record.output).toEqual({ firstAborted: true });
  });
});

const zodUrl = import.meta.resolve("zod");

const helpers = `
import { appendFileSync } from "node:fs";
export const flaky = (input, context) => {
  appendFileSync(input.log, String(context.attempt) + "\\n");
  if (context.attempt < 3) throw new Error("not yet");
  return context.attempt;
};
export const broken = (input) => {
  appendFileSync(input.log, "call\\n");
  throw new Error("always");
};
export const badInspection = (input) => {
  appendFileSync(input.log, "call\\n");
  return { status: 1 };
};
export const goodInspection = () => ({ status: "ok" });
export const rawCount = () => ({ n: "7" });
export const boom = () => { throw new Error("x".repeat(700)); };
`;

const setupRoot = (): string => {
  const root = makeRoot();
  writeFile(root, "fns/helpers.ts", helpers);
  writeFile(
    root,
    "schemas.ts",
    `import { z } from "${zodUrl}";\nexport const schemas = {\n  inspection: z.object({ status: z.string() }),\n  counted: z.object({ n: z.coerce.number(), tag: z.string().default("none") }),\n  boom: z.any().superRefine(() => { throw new Error("user boom"); }),\n};\n`,
  );
  return root;
};

describe("output schemas", () => {
  test("SC39 — output that fails its schema fails the node without a retry", async () => {
    const root = setupRoot();
    const log = join(root, "calls");
    const schema =
      "\n    retry: { maxAttempts: 3 }\n    output: { module: ./schemas.ts, zodSchema: inspection }";
    const bad = await runLeaf(root, fnLines("./fns/helpers.ts", "badInspection", schema), { log });
    expect(bad).toMatchObject({ status: "failed", attempts: 1, error: { kind: "validation" } });
    expect(lines(log)).toHaveLength(1);
    const good = await runLeaf(root, fnLines("./fns/helpers.ts", "goodInspection", schema));
    expect(good.status).toBe("completed");
  });

  test("a script whose output fails its schema keeps its process record", async () => {
    const record = await runLeaf(
      setupRoot(),
      "    type: exec\n    runtime: sh\n    script: echo '{\"status\":1}'\n    input: null\n    output: { module: ./schemas.ts, zodSchema: inspection }",
    );
    expect(record).toMatchObject({ status: "failed", error: { kind: "validation" } });
    expect(record.process).toEqual({ stdout: '{"status":1}\n', stderr: "", exitCode: 0 });
  });

  test("a script whose schema throws records the schema's own stack", async () => {
    const record = await runLeaf(
      setupRoot(),
      "    type: exec\n    runtime: sh\n    script: echo '{}'\n    input: null\n    output: { module: ./schemas.ts, zodSchema: boom }",
    );
    expect(record).toMatchObject({
      status: "failed",
      error: { kind: "exception", message: "user boom" },
    });
    expect(record.error?.stack).toContain("schemas.ts");
    expect(record.process?.exitCode).toBe(0);
  });

  test("SC40 — a schema missing from its module fails compilation, naming the schema", async () => {
    const root = setupRoot();
    const missing = (module: string) =>
      fnLines(
        "./fns/helpers.ts",
        "goodInspection",
        `\n    output: { module: ${module}, zodSchema: nope }`,
      );
    await expect(compileNode(root, missing("./schemas.ts"))).rejects.toMatchObject({
      code: "missing-schema",
      message: expect.stringContaining("nope"),
    });
    await expect(compileNode(root, missing("./missing.ts"))).rejects.toBeInstanceOf(WorkflowError);
  });

  test("a schema only checks a script's output: the raw JSON it printed is stored", async () => {
    const record = await runLeaf(
      setupRoot(),
      '    type: exec\n    runtime: sh\n    script: echo \'{"n":"5"}\'\n    input: null\n    output: { module: ./schemas.ts, zodSchema: counted }',
    );
    expect(record).toMatchObject({ status: "completed", output: { n: "5" } });
    expect(record.process?.stdout).toBe('{"n":"5"}\n');
  });

  test("a schema only checks a function's output: the value it returned is stored", async () => {
    const record = await runLeaf(
      setupRoot(),
      fnLines(
        "./fns/helpers.ts",
        "rawCount",
        "\n    output: { module: ./schemas.ts, zodSchema: counted }",
      ),
    );
    expect(record).toMatchObject({ status: "completed", output: { n: "7" } });
    expect(record.process).toBeUndefined();
  });

  test("a function with the built-in Json schema keeps its value as returned", async () => {
    const record = await runLeaf(
      setupRoot(),
      fnLines("./fns/helpers.ts", "rawCount", "\n    output: { zodSchema: Json }"),
    );
    expect(record).toMatchObject({ status: "completed", output: { n: "7" } });
  });
});

describe("waits and retry", () => {
  test("SC41 — a wait sleeps for its duration and passes its input through", async () => {
    const started = Date.now();
    const record = await runLeaf(
      makeRoot(),
      "    type: wait\n    durationMs: 100\n    input: null",
      {
        a: 1,
      },
    );
    expect(record).toMatchObject({ status: "completed", output: { a: 1 } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("SC43 — a retried node succeeds on a later attempt", async () => {
    const root = setupRoot();
    const log = join(root, "attempts");
    const started = Date.now();
    const record = await runLeaf(
      root,
      fnLines("./fns/helpers.ts", "flaky", "\n    retry: { maxAttempts: 3, delayMs: 50 }"),
      { log },
    );
    expect(record).toMatchObject({ status: "completed", attempts: 3 });
    expect(lines(log)).toEqual(["1", "2", "3"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("SC44 — a node without retry runs once", async () => {
    const root = setupRoot();
    const log = join(root, "calls");
    const record = await runLeaf(root, fnLines("./fns/helpers.ts", "broken"), { log });
    expect(record).toMatchObject({ status: "failed", attempts: 1 });
    expect(lines(log)).toHaveLength(1);
  });

  test("a failed node keeps the stack of the error it threw, not of the code that caught it", async () => {
    const record = await runLeaf(setupRoot(), fnLines("./fns/helpers.ts", "boom"));
    expect(record.error?.stack).toContain("helpers.ts");
  });
});
