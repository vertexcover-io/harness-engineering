import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import type { FireDeps, LifecyclePayload } from "./hooks.ts";
import { buildPayload, loadHooks, notifierHook, parseFireArgv, runDoctor, runFire } from "./hooks.ts";
import { formatMessage, loadConfig, slackText } from "./notify.ts";
import type { Message, Provider } from "./notify.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "hooks-test-"));

const writeConfig = (dir: string, config: Readonly<Record<string, unknown>>): void => {
  writeFileSync(join(dir, "orchestrate.config.json"), JSON.stringify(config));
};

type ExecStep = { readonly exit?: number; readonly stdout?: string; readonly stderr?: string; readonly delayMs?: number };

const makeFakeExec = (script: readonly ExecStep[]) => {
  const calls: { readonly cmd: string; readonly input: string; readonly timeoutMs: number }[] = [];
  let i = 0;
  const exec: FireDeps["exec"] = (cmd, opts) => {
    calls.push({ cmd, input: opts.input, timeoutMs: opts.timeoutMs });
    const step = script[i] ?? {};
    i += 1;
    if (step.delayMs !== undefined) {
      const until = Date.now() + step.delayMs;
      while (Date.now() < until) {
        // busy-wait: simulates a synchronous cmd that overruns its timeout
      }
    }
    return { exit: step.exit ?? 0, stdout: step.stdout ?? "", stderr: step.stderr ?? "" };
  };
  return { exec, calls };
};

const seedManifest = (root: string, spec: string, thread: string | null = null): string => {
  const artifactDir = join(root, ".harness", spec);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(
    join(artifactDir, "manifest.json"),
    JSON.stringify({ spec_name: spec, thread, pr_number: null, stages: {} }, null, 2),
  );
  return artifactDir;
};

const manifestOf = (root: string, spec: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, ".harness", spec, "manifest.json"), "utf8")) as Record<string, unknown>;

const seedThread = (root: string, spec: string, ts = "999.1"): string => seedManifest(root, spec, ts);

const baseDeps = (cwd: string, overrides: Partial<FireDeps> = {}): FireDeps => ({
  exec: () => ({ exit: 0, stdout: "", stderr: "" }),
  importModule: async () => ({}),
  cwd,
  ...overrides,
});

test("SC1: a hook whose when matches runs; one that does not is skipped silently", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "stage-completed": [
        { name: "a", when: { stage: "coder" }, cmd: "printf a" },
        { name: "b", when: { stage: "verify" }, cmd: "printf b" },
      ],
    },
  });
  const { exec } = makeFakeExec([{ stdout: "a-out" }]);
  const { out } = await runFire({ event: "stage-completed", stage: "coder" }, baseDeps(dir, { exec }));
  assert.equal("a" in (out.results ?? {}), true);
  assert.equal("b" in (out.results ?? {}), false);
});

test("SC2: hooks on one event run in declared order", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "run-completed": [
        { name: "first", cmd: "printf 1" },
        { name: "second", cmd: "printf 2" },
        { name: "third", cmd: "printf 3" },
      ],
    },
  });
  const { exec, calls } = makeFakeExec([{ stdout: "1" }, { stdout: "2" }, { stdout: "3" }]);
  const { out } = await runFire({ event: "run-completed" }, baseDeps(dir, { exec }));
  assert.deepEqual(calls.map((c) => c.cmd), ["printf 1", "printf 2", "printf 3"]);
  assert.deepEqual(Object.keys(out.results ?? {}), ["first", "second", "third"]);
});

test("SC3: a cmd hook receives the payload on stdin", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: { "artifact-created": [{ name: "notify", cmd: "printf ok" }] },
  });
  const { exec, calls } = makeFakeExec([{ stdout: "ok" }]);
  await runFire(
    { event: "artifact-created", kind: "pr", data: { url: "X" } },
    baseDeps(dir, { exec }),
  );
  const stdin: { event: string; kind: string; data: { url: string } } = JSON.parse(calls[0]?.input ?? "{}");
  assert.equal(stdin.event, "artifact-created");
  assert.equal(stdin.kind, "pr");
  assert.equal(stdin.data.url, "X");
});

test("SC4: an fn hook is imported and called with the payload", async () => {
  const dir = tmp();
  const fixture = join(dir, "fixture-fn.mjs");
  writeFileSync(
    fixture,
    'export const calls = [];\nexport const onEvent = async (payload) => { calls.push(payload); return "handled"; };\n',
  );
  writeConfig(dir, {
    hooks: {
      "run-completed": [{ name: "onEvent", fn: { module: fixture, export: "onEvent" }, report: true }],
    },
  });
  const importModule: FireDeps["importModule"] = (path) => import(pathToFileURL(path).href);
  const { out } = await runFire({ event: "run-completed" }, baseDeps(dir, { importModule }));
  const mod: { calls: { event: string }[] } = await import(pathToFileURL(fixture).href);
  assert.equal(mod.calls.length, 1);
  assert.equal(mod.calls[0]?.event, "run-completed");
  assert.equal(out.results?.["onEvent"]?.status, "success");
  assert.equal(out.results?.["onEvent"]?.result, "handled");
});

test("SC5: a required blocking failure halts", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "run-completed": [
        { name: "first", cmd: "false", required: true },
        { name: "second", cmd: "printf never" },
      ],
    },
  });
  const { exec, calls } = makeFakeExec([{ exit: 2, stderr: "boom" }, { stdout: "never" }]);
  const { out, halt } = await runFire({ event: "run-completed" }, baseDeps(dir, { exec }));
  assert.equal(out.status, "halt");
  assert.match(halt ?? "", /HOOK_HALT first/);
  assert.equal(out.results?.["first"]?.status, "failure");
  assert.equal(calls.length, 1);
});

test("SC6: an unrequired blocking failure warns and continues", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "run-completed": [
        { name: "first", cmd: "false" },
        { name: "second", cmd: "printf ok" },
      ],
    },
  });
  const { exec } = makeFakeExec([{ exit: 2, stderr: "boom" }, { stdout: "ok" }]);
  const { out } = await runFire({ event: "run-completed" }, baseDeps(dir, { exec }));
  assert.equal(out.results?.["first"]?.status, "failure");
  assert.match(out.results?.["first"]?.result ?? "", /2/);
  assert.equal(out.results?.["second"]?.status, "success");
});

test("SC7: a nameless hook is skipped, keyed by its position", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "stage-completed": [{ cmd: "printf nope" }, { name: "ping", cmd: "printf pong" }],
    },
  });
  const { exec, calls } = makeFakeExec([{ stdout: "pong" }]);
  const { out } = await runFire({ event: "stage-completed" }, baseDeps(dir, { exec }));
  assert.equal(out.results?.["stage-completed#0"]?.status, "skipped");
  assert.equal(out.results?.["ping"]?.status, "success");
  assert.equal(calls.length, 1);
});

