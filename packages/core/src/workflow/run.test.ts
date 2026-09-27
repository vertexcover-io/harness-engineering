import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Event, type JsonValue, type State, StateSchema } from "../contracts.ts";
import { jsonlEventStore, memoryEventStore } from "../event-store.ts";
import { coreHandlers, type IEventEmitter, storeEmitter } from "../events.ts";
import { projectEvents, syncState } from "../state.ts";
import { compileWorkflow } from "./compile.ts";
import { type RunOptions, runWorkflow } from "./run.ts";
import { type AgentAdapter, type AgentRequest, type RunResult, WorkflowError } from "./types.ts";

const makeRoot = (): string => mkdtempSync(join(tmpdir(), "wf-run-"));

const writeFile = (root: string, relative: string, content: string): string => {
  const file = join(root, relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
};

const run = async (
  root: string,
  source: string,
  inputs: Record<string, JsonValue> = {},
  options: RunOptions = {},
): Promise<RunResult> =>
  runWorkflow(
    await compileWorkflow(writeFile(root, "workflows/main.yml", source), { cwd: root }),
    inputs,
    {
      cwd: root,
      ...options,
    },
  );

const runRejection = async (
  root: string,
  source: string,
  inputs: Record<string, JsonValue> = {},
): Promise<WorkflowError> => {
  try {
    await run(root, source, inputs);
  } catch (error) {
    if (error instanceof WorkflowError) return error;
    throw error;
  }
  throw new Error("expected runWorkflow to reject");
};

const node = (result: RunResult, path: string) => {
  const record = result.nodes[path];
  if (record === undefined) throw new Error(`no record for ${path}`);
  return record;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("exec scripts", () => {
  test("SC15 — a two-node script workflow passes typed JSON from one node to the next", async () => {
    const root = makeRoot();
    const result = await run(
      root,
      `name: pipe
inputs:
  n: { type: number, required: true }
nodes:
  - id: first
    type: exec
    runtime: sh
    script: cat
    input: { n: "{{ inputs.n }}" }
    output: { format: json }
  - id: second
    type: exec
    runtime: bun
    dependsOn: [first]
    input: "{{ nodes.first.output.value }}"
    output: { format: json }
    script: |
      const input = JSON.parse(await Bun.stdin.text());
      console.log(JSON.stringify(input.n + 1));
`,
      { n: 41 },
    );
    expect(result.status).toBe("completed");
    expect(node(result, "first").output).toEqual({
      stdout: '{"n":41}',
      stderr: "",
      exitCode: 0,
      value: { n: 41 },
    });
    expect((node(result, "second").output as { value: JsonValue }).value).toBe(42);
    for (const path of ["first", "second"]) {
      const record = node(result, path);
      expect(record.status).toBe("completed");
      expect(record.attempts).toBe(1);
      expect(record.startedAt ?? 0).toBeLessThanOrEqual(record.endedAt ?? 0);
    }
    expect(node(result, "first").input).toEqual({ n: 41 });
  });

  test("SC16 — script stdout that is not JSON fails a json-format node", async () => {
    const result = await run(
      makeRoot(),
      "name: t\nnodes:\n  - id: a\n    type: exec\n    runtime: sh\n    script: echo not json\n    input: null\n    output: { format: json }\n",
    );
    expect(node(result, "a").status).toBe("failed");
    expect(node(result, "a").error?.kind).toBe("validation");
  });

  test("SC17 — a nonzero exit fails the node, keeps its output and cancels later nodes", async () => {
    const result = await run(
      makeRoot(),
      `name: t
nodes:
  - id: check
    type: exec
    runtime: sh
    script: "echo boom >&2; exit 3"
    input: null
  - id: after
    type: exec
    runtime: sh
    script: "true"
    dependsOn: [check]
    input: null
`,
    );
    expect(node(result, "check").status).toBe("failed");
    expect(node(result, "check").error?.kind).toBe("exit");
    expect(node(result, "check").output).toEqual({ stdout: "", stderr: "boom\n", exitCode: 3 });
    expect(node(result, "after").status).toBe("cancelled");
    expect(node(result, "after").attempts).toBe(0);
    expect(result.status).toBe("failed");
  });

  test("SC18 — a timeout kills the script and every process it started", async () => {
    const root = makeRoot();
    const pidFile = join(root, "pid");
    const started = Date.now();
    const result = await run(
      root,
      `name: t
nodes:
  - id: slow
    type: exec
    runtime: sh
    script: "sleep 30 & echo $! > ${pidFile}; wait"
    timeoutMs: 200
    input: null
`,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(node(result, "slow").status).toBe("failed");
    expect(node(result, "slow").error?.kind).toBe("timeout");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const deadline = Date.now() + 1000;
    while (isAlive(pid) && Date.now() < deadline) await Bun.sleep(20);
    expect(isAlive(pid)).toBe(false);
  });

  test("SC19 — output past 1 MiB is cut off and the node still completes", async () => {
    const result = await run(
      makeRoot(),
      `name: t
nodes:
  - id: loud
    type: exec
    runtime: bun
    input: null
    script: |
      process.stdout.write("a".repeat(1_200_000));
      process.stderr.write("b".repeat(1_200_000));
`,
    );
    const record = node(result, "loud");
    expect(record.status).toBe("completed");
    const output = record.output as { stdout: string; stderr: string };
    expect(output.stdout).toBe("a".repeat(1_048_576));
    expect(output.stderr).toBe("b".repeat(1_048_576));
  });
});

describe("exec functions", () => {
  const echoModule = `
const echo = (input, context) => ({ input, context: { path: context.path, cwd: context.cwd, attempt: context.attempt } });
export { echo };
export default echo;
`;

  test("SC20 — module functions resolve from the run cwd and receive input and context", async () => {
    const root = makeRoot();
    const absolute = writeFile(root, "fns/echo.ts", echoModule);
    mkdirSync(join(root, "sub"));
    const result = await run(
      root,
      `name: t
nodes:
  - id: named
    type: exec
    module: ./fns/echo.ts
    functionName: echo
    cwd: sub
    input: { value: 1 }
  - id: fallback
    type: exec
    module: ./fns/echo.ts
    functionName: default
    input: null
  - id: absolute
    type: exec
    module: ${absolute}
    functionName: echo
    input: null
`,
    );
    expect(result.status).toBe("completed");
    expect(node(result, "named").output).toEqual({
      input: { value: 1 },
      context: { path: "named", cwd: join(root, "sub"), attempt: 1 },
    });
    expect(node(result, "fallback").status).toBe("completed");
    expect(node(result, "absolute").status).toBe("completed");
  });

  test("SC21 — a missing module or export stops the run before any node starts", async () => {
    const root = makeRoot();
    writeFile(root, "fns/echo.ts", echoModule);
    const marker = join(root, "marker");
    const source = (module: string, fn: string) => `name: t
nodes:
  - id: touch
    type: exec
    runtime: sh
    script: "touch ${marker}"
    input: null
  - id: call
    type: exec
    module: ${module}
    functionName: ${fn}
    dependsOn: [touch]
    input: null
`;
    expect((await runRejection(root, source("./fns/echo.ts", "nope"))).code).toBe("missing-export");
    expect((await runRejection(root, source("./fns/missing.ts", "echo"))).code).toBe(
      "missing-module",
    );
    expect(existsSync(marker)).toBe(false);
  });

  test("SC22 — a function returning a non-JSON value fails its node", async () => {
    const root = makeRoot();
    writeFile(root, "fns/nothing.ts", "export const nothing = () => undefined;\n");
    const result = await run(
      root,
      "name: t\nnodes:\n  - id: a\n    type: exec\n    module: ./fns/nothing.ts\n    functionName: nothing\n    input: null\n",
    );
    expect(node(result, "a").status).toBe("failed");
    expect(node(result, "a").error?.kind).toBe("validation");
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
  return { firstAborted: first.aborted, runAborted: context.signal.aborted };
};
`,
    );
    const result = await run(
      root,
      "name: t\nnodes:\n  - id: a\n    type: exec\n    module: ./fns/hang.ts\n    functionName: hang\n    timeoutMs: 20\n    retry: { maxAttempts: 2 }\n    input: null\n",
    );
    expect(node(result, "a").output).toEqual({ firstAborted: true, runAborted: false });
  });
});

describe("workflow inputs", () => {
  test("SC23 — workflow inputs get defaults, and bad inputs stop the run before any node", async () => {
    const root = makeRoot();
    writeFile(root, "fns/echo.ts", "export const echo = (input) => input;\n");
    const source = (countDefault: string) => `name: t
inputs:
  name: { type: string, required: true }
  count: { type: number, default: ${countDefault} }
nodes:
  - id: show
    type: exec
    module: ./fns/echo.ts
    functionName: echo
    input: "{{ inputs }}"
`;
    const result = await run(root, source("2"), { name: "x" });
    expect(node(result, "show").output).toEqual({ name: "x", count: 2 });
    const cases: Array<[Record<string, JsonValue>, string]> = [
      [{}, "name"],
      [{ name: 5 }, "name"],
      [{ name: "x", extra: 1 }, "extra"],
    ];
    for (const [inputs, named] of cases) {
      const error = await runRejection(root, source("2"), inputs);
      expect(error.code).toBe("input");
      expect(error.message).toContain(named);
    }
    expect((await runRejection(root, source('"two"'), { name: "x" })).code).toBe("input");
  });
});

const zodUrl = import.meta.resolve("zod");

const fnNode = (id: string, module: string, fn: string, extra = ""): string => `
  - id: ${id}
    type: exec
    module: ${module}
    functionName: ${fn}
    input: null${extra}`;

const helpers = `
import { appendFileSync } from "node:fs";
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
export const echo = (input) => input;
export const wait100 = async () => { await sleep(100); return 1; };
export const wait50 = async () => { await sleep(50); return 1; };
export const needsFix = () => ({ status: "needs-fix" });
export const odd = () => ({ status: "odd" });
export const one = () => ({ status: "1" });
export const empty = () => ({});
export const nested = () => ({ status: { a: 1 } });
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
`;

const setupRoot = (): string => {
  const root = makeRoot();
  writeFile(root, "fns/helpers.ts", helpers);
  writeFile(
    root,
    "fns/hold.ts",
    `let active = 0;\nlet peak = 0;\nexport const hold = async () => {\n  active += 1;\n  peak = Math.max(peak, active);\n  await new Promise((done) => setTimeout(done, 200));\n  active -= 1;\n  return peak;\n};\n`,
  );
  writeFile(
    root,
    "schemas.ts",
    `import { z } from "${zodUrl}";\nexport const schemas = { inspection: z.object({ status: z.string() }) };\n`,
  );
  return root;
};

const lines = (file: string): string[] =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];

describe("scheduling", () => {
  test("SC65 — nodes named after Object.prototype keys still run", async () => {
    const result = await run(
      makeRoot(),
      `name: t
nodes:
  - id: toString
    type: exec
    runtime: sh
    script: "true"
    input: null
  - id: hasOwnProperty
    type: exec
    runtime: sh
    script: "true"
    dependsOn: [toString]
    input: null
`,
    );
    expect(node(result, "toString").status).toBe("completed");
    expect(node(result, "hasOwnProperty").status).toBe("completed");
    expect(result.status).toBe("completed");
  });

  test("SC30 — independent nodes overlap up to the concurrency limit, and a run can only lower it", async () => {
    const source = `name: t\nmaxConcurrency: 2\nnodes:${["a", "b", "c"].map((id) => fnNode(id, "./fns/hold.ts", "hold")).join("")}\n`;
    const peak = async (options: RunOptions): Promise<number> => {
      const result = await run(setupRoot(), source, {}, options);
      return Math.max(...["a", "b", "c"].map((id) => node(result, id).output as number));
    };
    expect(await peak({})).toBe(2);
    expect(await peak({ maxConcurrency: 1 })).toBe(1);
    expect(await peak({ maxConcurrency: 8 })).toBe(2);
  });

  test("SC66 — a maxConcurrency that is not a positive integer stops the run before any node", async () => {
    const root = makeRoot();
    const source = `name: t\nnodes:\n  - id: touch\n    type: exec\n    runtime: sh\n    script: "touch MARKER"\n    input: null\n`;
    for (const maxConcurrency of [0, -1, 1.5, Number.NaN]) {
      const error = await run(root, source, {}, { maxConcurrency }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WorkflowError);
      expect((error as WorkflowError).code).toBe("input");
    }
    expect(existsSync(join(root, "MARKER"))).toBe(false);
  });

  test("SC31 — a dependent node starts only after its dependency ends", async () => {
    const result = await run(
      setupRoot(),
      `name: t\nnodes:${fnNode("a", "./fns/helpers.ts", "wait100")}${fnNode("b", "./fns/helpers.ts", "echo", "\n    dependsOn: [a]")}\n`,
    );
    expect(node(result, "b").startedAt ?? 0).toBeGreaterThanOrEqual(
      node(result, "a").endedAt ?? Infinity,
    );
  });

  test("SC32 — when false skips a node and its dependents but not its neighbours", async () => {
    const result = await run(
      setupRoot(),
      `name: t
inputs:
  runLint: { type: boolean, required: true }
nodes:${fnNode("lint", "./fns/helpers.ts", "echo", '\n    when: "{{ inputs.runLint }}"')}${fnNode("report", "./fns/helpers.ts", "echo", "\n    dependsOn: [lint]")}${fnNode("build", "./fns/helpers.ts", "echo")}
`,
      { runLint: false },
    );
    for (const id of ["lint", "report"]) {
      expect(node(result, id).status).toBe("skipped");
      expect(node(result, id).output).toBeUndefined();
    }
    expect(node(result, "build").status).toBe("completed");
    expect(result.status).toBe("completed");
  });

  test("SC33 — a when that is not a boolean fails the node instead of skipping it", async () => {
    const result = await run(
      setupRoot(),
      `name: t\ninputs:\n  name: { type: string, required: true }\nnodes:${fnNode("a", "./fns/helpers.ts", "echo", '\n    when: "{{ inputs.name }}"')}\n`,
      { name: "x" },
    );
    expect(node(result, "a").status).toBe("failed");
    expect(node(result, "a").error?.kind).toBe("resolution");
    expect(result.status).toBe("failed");
  });
});

const decideWorkflow = (
  inspectFn: string,
  options: { defaultCase?: boolean; cases?: string } = {},
): string => `name: t
nodes:${fnNode("inspect", "./fns/helpers.ts", inspectFn)}
  - id: decide
    type: switch
    dependsOn: [inspect]
    input: "{{ nodes.inspect.output }}"
    expression: "{{ nodes.inspect.output.status }}"
    cases:
${
  options.cases ??
  `      - id: repair
        value: needs-fix
        nodes:
          - id: fix
            type: exec
            module: ./fns/helpers.ts
            functionName: echo
            input: { fixed: true }
      - id: clean
        value: clean
        nodes:
          - id: done
            type: exec
            runtime: sh
            script: echo clean
            input: "{{ inputs }}"`
}${
  options.defaultCase === false
    ? ""
    : `
    default:
      - id: unknown
        type: exec
        module: ./fns/helpers.ts
        functionName: echo
        input: { unknown: true }`
}
  - id: publish
    type: exec
    module: ./fns/helpers.ts
    functionName: echo
    dependsOn: [decide]
    input: "{{ nodes.decide.output }}"
`;

describe("switch", () => {
  test("SC34 — a switch runs only the matching case and exposes its outputs by child id", async () => {
    const result = await run(setupRoot(), decideWorkflow("needsFix"));
    expect(node(result, "decide.repair.fix").status).toBe("completed");
    expect(
      Object.keys(result.nodes).some(
        (path) => path.startsWith("decide.clean.") || path.startsWith("decide.default."),
      ),
    ).toBe(false);
    expect(node(result, "decide").output).toEqual({ fix: { fixed: true } });
    expect(node(result, "publish").output).toEqual({ fix: { fixed: true } });
  });

  test("SC35 — an unmatched value runs the default list", async () => {
    const result = await run(setupRoot(), decideWorkflow("odd"));
    expect(node(result, "decide.default.unknown").status).toBe("completed");
    expect(node(result, "decide").output).toEqual({ unknown: { unknown: true } });
  });

  test("SC36 — an unmatched value with no default skips the switch and its dependents", async () => {
    const result = await run(setupRoot(), decideWorkflow("odd", { defaultCase: false }));
    expect(node(result, "decide").status).toBe("skipped");
    expect(node(result, "publish").status).toBe("skipped");
    expect(result.status).toBe("completed");
  });

  test("SC37 — case values match by type as well as by value", async () => {
    const cases = `      - id: first
        value: 1
        nodes:
          - id: a
            type: exec
            runtime: sh
            script: "true"
            input: null
      - id: second
        value: "2"
        nodes:
          - id: b
            type: exec
            runtime: sh
            script: "true"
            input: null`;
    const result = await run(setupRoot(), decideWorkflow("one", { cases }));
    expect(node(result, "decide.default.unknown").status).toBe("completed");
    expect(result.nodes["decide.first.a"]).toBeUndefined();
  });

  test("SC38 — a switch expression that is missing or not a scalar fails the switch", async () => {
    for (const fn of ["empty", "nested"]) {
      const result = await run(setupRoot(), decideWorkflow(fn));
      expect(node(result, "decide").status).toBe("failed");
      expect(node(result, "decide").error?.kind).toBe("resolution");
      expect(Object.keys(result.nodes).some((path) => path.startsWith("decide."))).toBe(false);
    }
  });
});

describe("output schemas", () => {
  test("SC39 — output that fails its schema fails the node without a retry", async () => {
    const root = setupRoot();
    const log = join(root, "calls");
    const source = (fn: string) => `name: t
nodes:
  - id: inspect
    type: exec
    module: ./fns/helpers.ts
    functionName: ${fn}
    input: { log: ${JSON.stringify(log)} }
    retry: { maxAttempts: 3 }
    output: { module: ./schemas.ts, zodSchema: inspection }
`;
    const bad = await run(root, source("badInspection"));
    expect(node(bad, "inspect").status).toBe("failed");
    expect(node(bad, "inspect").error?.kind).toBe("validation");
    expect(node(bad, "inspect").attempts).toBe(1);
    expect(lines(log)).toHaveLength(1);
    const good = await run(root, source("goodInspection"));
    expect(node(good, "inspect").status).toBe("completed");
  });

  test("SC40 — a schema missing from its module stops the run before any node", async () => {
    const root = setupRoot();
    const marker = join(root, "marker");
    const source = (module: string) => `name: t
nodes:
  - id: touch
    type: exec
    runtime: sh
    script: "touch ${marker}"
    input: null${fnNode("inspect", "./fns/helpers.ts", "goodInspection", `\n    dependsOn: [touch]\n    output: { module: ${module}, zodSchema: nope }`)}
`;
    expect((await runRejection(root, source("./schemas.ts"))).code).toBe("missing-schema");
    expect((await runRejection(root, source("./missing.ts"))).code).toBe("missing-module");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("waits, failure and retry", () => {
  test("SC41 — a wait passes its input through and leaves its slot free", async () => {
    const result = await run(
      setupRoot(),
      `name: t
maxConcurrency: 1
nodes:
  - id: cooldown
    type: wait
    durationMs: 300
    input: { a: 1 }${fnNode("quick", "./fns/helpers.ts", "wait50")}
`,
    );
    const cooldown = node(result, "cooldown");
    expect(node(result, "quick").endedAt ?? Infinity).toBeLessThan(cooldown.endedAt ?? 0);
    expect(cooldown.output).toEqual({ a: 1 });
    expect((cooldown.endedAt ?? 0) - (cooldown.startedAt ?? 0)).toBeGreaterThanOrEqual(300);
  });

  test("SC42 — the first failure cancels running work, timers and unstarted nodes", async () => {
    const started = Date.now();
    const result = await run(
      setupRoot(),
      `name: t
nodes:
  - id: bad
    type: exec
    runtime: sh
    script: "exit 1"
    input: null
  - id: slow
    type: exec
    runtime: sh
    script: "sleep 5"
    input: null
  - id: cooldown
    type: wait
    durationMs: 5000
    input: null
  - id: after
    type: exec
    runtime: sh
    script: "true"
    dependsOn: [slow]
    input: null
`,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(node(result, "bad").status).toBe("failed");
    for (const id of ["slow", "cooldown", "after"])
      expect(node(result, id).status).toBe("cancelled");
    expect(result.status).toBe("failed");
  });

  test("SC43 — a retried node succeeds on a later attempt", async () => {
    const root = setupRoot();
    const log = join(root, "attempts");
    const started = Date.now();
    const result = await run(
      root,
      `name: t\nnodes:${fnNode("flaky", "./fns/helpers.ts", "flaky").replace("input: null", `input: { log: ${JSON.stringify(log)} }`)}\n    retry: { maxAttempts: 3, delayMs: 50 }\n`,
    );
    expect(node(result, "flaky").status).toBe("completed");
    expect(node(result, "flaky").attempts).toBe(3);
    expect(lines(log)).toEqual(["1", "2", "3"]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("SC44 — a node without retry runs once", async () => {
    const root = setupRoot();
    const log = join(root, "calls");
    const result = await run(
      root,
      `name: t\nnodes:${fnNode("broken", "./fns/helpers.ts", "broken").replace("input: null", `input: { log: ${JSON.stringify(log)} }`)}\n`,
    );
    expect(node(result, "broken").status).toBe("failed");
    expect(node(result, "broken").attempts).toBe(1);
    expect(lines(log)).toHaveLength(1);
  });

  test("SC45 — aborting the caller's signal cancels the run", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = Date.now();
    const result = await run(
      setupRoot(),
      `name: t\nnodes:\n  - id: slow\n    type: exec\n    runtime: sh\n    script: "sleep 5"\n    input: null\n`,
      {},
      { signal: controller.signal },
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(node(result, "slow").status).toBe("cancelled");
    expect(node(result, "slow").error?.kind).toBe("aborted");
    expect(result.status).toBe("failed");
  });
});

const publishReport = `name: publish-report
inputs:
  report: { type: object, required: true }
  format: { type: string, default: md }
nodes:
  - id: render
    type: exec
    module: ./fns/helpers.ts
    functionName: echo
    input: "{{ inputs }}"
`;

const includeWorkflow = (input: string, when = ""): string => `name: t
inputs:
  publish: { type: boolean, default: true }
nodes:
  - id: publish
    type: include
    workflow: ./publish-report.yml
    input: ${input}${when}
`;

describe("includes", () => {
  test("SC52 — an include runs the named workflow and exposes its child outputs", async () => {
    const root = setupRoot();
    writeFile(root, "publish-report.yml", publishReport);
    const result = await run(root, includeWorkflow("{ report: { passed: true } }"));
    const expected = { report: { passed: true }, format: "md" };
    expect(node(result, "publish.render").status).toBe("completed");
    expect(node(result, "publish.render").input).toEqual(expected);
    expect(node(result, "publish").output).toEqual({ render: expected });
  });

  test("SC53 — include input that breaks the included declarations fails the include node", async () => {
    const root = setupRoot();
    writeFile(root, "publish-report.yml", publishReport);
    const result = await run(root, includeWorkflow("{ format: md }"));
    expect(node(result, "publish").status).toBe("failed");
    expect(node(result, "publish").error?.kind).toBe("validation");
    expect(result.nodes["publish.render"]?.status).not.toBe("completed");
  });

  test("SC54 — when false on an include skips every child", async () => {
    const root = setupRoot();
    writeFile(root, "publish-report.yml", publishReport);
    const result = await run(
      root,
      includeWorkflow("{ report: {} }", '\n    when: "{{ inputs.publish }}"'),
      { publish: false },
    );
    expect(node(result, "publish").status).toBe("skipped");
    expect(Object.keys(result.nodes).some((path) => path.startsWith("publish."))).toBe(false);
  });
});

const loopHelpers = `
export const attempt = (input) => ({ passed: input.index >= 3, index: input.index, previous: input.previous });
export const never = () => ({ passed: false });
`;

const loopWorkflow = (fn: string, maxIterations: number, child?: string): string => `name: t
nodes:
  - id: fix
    type: loop
    maxIterations: ${maxIterations}
    until: "{{ iteration.nodes.attempt.output.passed }}"
    input: null
    nodes:
${
  child ??
  `      - id: attempt
        type: exec
        module: ./fns/loop.ts
        functionName: ${fn}
        input: { index: "{{ iteration.index }}", previous: "{{ iteration.previous }}" }`
}
`;

describe("loops", () => {
  test("SC55 — a loop repeats until until holds and exposes the last pass", async () => {
    const root = setupRoot();
    writeFile(root, "fns/loop.ts", loopHelpers);
    const result = await run(root, loopWorkflow("attempt", 5));
    for (const pass of [1, 2, 3])
      expect(node(result, `fix[${pass}].attempt`).status).toBe("completed");
    expect(result.nodes["fix[4].attempt"]).toBeUndefined();
    const third = node(result, "fix[3].attempt").output as { previous: JsonValue };
    expect(node(result, "fix").output).toEqual({
      attempt: { passed: true, index: 3, previous: third.previous },
    });
    expect(node(result, "fix[1].attempt").input).toEqual({ index: 1, previous: null });
    expect((node(result, "fix[2].attempt").input as { previous: JsonValue }).previous).toEqual({
      attempt: { passed: false, index: 1, previous: null },
    });
  });

  test("SC56 — a loop whose until never holds fails as exhausted", async () => {
    const root = setupRoot();
    writeFile(root, "fns/loop.ts", loopHelpers);
    const result = await run(root, loopWorkflow("never", 2));
    expect(node(result, "fix").status).toBe("failed");
    expect(node(result, "fix").error?.kind).toBe("exhausted");
    expect(node(result, "fix").attempts).toBe(2);
    expect(result.status).toBe("failed");
  });

  test("SC57 — a failing child ends the loop and the run", async () => {
    const child = `      - id: attempt
        type: exec
        runtime: sh
        script: "exit 1"
        input: null`;
    const result = await run(setupRoot(), loopWorkflow("", 3, child));
    expect(node(result, "fix[1].attempt").status).toBe("failed");
    expect(node(result, "fix").status).toBe("failed");
    expect(Object.keys(result.nodes).some((path) => path.startsWith("fix[2]."))).toBe(false);
    expect(result.status).toBe("failed");
  });
});

const fakeAdapter = () => {
  const requests: AgentRequest[] = [];
  const adapter: AgentAdapter = {
    run: async (request) => {
      requests.push(request);
      return { ok: true };
    },
  };
  return { adapter, requests };
};

const agentWorkflow = (adapter: string) => `name: t
inputs:
  task: { type: string, default: build }
nodes:
  - id: touch
    type: exec
    runtime: sh
    script: "touch MARKER"
    input: null
  - id: implement
    type: agent
    adapter: ${adapter}
    stage: implement
    dependsOn: [touch]
    input: "{{ inputs }}"
`;

describe("agents", () => {
  test("SC58 — an agent node reaches its adapter with its request", async () => {
    const { adapter, requests } = fakeAdapter();
    const result = await run(
      setupRoot(),
      agentWorkflow("default"),
      {},
      { agents: { default: adapter } },
    );
    const [request] = requests;
    expect(request?.stage).toBe("implement");
    expect(request?.input).toEqual({ task: "build" });
    expect(request?.context.path).toBe("implement");
    expect(request?.context.attempt).toBe(1);
    expect(request !== undefined && "prompt" in request).toBe(false);
    expect(node(result, "implement").output).toEqual({ ok: true });
  });

  test("SC64 — an agent timeout aborts the signal it gave that attempt before the retry", async () => {
    const signals: AbortSignal[] = [];
    const adapter: AgentAdapter = {
      run: async (request) => {
        signals.push(request.context.signal);
        if (request.context.attempt === 1) return new Promise(() => undefined);
        return { firstAborted: signals[0]?.aborted ?? false };
      },
    };
    const source = agentWorkflow("default").replace(
      "stage: implement",
      "stage: implement\n    timeoutMs: 20\n    retry: { maxAttempts: 2 }",
    );
    const result = await run(setupRoot(), source, {}, { agents: { default: adapter } });
    expect(node(result, "implement").output).toEqual({ firstAborted: true });
  });

  test("SC59 — a missing adapter stops the run before any node", async () => {
    const root = setupRoot();
    const source = agentWorkflow("ghost");
    const missing = await runWorkflow(
      await compileWorkflow(writeFile(root, "a.yml", source), { cwd: root }),
      {},
      { cwd: root },
    ).catch((e) => e);
    expect(missing).toBeInstanceOf(WorkflowError);
    expect(missing.code).toBe("missing-adapter");
    expect(existsSync(join(root, "MARKER"))).toBe(false);
  });
});

const eventsWorkflow = `name: t
nodes:
  - id: a
    type: exec
    runtime: sh
    script: echo hi
    input: null
  - id: l
    type: loop
    dependsOn: [a]
    maxIterations: 3
    until: "{{ iteration.nodes.x.output.passed }}"
    input: null
    nodes:
      - id: x
        type: exec
        module: ./fns/twice.ts
        functionName: twice
        input: { index: "{{ iteration.index }}" }
`;

const eventsRoot = (): string => {
  const root = makeRoot();
  writeFile(
    root,
    "fns/twice.ts",
    "export const twice = (input) => ({ passed: input.index >= 2 });\n",
  );
  return root;
};

const statuses = (result: RunResult): Record<string, string> =>
  Object.fromEntries(Object.entries(result.nodes).map(([path, r]) => [path, r.status]));

const typesFor = (events: readonly Event[], nodeRunId: string): string[] =>
  events.filter((e) => e.nodeRunId === nodeRunId).map((e) => e.type);

describe("node events", () => {
  test("SC10: a run emits started then one end event for every node, children before their container", async () => {
    const store = memoryEventStore();
    const root = eventsRoot();
    const result = await run(
      root,
      eventsWorkflow,
      {},
      { emitter: storeEmitter(store, { runId: "r-1" }) },
    );
    const events = await store.read();
    for (const path of ["a", "l", "l[1].x", "l[2].x"])
      expect(typesFor(events, path)).toEqual(["workflow.node.started", "workflow.node.completed"]);
    const endSeq = (path: string) =>
      events.find((e) => e.nodeRunId === path && e.type === "workflow.node.completed")?.seq ?? 0;
    expect(endSeq("l[1].x")).toBeLessThan(endSeq("l"));
    expect(endSeq("l[2].x")).toBeLessThan(endSeq("l"));
    expect(events.every((e) => e.source === "workflow")).toBe(true);
    expect(events.find((e) => e.nodeRunId === "l[2].x")?.nodeId).toBe("x");
    expect(statuses(result)).toEqual(statuses(await run(eventsRoot(), eventsWorkflow)));
  });

  test("SC11: a node whose when is false emits only a skipped event with 0 attempts", async () => {
    const store = memoryEventStore();
    await run(
      makeRoot(),
      'name: t\nnodes:\n  - id: b\n    type: exec\n    runtime: sh\n    script: echo hi\n    input: null\n    when: "{{ false }}"\n',
      {},
      { emitter: storeEmitter(store, { runId: "r-1" }) },
    );
    const events = await store.read();
    expect(events.map((e) => e.type)).toEqual(["workflow.node.skipped"]);
    expect(events[0]?.payload).toMatchObject({ attempts: 0 });
  });

  const twoSteps = (root: string): string =>
    `name: t\nnodes:\n  - id: a\n    type: exec\n    runtime: sh\n    script: echo a\n    input: null\n  - id: b\n    type: exec\n    runtime: sh\n    dependsOn: [a]\n    script: touch ${join(root, "B_RAN")}\n    input: null\n`;

  const failingEmitter = (failOn: number, fail: () => ReturnType<IEventEmitter["emit"]>) => {
    const inner = storeEmitter(memoryEventStore(), { runId: "r-1" });
    let calls = 0;
    const emitter: IEventEmitter = {
      emit: (input) => {
        calls += 1;
        return calls === failOn ? fail() : inner.emit(input);
      },
    };
    return { emitter, calls: () => calls };
  };

  test("SC12: an emitter that refuses the second event stops the run, which rejects with its error", async () => {
    const root = makeRoot();
    const { emitter, calls } = failingEmitter(2, async () => ({ ok: false, error: "disk full" }));
    const rejection = await run(root, twoSteps(root), {}, { emitter }).then(
      () => new Error("expected a rejection"),
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(WorkflowError);
    expect((rejection as WorkflowError).code).toBe("event-lost");
    expect(String(rejection)).toContain("disk full");
    expect(String(rejection)).toContain("workflow.node.completed");
    expect(existsSync(join(root, "B_RAN"))).toBe(false);
    expect(calls()).toBe(2);
  });

  test("SC13: an emitter that throws stops the run, which rejects instead of recording a failed node", async () => {
    const root = makeRoot();
    const { emitter } = failingEmitter(1, async () => {
      throw new Error("socket closed");
    });
    const rejection = await run(root, twoSteps(root), {}, { emitter }).then(
      () => new Error("expected a rejection"),
      (error: unknown) => error,
    );
    expect(String(rejection)).toContain("socket closed");
    expect((rejection as Error).cause).toBeInstanceOf(Error);
    expect(((rejection as Error).cause as Error).message).toBe("socket closed");
    expect(existsSync(join(root, "B_RAN"))).toBe(false);
  });

  test("SC14: a run's events in event.jsonl build a valid state.json with every node completed", async () => {
    const taskDir = makeRoot();
    const store = jsonlEventStore(taskDir);
    await run(eventsRoot(), eventsWorkflow, {}, { emitter: storeEmitter(store, { runId: "r-1" }) });
    const state = await syncState({ taskDir, store, seed: stateSeed, handlers: coreHandlers });
    expect(
      StateSchema.safeParse(JSON.parse(readFileSync(join(taskDir, "state.json"), "utf8"))).success,
    ).toBe(true);
    expect(
      Object.fromEntries(Object.values(state.nodeRuns).map((r) => [r.nodeRunId, r.status])),
    ).toEqual({
      a: "completed",
      l: "completed",
      "l[1].x": "completed",
      "l[2].x": "completed",
    });
    expect(state.activeNodeRuns).toEqual([]);
    expect(state.lastEventSeq).toBe(8);
    expect((await store.read()).every((e) => e.runId === "r-1")).toBe(true);
  });

  test("a node cancelled by a failed dependency emits only a cancelled event, projected as cancelled", async () => {
    const store = memoryEventStore();
    await run(
      makeRoot(),
      "name: t\nnodes:\n  - id: a\n    type: exec\n    runtime: sh\n    script: exit 1\n    input: null\n  - id: b\n    type: exec\n    runtime: sh\n    dependsOn: [a]\n    script: echo b\n    input: null\n",
      {},
      { emitter: storeEmitter(store, { runId: "r-1" }) },
    );
    const events = await store.read();
    expect(typesFor(events, "b")).toEqual(["workflow.node.cancelled"]);
    const state = projectEvents({ state: stateSeed, events, handlers: coreHandlers });
    expect(state.nodeRuns.b?.status).toBe("cancelled");
  });

  test("a failed node's event keeps a message cut to 500 characters and the stack of the error it threw", async () => {
    const root = makeRoot();
    writeFile(
      root,
      "fns/boom.ts",
      'export const boom = () => { throw new Error("x".repeat(700)); };\n',
    );
    const store = memoryEventStore();
    await run(
      root,
      "name: t\nnodes:\n  - id: a\n    type: exec\n    module: ./fns/boom.ts\n    functionName: boom\n    input: null\n",
      {},
      { emitter: storeEmitter(store, { runId: "r-1" }) },
    );
    const failed = (await store.read()).find((e) => e.type === "workflow.node.failed");
    expect(failed?.payload).toMatchObject({
      error: {
        message: expect.stringMatching(/^[\s\S]{1,500}$/),
        stack: expect.stringContaining("boom.ts"),
      },
    });
  });
});

const stateSeed: State = {
  schemaVersion: 1,
  lastEventSeq: 0,
  specName: "add-login",
  harnessVersion: "2.0.0",
  workflow: { name: "feature", path: "workflow.yaml" },
  input: {},
  scope: "feature",
  options: {},
  startedAt: "2026-09-26T10:00:00Z",
  completedAt: null,
  outcome: null,
  currentFile: null,
  workspace: {
    path: "/work",
    repositories: {
      app: { path: "/work", git: { branch: "b", baseBranch: "main", startSha: "a" } },
    },
  },
  activeNodeRuns: [],
  nodeRuns: {},
};
