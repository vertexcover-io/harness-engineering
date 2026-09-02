import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import type { FireDeps, LifecyclePayload } from "./hooks.ts";
import { notifierHook, parseFireArgv, runDoctor, runFire } from "./hooks.ts";
import { formatMessage, slackText } from "./notify.ts";
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
  const artifactDir = join(dir, ".harness", "t");
  const threadFile = join(artifactDir, "hooks", "thread");
  mkdirSync(join(artifactDir, "hooks"), { recursive: true });

  const events = [
    "run-started", "stage-started", "stage-completed",
    "question-pending", "run-interrupted", "run-completed",
  ] as const;

  const cwd = process.cwd();
  process.chdir(dir);
  try {
    for (const event of events) {
      // run-started overwrites the thread file with its own returned ts — reset it
      // before each event so this loop tests one event's mapping in isolation.
      writeFileSync(threadFile, "999.1");
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
    const threadFile = join(repoRoot, ".harness", "t", "hooks", "thread");
    assert.equal(readFileSync(threadFile, "utf8"), "123.45");

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
        event: "question-pending", stage: "planning", spec: "t", branch: "main", repoRoot: dir,
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
        event: "question-pending", stage: "planning", spec: "t", branch: "main", repoRoot: dir,
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