test("SC8: a prompt hook is emitted, never executed", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "stage-completed": [{ name: "review", prompt: "skills/foo.md", required: true }],
    },
  });
  const { exec, calls } = makeFakeExec([]);
  const { out } = await runFire({ event: "stage-completed", stage: "coder" }, baseDeps(dir, { exec }));
  assert.equal(calls.length, 0);
  assert.equal(out.results, undefined);
  assert.equal(out.prompts?.length, 1);
  assert.equal(out.prompts?.[0]?.name, "review");
  assert.equal(out.prompts?.[0]?.prompt, "skills/foo.md");
  assert.equal(out.prompts?.[0]?.required, true);
  assert.equal(out.prompts?.[0]?.payload.stage, "coder");
});

test("SC9: a blocking hook that outlives its timeout fails under the R4 rule", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: { "run-completed": [{ name: "slow", cmd: "sleep 1", timeoutMs: 50 }] },
  });
  const { exec } = makeFakeExec([{ stdout: "late", delayMs: 90 }]);
  const { out } = await runFire({ event: "run-completed" }, baseDeps(dir, { exec }));
  assert.equal(out.results?.["slow"]?.status, "failure");
  assert.match(out.results?.["slow"]?.result ?? "", /timed out|timeout/i);
});

test("SC10: no hooks block means an empty fire", async () => {
  const dir = tmp();
  writeConfig(dir, {});
  const { out } = await runFire({ event: "run-completed" }, baseDeps(dir));
  assert.deepEqual(out, { status: "skipped" });
});

test("SC28: output is reported only when asked for, or on failure", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "run-completed": [
        { name: "a", cmd: "printf a-out", report: true },
        { name: "b", cmd: "printf b-out" },
        { name: "c", cmd: "false" },
      ],
    },
  });
  const { exec } = makeFakeExec([{ stdout: "a-out" }, { stdout: "b-out" }, { exit: 3, stderr: "bad" }]);
  const { out } = await runFire({ event: "run-completed" }, baseDeps(dir, { exec }));
  assert.equal(out.results?.["a"]?.status, "success");
  assert.equal(out.results?.["a"]?.result, "a-out");
  assert.equal(out.results?.["b"]?.status, "success");
  assert.equal("result" in (out.results?.["b"] as object), false);
  assert.equal(out.results?.["c"]?.status, "failure");
  assert.ok(out.results?.["c"]?.result);
});

test("SC11: real commands in a real repo produce the map", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, {
    hooks: {
      "stage-completed": [
        { name: "one", cmd: "printf uno" },
        { name: "two", cmd: "printf dos" },
      ],
    },
  });
  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", hooksPath, "fire", "--event", "stage-completed", "--stage", "coder"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  const out: { results: Record<string, { status: string }> } = JSON.parse(res.stdout);
  assert.equal(out.results.one?.status, "success");
  assert.equal(out.results.two?.status, "success");
});

test("SC12: an enabled notifier runs first, before the config's own hooks", async () => {
  const dir = tmp();
  writeConfig(dir, {
    notifier: { enabled: true, provider: "slack" },
    hooks: { "stage-started": [{ name: "ping", cmd: "printf pong" }] },
  });
  let sendCalls = 0;
  const importModule: FireDeps["importModule"] = async () => ({
    notifierHook: async () => {
      sendCalls += 1;
      return "sent";
    },
  });
  const { exec } = makeFakeExec([{ stdout: "pong" }]);
  const { out } = await runFire({ event: "stage-started" }, baseDeps(dir, { exec, importModule }));
  assert.deepEqual(Object.keys(out.results ?? {}), ["notifier", "ping"]);
  assert.equal(sendCalls, 1);
});

test("SC13: a disabled notifier is skipped silently — the user hook still runs", async () => {
  const dir = tmp();
  writeConfig(dir, {
    notifier: { enabled: false },
    hooks: { "stage-started": [{ name: "ping", cmd: "printf pong" }] },
  });
  const { exec } = makeFakeExec([{ stdout: "pong" }]);
  const { out } = await runFire({ event: "stage-started" }, baseDeps(dir, { exec }));
  assert.deepEqual(Object.keys(out.results ?? {}), ["ping"]);
});

test("SC14: a notifier failure never halts — a required hook after it still runs", async () => {
  const dir = tmp();
  writeConfig(dir, {
    notifier: { enabled: true, provider: "slack" },
    hooks: { "run-completed": [{ name: "gate", cmd: "printf ok", required: true }] },
  });
  const importModule: FireDeps["importModule"] = async () => ({
    notifierHook: async () => {
      throw new Error("slack down");
    },
  });
  const { exec } = makeFakeExec([{ stdout: "ok" }]);
  const { out } = await runFire({ event: "run-completed" }, baseDeps(dir, { exec, importModule }));
  assert.equal(out.results?.["notifier"]?.status, "failure");
  assert.equal(out.results?.["gate"]?.status, "success");
});

test("SC15 (regression): the six lifecycle messages match formatMessage's own output, word for word", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  const artifactDir = seedManifest(dir, "t");

  const events = [
    "run-started", "stage-started", "stage-completed",
    "question-pending", "run-interrupted", "run-completed",
  ] as const;

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    for (const event of events) {
      seedManifest(dir, "t", "999.1");
      const data =
        event === "question-pending"
          ? { title: "t", questions: [{ question: "Ship it?", answers: ["yes", "no"] }] }
          : { title: "t", body: "did the thing" };
      const payload = {
        event, stage: "coder", spec: "t", branch: "main", repoRoot: dir, artifactDir, data,
      } as LifecyclePayload;

      let captured: Message | undefined;
      const provider: Provider = {
        send: async (msg) => {
          captured = msg;
          return "1.1";
        },
        upload: async () => {},
      };
      await notifierHook(payload, provider);

      const expected = formatMessage({
        event,
        stage: "coder",
        title: "t",
        body: event === "question-pending" ? null : "did the thing",
        questions: event === "question-pending" ? [{ question: "Ship it?", answers: ["yes", "no"] }] : [],
        failure: null,
        thread: event === "run-started" ? null : "999.1",
        artifacts: [],
      });
      assert.deepEqual(captured, expected);
    }
  } finally {
    process.chdir(cwd);
  }
});

test("SC16: the thread id persists in the run's state, not in the agent", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const repoRoot = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    { cwd: dir, encoding: "utf8" },
  ).trim();
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  seedManifest(repoRoot, "t");

  const sent: Message[] = [];
  const provider: Provider = {
    send: async (msg) => {
      sent.push(msg);
      return "123.45";
    },
    upload: async () => {},
  };
  const importModule: FireDeps["importModule"] = async () => ({
    notifierHook: (payload: LifecyclePayload) => notifierHook(payload, provider),
  });

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runFire(
      { event: "run-started", spec: "t", data: { title: "t" } },
      baseDeps(dir, { importModule }),
    );
    assert.equal(manifestOf(repoRoot, "t")["thread"], "123.45");

    await runFire(
      { event: "stage-started", spec: "t", data: { title: "t" } },
      baseDeps(dir, { importModule }),
    );
  } finally {
    process.chdir(cwd);
  }
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.threadRef, null);
  assert.equal(sent[1]?.threadRef, "123.45");
});

test("SC22: artifact hooks route by kind", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "artifact-created": [
        { name: "on-pr", when: { kind: "pr" }, cmd: "printf pr" },
        { name: "on-plan", when: { kind: "plan" }, cmd: "printf plan" },
      ],
    },
  });
  const { exec, calls } = makeFakeExec([{ stdout: "pr" }]);
  const { out } = await runFire(
    { event: "artifact-created", kind: "pr", data: { url: "X" } },
    baseDeps(dir, { exec }),
  );
  assert.equal("on-pr" in (out.results ?? {}), true);
  assert.equal("on-plan" in (out.results ?? {}), false);
  assert.equal(calls.length, 1);
});

test("SC23: an unknown kind is rejected naming the legal four", () => {
  assert.throws(
    () => parseFireArgv(["--event", "artifact-created", "--kind", "tarball"]),
    /pr, commit, plan, proof-report/,
  );
});

test("SC24: doctor FAILs every illegal shape", () => {
  const fixtures: { readonly label: string; readonly hooks: Record<string, unknown>; readonly needle: string }[] = [
    { label: "unknown event", hooks: { "bogus-event": [{ name: "a", cmd: "printf x" }] }, needle: 'unknown event "bogus-event"' },
    {
      label: "two kinds on one entry",
      hooks: { "run-completed": [{ name: "a", cmd: "printf x", prompt: "skills/foo.md" }] },
      needle: "needs exactly one of fn/cmd/prompt",
    },
    { label: "missing name", hooks: { "run-completed": [{ cmd: "printf x" }] }, needle: "missing name" },
    {
      label: "duplicate name",
      hooks: { "run-completed": [{ name: "a", cmd: "printf x" }, { name: "a", cmd: "printf y" }] },
      needle: 'duplicate name "a"',
    },
    {
      label: "missing module",
      hooks: { "run-completed": [{ name: "a", fn: { module: "does-not-exist.mjs" } }] },
      needle: "fn module not found",
    },
    {
      label: "missing prompt file",
      hooks: { "run-completed": [{ name: "a", prompt: "does-not-exist.md" }] },
      needle: "prompt file not found",
    },
    {
      label: "bad when key",
      hooks: { "run-completed": [{ name: "a", cmd: "printf x", when: { bogus: "y" } }] },
      needle: "when.bogus is not a valid filter key",
    },
    {
      label: "bad when.kind",
      hooks: { "artifact-created": [{ name: "a", cmd: "printf x", when: { kind: "tarball" } }] },
      needle: 'when.kind "tarball" is outside',
    },
    {
      label: "bad timeout",
      hooks: { "run-completed": [{ name: "a", cmd: "printf x", timeoutMs: -5 }] },
      needle: "timeoutMs must be a positive number",
    },
  ];

  for (const fixture of fixtures) {
    const dir = tmp();
    writeConfig(dir, { hooks: fixture.hooks });
    const { lines, failed } = runDoctor(dir);
    assert.equal(failed, true, `${fixture.label}: expected a FAIL — got:\n${lines.join("\n")}`);
    assert.ok(
      lines.some((l) => l.includes(fixture.needle)),
      `${fixture.label}: expected a row containing "${fixture.needle}" — got:\n${lines.join("\n")}`,
    );
  }
});

test("SC25: doctor WARNs the never-fires shapes and still exits 0", () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "stage-completed": [{ name: "a", cmd: "printf x", when: { kind: "pr" } }],
      "run-completed": [{ name: "b", cmd: "printf y", when: { stage: "coder" } }],
    },
  });
  const { lines, failed } = runDoctor(dir);
  assert.equal(failed, false, lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("stage-completed/a") && l.includes("WARN") && l.includes("when.kind never fires")));
  assert.ok(lines.some((l) => l.includes("run-completed/b") && l.includes("WARN") && l.includes("when.stage never fires")));
});

test("SC26: doctor passes the shipped example", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const examplePath = fileURLToPath(
    new URL("../orchestrate/references/orchestrate.config.example.json", import.meta.url),
  );
  writeFileSync(join(dir, "orchestrate.config.json"), readFileSync(examplePath, "utf8"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "harness"), { recursive: true });
  writeFileSync(join(dir, "scripts", "page-me.sh"), "#!/bin/sh\n");
  writeFileSync(join(dir, "scripts", "teardown.sh"), "#!/bin/sh\n");
  writeFileSync(
    join(dir, "harness", "hooks.ts"),
    "export const onStageDone = async () => 'done';\nexport const linkPr = async () => 'linked';\n",
  );
  const { lines, failed } = runDoctor(dir);
  assert.equal(failed, false, lines.join("\n"));
  assert.ok(lines.every((l) => !/FAIL/.test(l)), lines.join("\n"));
});

test("SC27: doctor on a mixed real fixture", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, {
    hooks: {
      "run-completed": [{ name: "good", cmd: "printf ok" }],
      "stage-completed": [{ name: "bad", cmd: "printf nope", fn: { module: "x.mjs" } }],
      "bogus-event": [{ name: "z", cmd: "printf z" }],
    },
  });
  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));
  const res = spawnSync(process.execPath, ["--experimental-strip-types", hooksPath, "doctor"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /good\s+OK/);
  assert.match(res.stdout, /bad\s+FAIL/);
  assert.match(res.stdout, /bogus-event\s+FAIL/);
});

test("AC1: the documented example works end to end", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(
    join(dir, "fixture-link-pr.mjs"),
    "export const linkPr = async (payload) => `linked ${payload.data.url}`;\n",
  );
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "skills", "foo.md"), "# review\n");
  writeConfig(dir, {
    notifier: { enabled: false },
    hooks: {
      "stage-completed": [
        { name: "page-me", cmd: "printf paged", report: true },
        { name: "review", prompt: "skills/foo.md" },
      ],
      "artifact-created": [
        { name: "link-pr", when: { kind: "pr" }, fn: { module: "fixture-link-pr.mjs", export: "linkPr" } },
      ],
    },
  });
  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));

  const stageRes = spawnSync(
    process.execPath,
    ["--experimental-strip-types", hooksPath, "fire", "--event", "stage-completed", "--stage", "coder", "--spec", "t"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(stageRes.status, 0, stageRes.stderr);
  const stageOut: { results: Record<string, { status: string; result?: string }>; prompts: { name: string }[] } =
    JSON.parse(stageRes.stdout);
  assert.equal(stageOut.results["page-me"]?.status, "success");
  assert.equal(stageOut.results["page-me"]?.result, "paged");
  assert.equal(stageOut.prompts[0]?.name, "review");

  const artifactRes = spawnSync(
    process.execPath,
    ["--experimental-strip-types", hooksPath, "fire", "--event", "artifact-created", "--kind", "pr", "--spec", "t", "--data", '{"url":"https://x/1"}'],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(artifactRes.status, 0, artifactRes.stderr);
  const artifactOut: { results: Record<string, { status: string }> } = JSON.parse(artifactRes.stdout);
  assert.deepEqual(Object.keys(artifactOut.results ?? {}), ["link-pr"]);

  const doctorRes = spawnSync(process.execPath, ["--experimental-strip-types", hooksPath, "doctor"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(doctorRes.status, 0, doctorRes.stdout + doctorRes.stderr);
});

test("SC30: an fn hook whose export is not a function fails, and halts when required", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "run-completed": [
        { name: "typo", fn: { module: "anywhere.ts", export: "notAFunction" }, required: true },
        { name: "after", cmd: "printf never" },
      ],
    },
  });
  const importModule = async (): Promise<Record<string, unknown>> => ({ notAFunction: "a string, not a handler" });
  const { out, halt } = await runFire({ event: "run-completed" }, baseDeps(dir, { importModule }));
  assert.equal(out.results?.["typo"]?.status, "failure");
  assert.match(out.results?.["typo"]?.result ?? "", /export "notAFunction" is not a function/);
  assert.equal(out.status, "halt");
  assert.match(halt ?? "", /^HOOK_HALT typo/);
  assert.equal(out.results?.["after"], undefined);
});

test("SC31: doctor WARNs report on a prompt hook, and a stage filter on artifact-created", () => {
  const dir = tmp();
  writeFileSync(join(dir, "todo.md"), "do the thing\n");
  writeConfig(dir, {
    hooks: {
      "run-completed": [{ name: "a", prompt: "todo.md", report: true }],
      "artifact-created": [{ name: "b", cmd: "printf x", when: { stage: "coder" } }],
    },
  });
  const { lines, failed } = runDoctor(dir);
  assert.equal(failed, false, lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("run-completed/a") && l.includes("WARN") && l.includes("report on a prompt hook")));
  assert.ok(lines.some((l) => l.includes("artifact-created/b") && l.includes("WARN") && l.includes("when.stage never fires")));
});

test("SC32: a prompt hook claims its name — a later entry reusing it is skipped", async () => {
  const dir = tmp();
  writeConfig(dir, {
    hooks: {
      "stage-completed": [
        { name: "x", prompt: "todo.md" },
        { name: "x", cmd: "printf should-not-run" },
      ],
    },
  });
  const { exec, calls } = makeFakeExec([{ stdout: "should-not-run" }]);
  const { out } = await runFire({ event: "stage-completed" }, baseDeps(dir, { exec }));
  assert.equal(out.prompts?.length, 1);
  assert.equal(out.results?.["x"], undefined);
  assert.equal(out.results?.["stage-completed#1"]?.status, "skipped");
  assert.match(out.results?.["stage-completed#1"]?.result ?? "", /duplicate name "x"/);
  assert.equal(calls.length, 0);
});

test("SC33: an unknown event is invalid — one JSON line, exit 1, nothing fired", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", hooksPath, "fire", "--event", "bogus-event"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(res.status, 1, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), {
    status: "invalid",
    result: 'Unknown --event "bogus-event". Supported: run-started, stage-started, stage-completed, question-pending, run-interrupted, run-completed, artifact-created, hook-failed.',
  });
});

test("SC35: an enabled notifier does not deadlock the real CLI", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" }, hooks: {} });
  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));
  // No Slack credentials reach the child: the notifier must run and report, never send.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SLACK_")));

  for (const event of ["run-started", "stage-completed", "run-completed"]) {
    const res = spawnSync(
      process.execPath,
      ["--experimental-strip-types", hooksPath, "fire", "--event", event, "--spec", "t"],
      { cwd: dir, encoding: "utf8", timeout: 20_000, env },
    );
    assert.equal(res.status, 0, `${event}: exit ${res.status} — ${res.stderr}`);
    const out: { results?: Record<string, { status: string }> } = JSON.parse(res.stdout);
    // It ran rather than hanging. Without a token it reports failed, and never halts the fire.
    assert.ok(out.results?.["notifier"] !== undefined, `${event}: no notifier entry in ${res.stdout}`);
  }
});

test("SC36: question-pending renders every question, with or without answers", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    let captured: Message | undefined;
    const provider: Provider = {
      send: async (msg) => {
        captured = msg;
        return "1.1";
      },
      upload: async () => {},
    };
    await notifierHook(
      {
        event: "question-pending", stage: "planning", spec: "t", branch: "main", repoRoot: dir, artifactDir: seedThread(dir, "t"),
        data: {
          title: "t",
          questions: [
            { question: "Which store?", answers: ["sqlite", "json"] },
            { question: "Anything else?" },
          ],
        },
      } as LifecyclePayload,
      provider,
    );
    assert.deepEqual(captured?.questions, [
      { question: "Which store?", answers: ["sqlite", "json"] },
      { question: "Anything else?", answers: [] },
    ]);
    assert.equal(
      slackText(captured as Message, "U1"),
      "<@U1> *Waiting for you \u00b7 stage planning*\n*Which store?*\n\u2022 sqlite\n\u2022 json\n\n*Anything else?*",
    );
  } finally {
    process.chdir(cwd);
  }
});

test("SC37: question-pending with no usable questions sends an empty body, never a crash", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    let captured: Message | undefined;
    const provider: Provider = {
      send: async (msg) => {
        captured = msg;
        return "1.1";
      },
      upload: async () => {},
    };
    await notifierHook(
      {
        event: "question-pending", stage: "planning", spec: "t", branch: "main", repoRoot: dir, artifactDir: seedThread(dir, "t"),
        data: { title: "t", questions: [{ answers: ["yes"] }, "not an object"] },
      } as unknown as LifecyclePayload,
      provider,
    );
    assert.equal(captured?.body, "");
    assert.deepEqual(captured?.questions, []);
    assert.equal(slackText(captured as Message, "U1"), "<@U1> *Waiting for you \u00b7 stage planning*");
  } finally {
    process.chdir(cwd);
  }
});

test("SC38: status is success when a hook ran clean, skipped when none matched", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { hooks: { "stage-started": [{ name: "ping", cmd: "true" }] } });
  const { exec } = makeFakeExec([{ stdout: "" }]);

  const ran = await runFire({ event: "stage-started" }, baseDeps(dir, { exec }));
  assert.equal(ran.out.status, "success");

  const none = await runFire({ event: "run-completed" }, baseDeps(dir, { exec }));
  assert.equal(none.out.status, "skipped");
});

test("SC39: a required failure is status halt and still exits 0 — it pauses, it does not fail", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { hooks: { "stage-completed": [{ name: "gate", cmd: "exit 3", required: true }] } });
  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", hooksPath, "fire", "--event", "stage-completed"],
    { cwd: dir, encoding: "utf8" },
  );

  assert.equal(res.status, 0, res.stderr);
  const out: { status?: string; result?: string; results?: Record<string, { status: string }> } =
    JSON.parse(res.stdout);
  assert.equal(out.status, "halt");
  assert.equal(out.results?.["gate"]?.status, "failure");
  assert.match(out.result ?? "", /^HOOK_HALT gate/);
  assert.match(res.stderr, /HOOK_HALT gate/);
});

test("SC40: a hook that fails without required is status failure, never halt", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { hooks: { "stage-completed": [{ name: "flaky", cmd: "false" }] } });
  const { exec } = makeFakeExec([{ exit: 1, stderr: "nope" }]);

  const { out } = await runFire({ event: "stage-completed" }, baseDeps(dir, { exec }));
  assert.equal(out.status, "failure");
});

test("SC41: a command the caller got wrong is status invalid and exit 1 — nothing fired", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", hooksPath, "fire", "--event", "stage-started", "--data", "{oops"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(res.status, 1, res.stderr);
  const out: { status?: string; result?: string; results?: unknown } = JSON.parse(res.stdout);
  assert.equal(out.status, "invalid");
  assert.match(out.result ?? "", /--data/);
  assert.equal(out.results, undefined);
});

test("SC42: a failed hook dispatches hook-failed, and its handlers land under a prefixed name", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, {
    hooks: {
      "stage-completed": [{ name: "boom", cmd: "false", required: true }],
      "hook-failed": [{ name: "page", cmd: "cat", report: true }],
    },
  });
  const { exec, calls } = makeFakeExec([{ exit: 2, stderr: "boom" }, { stdout: "paged" }]);

  const { out } = await runFire({ event: "stage-completed", stage: "coder" }, baseDeps(dir, { exec }));
  assert.equal(out.status, "halt");
  assert.equal(out.results?.["hook-failed:page"]?.status, "success");

  const seen: { event: string; data: { name: string; event: string; required: boolean } } =
    JSON.parse(calls[1]?.input ?? "{}");
  assert.equal(seen.event, "hook-failed");
  assert.equal(seen.data.name, "boom");
  assert.equal(seen.data.event, "stage-completed");
  assert.equal(seen.data.required, true);
});

test("SC43: hook-failed never re-enters — a handler that fails dispatches nothing further", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, {
    hooks: {
      "stage-completed": [{ name: "boom", cmd: "false" }],
      "hook-failed": [{ name: "alsoBroken", cmd: "false" }],
    },
  });
  const { exec, calls } = makeFakeExec([{ exit: 1 }, { exit: 1 }, { exit: 1 }]);

  const { out } = await runFire({ event: "stage-completed" }, baseDeps(dir, { exec }));
  assert.equal(calls.length, 2);
  assert.equal(out.results?.["hook-failed:alsoBroken"]?.status, "failure");
  assert.equal(out.results?.["hook-failed:hook-failed:alsoBroken"], undefined);
});

test("SC44: the notifier mentions a person on a required failure, and stays quiet on the rest", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });

  const message = (required: boolean): Message =>
    formatMessage({
      event: "hook-failed",
      stage: "coder",
      title: "t",
      body: null,
      questions: [],
      failure: { name: "gate", event: "stage-completed", required, detail: "exit 1" },
      thread: null,
      artifacts: [],
    });

  assert.equal(message(true).mention, true);
  assert.equal(message(false).mention, false);
  assert.equal(
    slackText(message(true), "U1"),
    "<@U1> *Hook failed · stage coder*\n*gate* failed on stage-completed\nexit 1",
  );
});

test("SC44b: with no SLACK_MEMBER_ID set, a mentioning event sends untagged", () => {
  const message = formatMessage({
    event: "question-pending",
    stage: "planning",
    title: "t",
    body: null,
    questions: [],
    failure: null,
    thread: null,
    artifacts: [],
  });

  assert.equal(message.mention, true);
  assert.equal(slackText(message, ""), "*Waiting for you · stage planning*");
  assert.equal(slackText(message, "U1"), "<@U1> *Waiting for you · stage planning*");
});

test("SC45: a half-written fn entry is a FAIL row, not a throw — and fire skips it", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, {
    hooks: { "run-completed": [{ name: "broken", fn: {} }, { name: "ok", cmd: "true" }] },
  });

  const { lines, failed } = runDoctor(dir);
  assert.equal(failed, true, lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("fn.module must be a string")), lines.join("\n"));

  const { exec, calls } = makeFakeExec([{ stdout: "" }]);
  const { out } = await runFire({ event: "run-completed" }, baseDeps(dir, { exec }));
  assert.equal(out.results?.["broken"]?.status, "skipped");
  assert.equal(out.results?.["ok"]?.status, "success");
  assert.equal(calls.length, 1);
});

test("SC46: a cmd that is not a string is caught, never handed to the shell", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { hooks: { "run-completed": [{ name: "numeric", cmd: 123 }] } });

  const { lines, failed } = runDoctor(dir);
  assert.equal(failed, true, lines.join("\n"));
  assert.ok(lines.some((l) => l.includes("cmd must be a string")), lines.join("\n"));

  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", hooksPath, "fire", "--event", "run-completed"],
    { cwd: dir, encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  const out: { results?: Record<string, { status: string }> } = JSON.parse(res.stdout);
  assert.equal(out.results?.["numeric"]?.status, "skipped");
});

test("SC47: every entry field is checked for its type, not just its presence", () => {
  const fixtures: { readonly label: string; readonly entry: unknown; readonly needle: string }[] = [
    { label: "name", entry: { name: 7, cmd: "true" }, needle: "missing name" },
    { label: "prompt", entry: { name: "a", prompt: [] }, needle: "prompt must be a string" },
    { label: "fn export", entry: { name: "a", fn: { module: "m.mjs", export: 1 } }, needle: "fn.export must be a string" },
    { label: "required", entry: { name: "a", cmd: "true", required: "yes" }, needle: "required must be true or false" },
    { label: "report", entry: { name: "a", cmd: "true", report: 1 }, needle: "report must be true or false" },
    { label: "when type", entry: { name: "a", cmd: "true", when: "coder" }, needle: "when must be an object" },
    { label: "when value", entry: { name: "a", cmd: "true", when: { stage: 3 } }, needle: "when.stage must be a string" },
    { label: "not an object", entry: "just a string", needle: "entry must be an object" },
  ];

  for (const fixture of fixtures) {
    const dir = tmp();
    writeConfig(dir, { hooks: { "run-completed": [fixture.entry] } });
    const { lines, failed } = runDoctor(dir);
    assert.equal(failed, true, `${fixture.label}: expected FAIL — got:\n${lines.join("\n")}`);
    assert.ok(
      lines.some((l) => l.includes(fixture.needle)),
      `${fixture.label}: expected "${fixture.needle}" — got:\n${lines.join("\n")}`,
    );
  }
});

test("SC48: --data that does not fit the event is invalid — rejected before any hook runs", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { hooks: { "artifact-created": [{ name: "never", cmd: "touch fired.txt" }] } });
  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", hooksPath, "fire", "--event", "artifact-created", "--kind", "pr", "--data", "{}"],
    { cwd: dir, encoding: "utf8" },
  );

  assert.equal(res.status, 1, res.stdout);
  const out: { status?: string; result?: string } = JSON.parse(res.stdout);
  assert.equal(out.status, "invalid");
  assert.match(out.result ?? "", /url/);
  assert.equal(existsSync(join(dir, "fired.txt")), false);
});

test("SC49: a payload carries the event's own fields and nothing else", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { hooks: { "run-started": [{ name: "spy", cmd: "cat" }] } });
  const { exec, calls } = makeFakeExec([{ stdout: "" }]);

  await runFire(
    { event: "run-started", data: { title: "t", body: "b", surprise: "dropped" } },
    baseDeps(dir, { exec }),
  );
  const seen: { data: Record<string, unknown> } = JSON.parse(calls[0]?.input ?? "{}");
  assert.deepEqual(seen.data, { title: "t", body: "b" });
});

test("samskara SC1: with no samskara block in the config, no samskara hook runs", async () => {
  const dir = tmp();
  writeConfig(dir, { hooks: { "stage-completed": [] } });
  let importCalls = 0;
  const importModule: FireDeps["importModule"] = async () => {
    importCalls += 1;
    return {};
  };
  const { out } = await runFire(
    {
      event: "stage-completed",
      data: {
        artifacts: [
          { name: "a", path: "a.md" },
          { name: "b", path: "b.md" },
        ],
      },
    },
    baseDeps(dir, { importModule }),
  );
  assert.equal("samskara" in (out.results ?? {}), false);
  assert.equal(importCalls, 0);
});

test("samskara SC12: a project hook named samskara on stage-completed is rejected", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, {
    hooks: { "stage-completed": [{ name: "samskara", cmd: "printf nope" }] },
  });
  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));
  const res = spawnSync(process.execPath, ["--experimental-strip-types", hooksPath, "doctor"], {
    cwd: dir,
    encoding: "utf8",
  });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /duplicate name "samskara"/);
});

test("samskara SC13: the fire command uploads through a real subprocess", () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const specDir = join(dir, ".harness", "t");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, "manifest.json"), JSON.stringify({ run_info: { session: "sess-real" } }));
  const reportPath = join(specDir, "review.md");
  writeFileSync(reportPath, "# review\n");
  writeConfig(dir, { samskara: { enabled: true } });

  const stubDir = tmp();
  const recordPath = join(stubDir, "calls.jsonl");
  const stub = join(stubDir, "samskara");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      'if [ "$1 $2 $3" = "artifacts upload --help" ]; then',
      '  echo "usage: samskara artifacts upload SESSION PATH... --base-dir DIR"',
      "  exit 0",
      "fi",
      `printf '%s\\n' "$*" >> "${recordPath}"`,
      "exit 0",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);

  const hooksPath = fileURLToPath(new URL("./hooks.ts", import.meta.url));
  const res = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      hooksPath,
      "fire",
      "--event",
      "stage-completed",
      "--spec",
      "t",
      "--data",
      JSON.stringify({ artifacts: [{ name: "review", path: ".harness/t/review.md" }] }),
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubDir}:${process.env["PATH"] ?? ""}` },
    },
  );
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const out: { results?: Record<string, { status: string; result?: string }> } = JSON.parse(res.stdout);
  assert.equal(out.results?.["samskara"]?.status, "success");

  const recorded = readFileSync(recordPath, "utf8").trim().split("\n");
  assert.equal(recorded.length, 1);
  assert.ok(recorded[0]?.includes("sess-real"));
  assert.ok(recorded[0]?.includes(reportPath));
});

test("samskara SC14: the conventions name the design record and the verification folder", () => {
  const eventsPath = fileURLToPath(new URL("../orchestrate/references/events.md", import.meta.url));
  const text = readFileSync(eventsPath, "utf8");
  const planningRow = text.split("\n").find((line) => line.trim().startsWith("- planning"));
  const verifyRow = text.split("\n").find((line) => line.trim().startsWith("- verify-finalize"));
  assert.match(planningRow ?? "", /`design`/);
  assert.match(verifyRow ?? "", /`verification`/);
});

test("samskara SC15: the Slack notifier skips a folder and still uploads the files beside it", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  seedThread(dir, "t");
  writeFileSync(join(dir, "review.md"), "# review");
  mkdirSync(join(dir, "verification"));

  const uploaded: string[] = [];
  const provider: Provider = {
    send: async () => "1.1",
    upload: async (file) => {
      uploaded.push(file);
    },
  };
  const importModule: FireDeps["importModule"] = async () => ({
    notifierHook: (payload: LifecyclePayload) => notifierHook(payload, provider),
  });

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const { out } = await runFire(
      {
        event: "stage-completed",
        spec: "t",
        data: {
          title: "t",
          artifacts: [
            { name: "review", path: "review.md" },
            { name: "verification", path: "verification" },
          ],
        },
      },
      baseDeps(dir, { importModule }),
    );
    assert.equal(out.results?.["notifier"]?.status, "success");
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(uploaded, [realpathSync(join(dir, "review.md"))]);
});

test("samskara SC16 (regression): the notifier still runs first and still uploads every file", async () => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeConfig(dir, {
    notifier: { enabled: true, provider: "slack" },
    hooks: { "stage-completed": [{ name: "ping", cmd: "printf pong" }] },
  });
  seedThread(dir, "t");
  writeFileSync(join(dir, "a.md"), "a");
  writeFileSync(join(dir, "b.md"), "b");

  const uploaded: string[] = [];
  const provider: Provider = {
    send: async () => "1.1",
    upload: async (file) => {
      uploaded.push(file);
    },
  };
  const importModule: FireDeps["importModule"] = async () => ({
    notifierHook: (payload: LifecyclePayload) => notifierHook(payload, provider),
  });
  const { exec } = makeFakeExec([{ stdout: "pong" }]);

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const { out } = await runFire(
      {
        event: "stage-completed",
        spec: "t",
        data: {
          title: "t",
          artifacts: [
            { name: "a", path: "a.md" },
            { name: "b", path: "b.md" },
          ],
        },
      },
      baseDeps(dir, { exec, importModule }),
    );
    assert.deepEqual(Object.keys(out.results ?? {}), ["notifier", "ping"]);
  } finally {
    process.chdir(cwd);
  }
  assert.deepEqual(uploaded.sort(), [realpathSync(join(dir, "a.md")), realpathSync(join(dir, "b.md"))].sort());
});

test("samskara SC9: a failed upload never halts the stage and never blocks a later hook", async () => {
  const dir = tmp();
  writeConfig(dir, {
    samskara: { enabled: true },
    hooks: { "stage-completed": [{ name: "after", cmd: "printf later" }] },
  });
  const importModule: FireDeps["importModule"] = async () => ({
    samskaraHook: async () => {
      throw new Error("samskara upload failed (exit 1): session not found");
    },
  });
  const { exec } = makeFakeExec([{ stdout: "later" }]);
  const { out } = await runFire(
    {
      event: "stage-completed",
      data: { artifacts: [{ name: "review", path: ".harness/t/review.md" }] },
    },
    baseDeps(dir, { exec, importModule }),
  );

  assert.notEqual(out.status, "halt");
  assert.equal(out.results?.["samskara"]?.status, "failure");
  assert.match(out.results?.["samskara"]?.result ?? "", /session not found/);
  assert.equal(out.results?.["after"]?.status, "success");
});

test("samskara SC24: the Slack notifier never uploads a path from outside the repo", async () => {
  const dir = tmp();
  const repoRoot = gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  seedManifest(repoRoot, "t", "999.1");
  writeFileSync(join(dir, "review.md"), "# review");

  const outside = tmp();
  const secret = join(outside, "credentials");
  writeFileSync(secret, "aws_secret_access_key = hunter2");
  symlinkSync(secret, join(dir, "creds"));

  const uploaded: string[] = [];
  const provider: Provider = {
    send: async () => "1.1",
    upload: async (file) => {
      uploaded.push(file);
    },
  };
  const importModule: FireDeps["importModule"] = async () => ({
    notifierHook: (payload: LifecyclePayload) => notifierHook(payload, provider),
  });

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runFire(
      {
        event: "stage-completed",
        spec: "t",
        data: {
          title: "t",
          artifacts: [
            { name: "review", path: "review.md" },
            { name: "escape", path: "creds" },
            { name: "climb", path: "../../etc/hosts" },
            { name: "absolute", path: secret },
          ],
        },
      },
      baseDeps(dir, { importModule }),
    );
  } finally {
    process.chdir(cwd);
  }

  assert.equal(uploaded.length, 1);
  assert.match(uploaded[0] ?? "", /review\.md$/);
});

const envRepo = (files: Readonly<Record<string, string>>): string => {
  const dir = tmp();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};

test("SC50: the config env block wins over .env.local, and .env and the process env are ignored", () => {
  const dir = envRepo({
    ".env": "T_CONFIG=from-dotenv\nT_PROC=from-dotenv\nT_DOTENV=from-dotenv\n",
    ".env.local": "T_CONFIG=from-local\nT_PROC=from-local\nT_LOCAL=from-local\n",
  });
  writeConfig(dir, {
    notifier: { enabled: true, provider: "slack" },
    env: { T_CONFIG: "from-config" },
  });

  process.env["T_CONFIG"] = "from-proc";
  process.env["T_PROC"] = "from-proc";
  try {
    const config = loadConfig(dir);

    assert.equal(config?.secrets["T_CONFIG"], "from-config");
    assert.equal(config?.secrets["T_PROC"], "from-local");
    assert.equal(config?.secrets["T_DOTENV"], undefined);
    assert.equal(config?.secrets["T_LOCAL"], "from-local");
  } finally {
    delete process.env["T_CONFIG"];
    delete process.env["T_PROC"];
  }
});

test("SC51: a config without an env block still resolves .env.local", () => {
  const dir = envRepo({
    ".env": "T_DOTENV=from-dotenv\n",
    ".env.local": "T_LOCAL=from-local\n",
  });
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });

  const config = loadConfig(dir);

  assert.equal(config?.secrets["T_LOCAL"], "from-local");
  assert.equal(config?.secrets["T_DOTENV"], undefined);
});

test("SC52: no .env.local present is not an error", () => {
  const dir = envRepo({});
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" }, env: { T_CONFIG: "from-config" } });

  const config = loadConfig(dir);

  assert.equal(config?.secrets["T_CONFIG"], "from-config");
  assert.equal(config?.secrets["T_DOTENV"], undefined);
});

const threadingProvider = (sent: Message[], ts: string | null = "123.45"): Provider => ({
  send: async (msg) => {
    sent.push(msg);
    return ts;
  },
  upload: async () => {},
});

const notifierDeps = (dir: string, provider: Provider): FireDeps =>
  baseDeps(dir, {
    importModule: async () => ({
      notifierHook: (payload: LifecyclePayload) => notifierHook(payload, provider),
    }),
  });

const gitRepo = (dir: string): string => {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    { cwd: dir, encoding: "utf8" },
  ).trim();
};

test("SC53: the artifact dir is the run's directory under the repo root", () => {
  const dir = tmp();
  const repoRoot = gitRepo(dir);
  mkdirSync(join(dir, "src"), { recursive: true });

  const dirs = [dir, join(dir, "src")].map(
    (cwd) => buildPayload({ event: "stage-started", spec: "t", data: {} }, repoRoot, cwd).artifactDir,
  );

  assert.deepEqual(new Set(dirs), new Set([join(repoRoot, ".harness", "t")]));
});

test("SC54c: a workspace checkout finds the config at the root it was cloned into", () => {
  const dir = tmp();
  const workspace = join(dir, "ws");
  const main = gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: main });
  execFileSync("git", ["worktree", "add", "-q", join(workspace, "alpha"), "-b", "alpha"], { cwd: main });

  assert.equal(loadHooks(join(workspace, "alpha")).raw["notifier"] !== undefined, true);
});

test("SC54d: a checkout carrying its own config keeps using it", () => {
  const dir = tmp();
  const main = gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: false } });
  execFileSync("git", ["add", "-A"], { cwd: main });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: main });
  const tree = join(dir, "wt");
  execFileSync("git", ["worktree", "add", "-q", tree, "-b", "wt"], { cwd: main });
  writeConfig(tree, { notifier: { enabled: true, provider: "slack" } });

  assert.deepEqual(loadHooks(tree).raw["notifier"], { enabled: true, provider: "slack" });
});

const memberOutsideTheRoot = (): { readonly root: string; readonly tree: string } => {
  const dir = tmp();
  const root = join(dir, "root");
  const src = join(dir, "src");
  mkdirSync(root, { recursive: true });
  mkdirSync(src, { recursive: true });
  gitRepo(src);
  execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "init"], { cwd: src });
  const tree = join(root, "ws", "wt");
  execFileSync("git", ["worktree", "add", "-q", tree, "-b", "wt"], { cwd: src });
  return { root, tree };
};

test("SC54e: a member checkout whose source repo sits outside the run root finds the root's config", () => {
  const { root, tree } = memberOutsideTheRoot();
  writeConfig(root, { notifier: { enabled: true, provider: "slack" } });

  assert.equal(loadHooks(tree).raw["notifier"] !== undefined, true);
});

test("SC54f: the secrets load from beside the config the walk found, not the source checkout", () => {
  const { root, tree } = memberOutsideTheRoot();
  writeConfig(root, { notifier: { enabled: true, provider: "slack" } });
  writeFileSync(join(root, ".env.local"), "T_LOCAL=from-root\n");

  const config = loadConfig(tree);

  assert.equal(config?.secrets["T_LOCAL"], "from-root");
});

test("SC55: an event fired before run-started fails and names the missing fire", async () => {
  const dir = tmp();
  const repoRoot = gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  seedManifest(repoRoot, "t");
  const sent: Message[] = [];

  const cwd = process.cwd();
  process.chdir(dir);
  let result;
  try {
    result = await runFire(
      { event: "stage-started", stage: "coder", spec: "t", data: { title: "t" } },
      notifierDeps(dir, threadingProvider(sent)),
    );
  } finally {
    process.chdir(cwd);
  }

  assert.equal(result.out.results?.["notifier"]?.status, "failure");
  assert.match(String(result.out.results?.["notifier"]?.result), /Trigger run-started before any other event/);
  assert.match(String(result.out.results?.["notifier"]?.result), /events\.md/);
  assert.equal(sent.length, 0);
});

test("SC56: an event before run-started sends nothing; the run threads once it fires", async () => {
  const dir = tmp();
  const repoRoot = gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  seedManifest(repoRoot, "t");
  const sent: Message[] = [];
  const deps = notifierDeps(dir, threadingProvider(sent));

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runFire({ event: "stage-started", stage: "coder", spec: "t", data: { title: "t" } }, deps);
    assert.equal(sent.length, 0);
    await runFire({ event: "run-started", spec: "t", data: { title: "t" } }, deps);
    await runFire({ event: "stage-completed", stage: "coder", spec: "t", data: { title: "t" } }, deps);
  } finally {
    process.chdir(cwd);
  }

  assert.deepEqual(sent.map((m) => m.threadRef), [null, "123.45"]);
});

test("SC57: an empty thread reads as no thread, and nothing is sent on it", async () => {
  const dir = tmp();
  const repoRoot = gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  seedManifest(repoRoot, "t", "  \n");
  const sent: Message[] = [];

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runFire(
      { event: "stage-started", stage: "coder", spec: "t", data: { title: "t" } },
      notifierDeps(dir, threadingProvider(sent)),
    );
  } finally {
    process.chdir(cwd);
  }

  assert.equal(sent.length, 0);
});

test("SC58: a hook failure never reaches the notifier — errors stay out of the channel", async () => {
  const dir = tmp();
  gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  const sent: Message[] = [];

  const cwd = process.cwd();
  process.chdir(dir);
  let result;
  try {
    result = await runFire(
      {
        event: "hook-failed",
        stage: "coder",
        spec: "t",
        data: { name: "x", event: "stage-completed", required: false, detail: "boom" },
      },
      notifierDeps(dir, threadingProvider(sent)),
    );
  } finally {
    process.chdir(cwd);
  }

  assert.equal(result.out.results?.["notifier"], undefined);
  assert.equal(sent.length, 0);
});

test("SC59: a notifier event with no --spec reports the missing flag and sends nothing", async () => {
  const dir = tmp();
  gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  const sent: Message[] = [];

  const cwd = process.cwd();
  process.chdir(dir);
  let result;
  try {
    result = await runFire(
      { event: "stage-started", stage: "coder", data: { title: "t" } },
      notifierDeps(dir, threadingProvider(sent)),
    );
  } finally {
    process.chdir(cwd);
  }

  assert.equal(result.out.results?.["notifier"]?.status, "failure");
  assert.match(String(result.out.results?.["notifier"]?.result), /--spec/);
  assert.equal(sent.length, 0);
});

test("SC60: with no manifest the notifier names it and creates nothing", async () => {
  const dir = tmp();
  const repoRoot = gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  const sent: Message[] = [];

  const cwd = process.cwd();
  process.chdir(dir);
  let result;
  try {
    result = await runFire(
      { event: "stage-started", stage: "coder", spec: "t", data: { title: "t" } },
      notifierDeps(dir, threadingProvider(sent)),
    );
  } finally {
    process.chdir(cwd);
  }

  assert.equal(result.out.results?.["notifier"]?.status, "failure");
  assert.match(String(result.out.results?.["notifier"]?.result), /no manifest at/);
  assert.match(String(result.out.results?.["notifier"]?.result), /pipeline-setup/);
  assert.equal(existsSync(join(repoRoot, ".harness", "t")), false);
  assert.equal(sent.length, 0);
});

test("SC61: writing the thread keeps every other field a stage wrote meanwhile", async () => {
  const dir = tmp();
  const repoRoot = gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  const artifactDir = seedManifest(repoRoot, "t");
  const manifestPath = join(artifactDir, "manifest.json");

  const provider: Provider = {
    send: async () => {
      const during = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      writeFileSync(manifestPath, JSON.stringify({ ...during, pr_number: 42 }, null, 2));
      return "123.45";
    },
    upload: async () => {},
  };

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    await runFire({ event: "run-started", spec: "t", data: { title: "t" } }, notifierDeps(dir, provider));
  } finally {
    process.chdir(cwd);
  }

  const manifest = manifestOf(repoRoot, "t");
  assert.equal(manifest["thread"], "123.45");
  assert.equal(manifest["pr_number"], 42);
  assert.equal(manifest["spec_name"], "t");
});

test("SC62: a fire reports the thread id it posted to", async () => {
  const dir = tmp();
  const repoRoot = gitRepo(dir);
  writeConfig(dir, { notifier: { enabled: true, provider: "slack" } });
  seedManifest(repoRoot, "t");
  const sent: Message[] = [];

  const cwd = process.cwd();
  process.chdir(dir);
  let result;
  try {
    result = await runFire(
      { event: "run-started", spec: "t", data: { title: "t" } },
      notifierDeps(dir, threadingProvider(sent)),
    );
  } finally {
    process.chdir(cwd);
  }

  assert.equal(result.out.results?.["notifier"]?.status, "success");
  assert.equal(result.out.results?.["notifier"]?.result, "123.45");
});
