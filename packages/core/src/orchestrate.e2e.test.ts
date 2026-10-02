import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type JsonValue, runDirOf, type WorkflowRun } from "@harness/sdk";
import { jsonlEventStore, RegistryFileSchema } from "@harness/sdk/internal";
import { validateTicketDir } from "../../../skills/ticket-fetcher/scripts/ticket.ts";
import { DEMO_STAGES, writeStages } from "./workflow/test-stages.ts";

const SCRIPT = join(import.meta.dir, "orchestrate.ts");

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "orchestrate-")));

const makeRepo = (dir: string, ignored: string): string => {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, ".gitignore"), ignored);
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const tempRepo = (): string => makeRepo(tempDir(), ".worktrees/\n.harness/\n");

const savedRun = (cwd: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun => {
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(workflowPath, "name: ok\nnodes: []\n");
  return {
    id: "r-1",
    workflow: "ok",
    workflowPath,
    inputs: { prompt: "hi" },
    cwd,
    sessions: [],
    name: null,
    terminal: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
};

const writeRegistry = (home: string, runs: readonly WorkflowRun[]): void => {
  mkdirSync(home, { recursive: true });
  const file = { version: 1, runs: Object.fromEntries(runs.map((run) => [run.id, run])) };
  writeFileSync(join(home, "registry.json"), JSON.stringify(file));
};

const readRegistry = (home: string) =>
  RegistryFileSchema.parse(JSON.parse(readFileSync(join(home, "registry.json"), "utf8")));

// An initialized run named NAME in cwd, as `orchestrate init` leaves it.
const initializedRun = (home: string, cwd: string, name = "feat-x"): WorkflowRun => {
  const run = savedRun(cwd, { name });
  writeRegistry(home, [run]);
  mkdirSync(runDirOf(cwd, name), { recursive: true });
  return run;
};

const eventsOf = (cwd: string, name = "feat-x") => jsonlEventStore(runDirOf(cwd, name)).read();

type Env = Readonly<Record<string, string | undefined>>;

// A run id or harness home from the shell running the tests must never reach a real registry.
const orchestrate = (
  cwd: string,
  home: string,
  args: readonly string[],
  env: Env = {},
  input = "",
) => {
  const run = spawnSync("bun", [SCRIPT, ...args], {
    cwd,
    encoding: "utf8",
    input,
    env: { ...process.env, HARNESS_RUN_ID: undefined, HARNESS_HOME: home, ...env },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};

const orchestrateAsync = async (
  cwd: string,
  home: string,
  args: readonly string[],
  env: Env = {},
): Promise<Readonly<{ code: number; stdout: string; stderr: string }>> => {
  const child = Bun.spawn(["bun", SCRIPT, ...args], {
    cwd,
    env: { ...process.env, HARNESS_RUN_ID: undefined, HARNESS_HOME: home, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

describe("orchestrate init", () => {
  test("SC23: init NAME --run-id prints { runId, dir }, writes state.json there, and names the run in the registry", () => {
    const repo = tempRepo();
    const home = tempDir();
    writeRegistry(home, [savedRun(repo)]);

    const init = orchestrate(repo, home, ["init", "fix-login", "--run-id", "r-1"]);

    expect(init.code).toBe(0);
    const dir = join(repo, ".harness", "fix-login");
    expect(JSON.parse(init.stdout)).toEqual({ runId: "r-1", dir });
    expect(existsSync(join(dir, "state.json"))).toBe(true);
    expect(readRegistry(home).runs["r-1"]?.name).toBe("fix-login");
  });

  test("init takes the run id from HARNESS_RUN_ID", () => {
    const repo = tempRepo();
    const home = tempDir();
    writeRegistry(home, [savedRun(repo)]);

    const init = orchestrate(repo, home, ["init", "fix-login"], { HARNESS_RUN_ID: "r-1" });

    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout).runId).toBe("r-1");
  });

  test("SC24: init with no --run-id and no HARNESS_RUN_ID exits 1 with the no-run message", () => {
    const init = orchestrate(tempRepo(), tempDir(), ["init", "fix-login"]);

    expect(init.code).toBe(1);
    expect(init.stderr.trim()).not.toBe("");
  });

  test("SC20: init of a run the registry does not hold exits 1 naming it and writes nothing", () => {
    const repo = tempRepo();

    const init = orchestrate(repo, tempDir(), ["init", "fix-login", "--run-id", "r-missing"]);

    expect(init.code).toBe(1);
    expect(init.stderr).toContain("r-missing");
    expect(existsSync(join(repo, ".harness"))).toBe(false);
  });
});

describe("orchestrate link-session", () => {
  test("SC22: link-session --run NAME records the session once and prints the run's sessions", () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);
    const args = ["link-session", "--run", "feat-x", "--agent", "codex", "--session-id", "s2"];

    const first = orchestrate(repo, home, args);
    const second = orchestrate(repo, home, args);

    expect(first.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual([{ agent: "codex", sessionId: "s2" }]);
    expect(readRegistry(home).runs["r-1"]?.sessions).toEqual([{ agent: "codex", sessionId: "s2" }]);
  });
});

describe("orchestrate emit", () => {
  test("SC22: emit --run NAME stores the event under the run's id and prints it", async () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);

    const emit = orchestrate(repo, home, [
      "emit",
      "custom.review.note",
      "--run",
      "feat-x",
      "--source",
      "review-skill",
      "--payload",
      '{"files":3}',
      "--node-id",
      "review",
      "--node-run-id",
      "review",
      "--stage",
      "review",
      "--id",
      "note-1",
    ]);

    expect(emit.code).toBe(0);
    const printed = JSON.parse(emit.stdout);
    expect(printed).toMatchObject({
      type: "custom.review.note",
      source: "review-skill",
      runId: "r-1",
      payload: { files: 3 },
      nodeId: "review",
      nodeRunId: "review",
      stage: "review",
      id: "note-1",
    });
    expect((await eventsOf(repo)).at(-1)).toEqual(printed);
  });

  test("SC28: emit to a name no run has exits 1 naming it", () => {
    const repo = tempRepo();

    const emit = orchestrate(repo, tempDir(), [
      "emit",
      "custom.x.y",
      "--run",
      "ghost",
      "--source",
      "x",
    ]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain('no run named "ghost"');
  });

  test("SC20: an event the catalog refuses exits 1 naming its type and stores nothing", async () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);
    const args = ["emit", "workflow.node.failed", "--run", "feat-x", "--source", "s"];

    const emit = orchestrate(repo, home, [...args, "--node-id", "a", "--node-run-id", "a"]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain("workflow.node.failed");
    expect(await eventsOf(repo)).toEqual([]);
  });

  test("emit refuses a hook event, so an agent cannot fake a SessionStart", async () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);
    const payload = JSON.stringify({ agent: "claude", sessionId: "forged", source: "clear" });

    const emit = orchestrate(repo, home, [
      "emit",
      "hooks.session-start.called",
      "--run",
      "feat-x",
      "--source",
      "hooks",
      "--payload",
      payload,
    ]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain("hooks.session-start.called");
    expect(await eventsOf(repo)).toEqual([]);
  });

  test("emit cannot bypass stage completion verification with a lifecycle event", async () => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);
    const before = (await eventsOf(repo)).length;
    const attempted = orchestrate(repo, home, [
      "emit",
      "workflow.node.completed",
      "--run",
      "feat-x",
      "--source",
      "stage",
      "--node-id",
      "make",
      "--node-run-id",
      "nr-1",
      "--payload",
      '{"nodeType":"agent","attempts":1}',
    ]);
    expect(attempted.code).toBe(1);
    expect(attempted.stderr).toContain("workflow.node.completed");
    expect(await eventsOf(repo)).toHaveLength(before);
  });

  test.each([
    ["SC24: a payload that is not JSON", ["--source", "s", "--payload", "{oops"], "--payload"],
    ["SC30: no --source", [], "--source"],
  ])("%s exits 1 naming the flag and stores nothing", async (_label, flags, flag) => {
    const repo = tempRepo();
    const home = tempDir();
    initializedRun(home, repo);

    const emit = orchestrate(repo, home, ["emit", "custom.x.y", "--run", "feat-x", ...flags]);

    expect(emit.code).toBe(1);
    expect(emit.stderr).toContain(flag);
    expect(await eventsOf(repo)).toEqual([]);
  });
});

const waitFor = async (condition: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(50);
  }
};

const DEMO_SKILL = `---
name: demo
description: A demo skill.
mode: inline
allowed-tools: [Bash]
tier: fast
inputs:
  description: Anything.
  schema: demo.input.v1
outputs:
  description: Anything.
  schema: demo.output.v1
protocols: []
scopes: []
references:
  notes:
    path: notes.md
    description: Notes.
---
`;

const configuredRepo = (config: object): string => {
  const root = tempRepo();
  writeFileSync(join(root, "orchestrate.config.json"), JSON.stringify({ version: 2, ...config }));
  return root;
};

describe("orchestrate skill", () => {
  test("WS32 — skill ref with an extend prints the base text, a blank line, then the extension", () => {
    const skillsDir = tempDir();
    mkdirSync(join(skillsDir, "demo"));
    writeFileSync(join(skillsDir, "demo/SKILL.md"), DEMO_SKILL);
    writeFileSync(join(skillsDir, "demo/notes.md"), "base text\n");
    const root = configuredRepo({
      extensions: { demo: { references: { notes: { extend: "notes-extra.md" } } } },
    });
    writeFileSync(join(root, "notes-extra.md"), "extension text\n");

    const run = orchestrate(root, tempDir(), ["skill", "ref", "demo.notes"], {
      HARNESS_SKILLS_DIR: skillsDir,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("base text\n\nextension text\n");
  });

  test.each([
    [
      "the skill's own file",
      {},
      (skillsDir: string, _root: string) => join(skillsDir, "demo/notes.md"),
    ],
    [
      "the project's file when it replaces the reference",
      { demo: { references: { notes: { replace: "my-notes.md" } } } },
      (_skillsDir: string, root: string) => join(root, "my-notes.md"),
    ],
  ])("skill ref --path prints the path of %s", (_case, extensions, expected) => {
    const skillsDir = tempDir();
    mkdirSync(join(skillsDir, "demo"));
    writeFileSync(join(skillsDir, "demo/SKILL.md"), DEMO_SKILL);
    writeFileSync(join(skillsDir, "demo/notes.md"), "base text\n");
    const root = configuredRepo({ extensions });
    writeFileSync(join(root, "my-notes.md"), "project text\n");

    const run = orchestrate(root, tempDir(), ["skill", "ref", "--path", "demo.notes"], {
      HARNESS_SKILLS_DIR: skillsDir,
    });

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(expected(skillsDir, root));
  });

  test("skill ref with no HARNESS_SKILLS_DIR reads the harness repo's own skills folder", () => {
    const shipped = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "skills",
      "create-workspace",
      "references",
      "select-repos.md",
    );

    const run = orchestrate(
      configuredRepo({}),
      tempDir(),
      ["skill", "ref", "create-workspace.select-repos"],
      {
        HARNESS_SKILLS_DIR: undefined,
      },
    );

    expect(run.code).toBe(0);
    expect(run.stdout).toBe(readFileSync(shipped, "utf8"));
  });

  test("skill ref without a dot between skill and reference exits 1 showing the form", () => {
    const run = orchestrate(configuredRepo({}), tempDir(), ["skill", "ref", "baseline"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("SKILL.REF");
  });

  test("WS33 — skill ref for a skill that does not exist exits 1 naming the skill", () => {
    const run = orchestrate(configuredRepo({}), tempDir(), ["skill", "ref", "missing.notes"]);

    expect(run.code).toBe(1);
    expect(run.stderr).toContain("missing");
  });

  test("skill extension prints the project's extension doc for the skill", () => {
    const root = configuredRepo({ extensions: { demo: { skill: "demo-extra.md" } } });
    writeFileSync(join(root, "demo-extra.md"), "use pnpm\n");

    const run = orchestrate(root, tempDir(), ["skill", "extension", "demo"]);

    expect(run.code).toBe(0);
    expect(run.stdout).toBe("use pnpm\n");
  });
});

// A run named feat-x in a fresh repo, started from SOURCE the way `harness run` + init leave it.
const startedRun = (source: string): Readonly<{ repo: string; home: string }> => {
  const repo = tempRepo();
  const home = tempDir();
  const workflowPath = join(repo, "steps.yaml");
  writeFileSync(workflowPath, source);
  writeRegistry(home, [savedRun(repo, { workflowPath })]);
  const init = orchestrate(repo, home, ["init", "feat-x", "--run-id", "r-1"]);
  if (init.code !== 0) throw new Error(init.stderr);
  return { repo, home };
};

const stateOf = (repo: string) =>
  JSON.parse(readFileSync(join(runDirOf(repo, "feat-x"), "state.json"), "utf8"));

const STEPS = `name: steps
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: a
    type: exec
    runtime: sh
    script: printf '{"n":1}'
    output: { zodSchema: Json }
    input: {}
  - id: w
    type: wait
    durationMs: 10
    dependsOn: [a]
    input: "{{ nodes.a.output }}"
  - id: b
    type: exec
    runtime: sh
    script: cat
    dependsOn: [w]
    input: "{{ nodes.w.output }}"
`;

describe("orchestrate next and exec", () => {
  test("IW10 — next and exec, called in turn, take an exec, wait and exec workflow from init to finished", async () => {
    const { repo, home } = startedRun(STEPS);
    const handedOut = ["a", "w", "b"].map((nodeId) => {
      const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);
      expect(next.code).toBe(0);
      const reply = JSON.parse(next.stdout);
      expect(reply).toEqual({
        kind: "exec",
        nodeRunId: expect.stringMatching(/^nr-[0-9a-f]{16}$/),
        nodeId,
        mode: "inline",
        command: `bun run orchestrate exec ${reply.nodeRunId} --run feat-x`,
      });
      const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
      expect(exec.code).toBe(0);
      expect(JSON.parse(exec.stdout)).toEqual({
        nodeRunId: reply.nodeRunId,
        nodeId,
        status: "completed",
        attempts: 1,
      });
      return reply.nodeRunId;
    });

    const last = orchestrate(repo, home, ["next", "--run", "feat-x"]);
    expect(JSON.parse(last.stdout)).toEqual({ kind: "finished", status: "completed" });
    const state = stateOf(repo);
    expect(state).toMatchObject({ runId: "r-1", runName: "feat-x", status: "completed" });
    expect(state.nodeRuns.w.nodeRunId).toBe(handedOut[1]);
    expect(state.nodeRuns.w.output).toEqual({ n: 1 });
    expect(state.nodeRuns.b).toMatchObject({ nodeType: "exec", output: '{"n":1}' });
    expect(state.nodeRuns.b).not.toHaveProperty("process");
    const ended = (await eventsOf(repo)).find(
      (event) => event.nodeRunId === handedOut[2] && event.type === "workflow.node.completed",
    );
    expect(ended?.payload).toMatchObject({
      output: '{"n":1}',
      process: { stdout: '{"n":1}', stderr: "", exitCode: 0 },
    });
  });

  test("IW11 — a script that keeps failing is retried as configured, exec exits 1, and the run ends failed", async () => {
    const { repo, home } = startedRun(`name: steps
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: a
    type: exec
    runtime: sh
    script: exit 3
    retry: { maxAttempts: 2 }
    input: {}
`);
    const reply = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    expect(exec.code).toBe(1);
    expect(JSON.parse(exec.stdout)).toMatchObject({
      status: "failed",
      attempts: 2,
      error: { kind: "exit" },
    });
    expect(JSON.parse(exec.stdout).error).not.toHaveProperty("stack");
    const failed = (await eventsOf(repo)).find((event) => event.type === "workflow.node.failed");
    expect(failed?.payload).toMatchObject({ process: { stdout: "", stderr: "", exitCode: 3 } });
    expect(failed?.payload).not.toHaveProperty("output");
    expect(stateOf(repo).nodeRuns.a.output).toEqual({
      kind: "exit",
      message: `${reply.nodeRunId} exited with code 3`,
    });
    const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);
    expect(JSON.parse(next.stdout)).toEqual({ kind: "finished", status: "failed" });
  });

  test("IW12 — exec refuses a node run that already ended or does not exist, recording only the refused calls", async () => {
    const { repo, home } = startedRun(STEPS);
    const reply = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    const before = (await eventsOf(repo)).length;
    const stateBefore = stateOf(repo);

    const again = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain(reply.nodeRunId);
    const unknown = orchestrate(repo, home, ["exec", "nr-00000000", "--run", "feat-x"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("nr-00000000");
    const added = (await eventsOf(repo)).slice(before);
    expect(added.map((event) => event.payload)).toEqual([
      {
        input: { nodeRunId: reply.nodeRunId },
        output: { kind: "error", message: again.stderr.trim() },
      },
      {
        input: { nodeRunId: "nr-00000000" },
        output: { kind: "error", message: unknown.stderr.trim() },
      },
    ]);
    expect(added.map((event) => event.type)).toEqual(["orchestrate.exec", "orchestrate.exec"]);
    expect(stateOf(repo)).toEqual({ ...stateBefore, lastEventSeq: before + 2 });
  });
});

// A skills folder holding the producer and consumer demo stages, for HARNESS_SKILLS_DIR.
const stageSkills = (produces = DEMO_STAGES.producer.produces): string => {
  const dir = tempDir();
  writeStages(dir, { ...DEMO_STAGES, producer: { produces } });
  return dir;
};

const STAGES_WORKFLOW = `name: stages
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: make
    type: agent
    stage: producer
    input: { request: "{{ inputs.prompt }}" }
  - id: use
    type: agent
    stage: consumer
    dependsOn: [make]
    input: {}
`;

describe("stage verifiers", () => {
  const verifiedRun = (verifiers: string | undefined, workflow = STAGES_WORKFLOW) => {
    const skills = tempDir();
    writeStages(skills, {
      producer: { produces: DEMO_STAGES.producer.produces },
      consumer: { consumes: DEMO_STAGES.consumer.consumes, ...(verifiers ? { verifiers } : {}) },
    });
    const run = startedRun(workflow);
    const env = { HARNESS_SKILLS_DIR: skills };
    const step = (args: readonly string[]) => orchestrate(run.repo, run.home, args, env);
    const artifactsDir = join(runDirOf(run.repo, "feat-x"), "artifacts");
    const finishProducer = () => {
      const make = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
      writeFileSync(join(artifactsDir, "plan.md"), "plan\n");
      const done = step([
        ...["done", make.nodeRunId, "--run", "feat-x", "--output", "{}"],
        ...["--artifact", "plan=artifacts/plan.md"],
      ]);
      expect(done.code).toBe(0);
      return JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    };
    const finish = (nodeRunId: string) =>
      step(["done", nodeRunId, "--run", "feat-x", "--output", '{"ok":true}']);
    return { ...run, step, finishProducer, finish, artifactsDir };
  };

  const fn = (id: string, functionName: string, extra = "") =>
    `{ id: ${id}, module: ../verifiers.ts, functionName: ${functionName}${extra} }`;
  const script = (id: string, body: string) =>
    `{ id: ${id}, runtime: sh, script: ${JSON.stringify(body)} }`;

  const refusal = (stderr: string) => JSON.parse(stderr);

  test("a stage with no verifiers completes as before", () => {
    const { finishProducer, finish } = verifiedRun(undefined);
    const use = finishProducer();
    expect(finish(use.nodeRunId).code).toBe(0);
  });

  test("a passing function verifier lets the stage complete", () => {
    const { repo, finishProducer, finish } = verifiedRun(`[${fn("ok", "pass")}]`);
    const use = finishProducer();
    expect(finish(use.nodeRunId).code).toBe(0);
    expect(stateOf(repo).nodeRuns.use.status).toBe("completed");
  });

  test("pass: false returns a retryable validation with the findings and keeps the node open", () => {
    const { repo, finishProducer, finish } = verifiedRun(`[${fn("lint", "fail")}]`);
    const use = finishProducer();
    const refused = finish(use.nodeRunId);
    expect(refused.code).toBe(1);
    expect(refusal(refused.stderr)).toEqual({
      kind: "validation",
      retryable: true,
      nodeRunId: use.nodeRunId,
      issues: [
        {
          kind: "verifier",
          verifier: "lint",
          findings: [{ message: "fail one", path: "a.ts", line: 3, hint: "fix a" }],
        },
      ],
    });
    expect(stateOf(repo).nodeRuns.use.status).toBe("running");
  });

  test.each([
    ["throw", fn("v", "throws"), "threw", "boom"],
    ["timeout", fn("v", "slow", ", timeoutMs: 100"), "timeout", "timed out after 100ms"],
    ["bad result shape", fn("v", "badShape"), "bad-output", "finding"],
    ["non-zero exit", script("v", "echo nope >&2; exit 3"), "exit", "exit 3: nope"],
    ["bad JSON", script("v", "echo not-json"), "bad-output", "not JSON"],
    ["no JSON", script("v", "true"), "bad-output", "not JSON"],
  ])("a verifier error (%s) fails closed with its own reason", (_name, verifier, reason, text) => {
    const { finishProducer, finish } = verifiedRun(`[${verifier}]`);
    const use = finishProducer();
    const refused = finish(use.nodeRunId);
    expect(refused.code).toBe(1);
    const { kind, retryable, issues } = refusal(refused.stderr);
    expect([kind, retryable]).toEqual(["validation", true]);
    expect(issues).toEqual([
      { kind: "verifier-error", verifier: "v", reason, message: expect.stringContaining(text) },
    ]);
  });

  test("a script verifier gets the input as JSON on stdin and runs in the run's cwd", () => {
    const { repo, finishProducer, finish } = verifiedRun(
      `[${script("s", 'cat > "$PWD/stdin.json"; printf \'{"pass":true}\'')}]`,
    );
    const use = finishProducer();
    expect(finish(use.nodeRunId).code).toBe(0);
    const seen = JSON.parse(readFileSync(join(repo, "stdin.json"), "utf8"));
    expect(seen).toEqual({
      run: "feat-x",
      nodeRunId: use.nodeRunId,
      output: { ok: true },
      artifacts: {},
      args: {},
    });
  });

  test("failing default checks skip the verifiers", () => {
    const marker = join(tempDir(), "ran");
    const { finishProducer, step } = verifiedRun(
      `[${script("s", `touch ${marker}; printf '{"pass":true}'`)}]`,
    );
    const use = finishProducer();
    const refused = step(["done", use.nodeRunId, "--run", "feat-x", "--output", "[]"]);
    expect(refusal(refused.stderr).issues).toMatchObject([{ kind: "output-schema" }]);
    expect(existsSync(marker)).toBe(false);
  });

  test("two failing verifiers are returned together", () => {
    const { finishProducer, finish } = verifiedRun(`[${fn("a", "fail")}, ${fn("b", "failTwo")}]`);
    const use = finishProducer();
    const issues = refusal(finish(use.nodeRunId).stderr).issues;
    expect(issues.map((issue: { verifier: string }) => issue.verifier)).toEqual(["a", "b"]);
  });

  test("each verifier run is logged as an orchestrate.verifier event", async () => {
    const { repo, finishProducer, finish } = verifiedRun(
      `[${fn("ok", "pass")}, ${fn("lint", "fail")}, ${fn("boom", "throws")}]`,
    );
    const use = finishProducer();
    expect(finish(use.nodeRunId).code).toBe(1);
    const logged = (await eventsOf(repo))
      .filter((event) => event.type === "orchestrate.verifier")
      .map(({ source, nodeId, nodeRunId, stage, payload }) => ({
        source,
        nodeId,
        nodeRunId,
        stage,
        payload,
      }));
    const envelope = {
      source: "orchestrate",
      nodeId: "use",
      nodeRunId: use.nodeRunId,
      stage: "consumer",
    };
    const run = { attempt: 1, durationMs: expect.any(Number) };
    expect(logged).toEqual([
      { ...envelope, payload: { ...run, verifier: "ok", status: "passed", findings: [] } },
      {
        ...envelope,
        payload: {
          ...run,
          verifier: "lint",
          status: "failed",
          findings: [{ message: "fail one", path: "a.ts", line: 3, hint: "fix a" }],
        },
      },
      {
        ...envelope,
        payload: {
          ...run,
          verifier: "boom",
          status: "error",
          findings: [],
          error: { reason: "threw", message: "boom" },
        },
      },
    ]);
  });

  test("a function verifier receives its input, args and context, and the helpers answer", () => {
    const file = join(tempDir(), "seen.json");
    const args = `, args: { file: ${JSON.stringify(file)} }`;
    const { repo, finishProducer, finish, artifactsDir } = verifiedRun(
      `[${fn("rec", "record", args)}]`,
    );
    const use = finishProducer();
    const refused = finish(use.nodeRunId);
    expect(refused.code).toBe(0);
    const seen = JSON.parse(readFileSync(file, "utf8"));
    expect(seen.input).toEqual({
      run: "feat-x",
      nodeRunId: use.nodeRunId,
      output: { ok: true },
      artifacts: {},
      args: { file },
    });
    expect(seen.cwd).toBe(repo);
    expect(seen.attempt).toBe(1);
    expect(seen.helpers).toEqual({
      node: { nodeId: "use", stage: "consumer", input: {}, attempt: 1 },
      consumed: { plan: join(artifactsDir, "plan.md") },
    });
  });

  test("the third rejected done fails the node for good, whatever the rejections were, however long", async () => {
    const file = join(tempDir(), "seen.json");
    const record = fn("rec", "record", `, args: { file: ${JSON.stringify(file)} }`);
    const { repo, finishProducer, finish, step } = verifiedRun(
      `[${fn("lint", "failLong")}, ${record}]`,
    );
    const use = finishProducer();
    const show = () =>
      JSON.parse(step(["node", "show", "--run", "feat-x", "--node-run", use.nodeRunId]).stdout);
    const schemaRefusal = step(["done", use.nodeRunId, "--run", "feat-x", "--output", "[]"]);
    expect(refusal(schemaRefusal.stderr).retryable).toBe(true);
    expect(show().attempt).toBe(2);

    const second = finish(use.nodeRunId);
    expect(second.stderr.length).toBeGreaterThan(500);
    expect(refusal(second.stderr).retryable).toBe(true);
    const seen = JSON.parse(readFileSync(file, "utf8"));
    expect([seen.attempt, seen.helpers.node.attempt]).toEqual([2, 2]);

    const last = finish(use.nodeRunId);
    expect(last.code).toBe(1);
    expect(refusal(last.stderr)).toMatchObject({
      kind: "verify-exhausted",
      retryable: false,
      nodeRunId: use.nodeRunId,
      issues: [{ kind: "verifier", verifier: "lint" }],
    });
    expect(stateOf(repo).nodeRuns.use.status).toBe("failed");
    const again = finish(use.nodeRunId);
    expect(refusal(again.stderr)).toMatchObject({ kind: "not-running", retryable: false });
    const next = step(["next", "--run", "feat-x"]);
    expect(JSON.parse(next.stdout)).toEqual({ kind: "finished", status: "failed" });
  });

  test("a node with allowFailure whose done is rejected for good lets the run end completed", () => {
    const workflow = STAGES_WORKFLOW.replace(
      "    dependsOn: [make]\n",
      "    dependsOn: [make]\n    allowFailure: true\n",
    );
    const { repo, finishProducer, finish, step } = verifiedRun(`[${fn("lint", "fail")}]`, workflow);
    const use = finishProducer();
    finish(use.nodeRunId);
    finish(use.nodeRunId);
    expect(refusal(finish(use.nodeRunId).stderr)).toMatchObject({ kind: "verify-exhausted" });
    const next = step(["next", "--run", "feat-x"]);
    expect(JSON.parse(next.stdout)).toEqual({ kind: "finished", status: "completed" });
    expect(stateOf(repo).nodeRuns.use.status).toBe("failed");
  });

  test("when two nodes wrote a consumed artifact, the newer one is handed over", () => {
    const twoMakers = STAGES_WORKFLOW.replace(
      "  - id: use",
      "  - id: remake\n    type: agent\n    stage: producer\n    dependsOn: [make]\n    input: {}\n  - id: use",
    ).replace("dependsOn: [make]\n    input: {}\n`", "dependsOn: [remake]\n    input: {}\n`");
    const { step, artifactsDir } = verifiedRun(undefined, twoMakers);
    const produce = (file: string) => {
      const node = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
      writeFileSync(join(artifactsDir, file), "plan\n");
      const done = step([
        ...["done", node.nodeRunId, "--run", "feat-x", "--output", "{}"],
        ...["--artifact", `plan=artifacts/${file}`],
      ]);
      expect(done.code).toBe(0);
    };
    produce("first.md");
    produce("second.md");
    const use = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(use).toMatchObject({ nodeId: "use" });
    const shown = step(["node", "show", "--run", "feat-x", "--node-run", use.nodeRunId]);
    expect(JSON.parse(shown.stdout).consumed).toEqual({ plan: join(artifactsDir, "second.md") });
  });

  test("node show prints the node run's facts as JSON", () => {
    const { repo, finishProducer, step, artifactsDir } = verifiedRun(undefined);
    const use = finishProducer();
    const shown = step(["node", "show", "--run", "feat-x", "--node-run", use.nodeRunId]);
    expect(shown.code).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual({
      nodeRunId: use.nodeRunId,
      nodeId: "use",
      stage: "consumer",
      input: {},
      attempt: 1,
      consumed: { plan: join(artifactsDir, "plan.md") },
      runDir: runDirOf(repo, "feat-x"),
      artifactsDir,
    });
    const unknown = step(["node", "show", "--run", "feat-x", "--node-run", "nr-nope"]);
    expect(unknown.code).toBe(1);
  });
});

describe("orchestrate next and done with stages", () => {
  const stageRun = (produces?: string) => {
    const skills = stageSkills(produces);
    const run = startedRun(STAGES_WORKFLOW);
    const env = { HARNESS_SKILLS_DIR: skills };
    const step = (args: readonly string[]) => orchestrate(run.repo, run.home, args, env);
    return { ...run, skills, step };
  };

  test("IW17 — next replies with the stage's skill path, the project's extension path, its input and a done command", () => {
    const { repo, skills, step } = stageRun();
    mkdirSync(join(repo, "docs"));
    writeFileSync(join(repo, "docs/producer-ext.md"), "use short names\n");
    writeFileSync(
      join(repo, "orchestrate.config.json"),
      JSON.stringify({ version: 2, extensions: { producer: { skill: "docs/producer-ext.md" } } }),
    );
    const next = step(["next", "--run", "feat-x"]);
    expect(next.code).toBe(0);
    const reply = JSON.parse(next.stdout);
    expect(reply).toEqual({
      kind: "stage",
      nodeRunId: expect.stringMatching(/^nr-[0-9a-f]{16}$/),
      nodeId: "make",
      stage: "producer",
      skill: join(skills, "producer/SKILL.md"),
      extension: join(repo, "docs/producer-ext.md"),
      input: { request: "hi" },
      variables: {},
      done: `bun run orchestrate done ${reply.nodeRunId} --run feat-x`,
    });
  });

  test("next hands a stage its skill's variable defaults under the node's values, an expression read from inputs", () => {
    const skills = stageSkills();
    const run = startedRun(`name: tuned
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: say
    type: agent
    stage: tuned
    input: {}
    variables: { audience: "{{ inputs.prompt }}" }
`);
    const next = orchestrate(run.repo, run.home, ["next", "--run", "feat-x"], {
      HARNESS_SKILLS_DIR: skills,
    });
    expect(next.stderr).toBe("");
    expect(JSON.parse(next.stdout)).toMatchObject({
      kind: "stage",
      nodeId: "say",
      variables: { tone: "plain", audience: "hi" },
    });
  });

  test("next returns a typed compile error before starting a node with a broken output schema", async () => {
    const run = startedRun(
      `name: broken\nnodes:\n  - id: ask\n    type: agent\n    prompt: Ask\n    input: null\n    output: { module: ./missing-schema.ts, zodSchema: answer }\n`,
    );
    const next = orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]);
    expect(next.code).toBe(1);
    expect(JSON.parse(next.stderr)).toMatchObject({
      kind: "compile",
      retryable: false,
      code: "missing-module",
    });
    expect(stateOf(run.repo).nodeRuns).toEqual({});
    expect((await eventsOf(run.repo)).map((event) => event.type)).toEqual([
      "workflow.started",
      "orchestrate.next",
    ]);
  });

  test("IW18 — done records a stage's output and artifacts, and refuses an artifact file that does not exist", async () => {
    const { repo, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(reply).toMatchObject({ kind: "stage", nodeId: "make", extension: null });
    const done = ["done", reply.nodeRunId, "--run", "feat-x", "--output", '{"ok":true}'];
    const artifact = ["--artifact", "plan=artifacts/plan.md"];

    const omitted = step(done);
    expect(omitted.code).toBe(1);
    expect(JSON.parse(omitted.stderr)).toMatchObject({
      kind: "validation",
      retryable: true,
      nodeRunId: reply.nodeRunId,
      issues: [{ kind: "required-artifact", name: "plan" }],
    });
    expect(stateOf(repo).nodeRuns.make.status).toBe("running");

    const missing = step([...done, ...artifact]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(join(runDirOf(repo, "feat-x"), "artifacts/plan.md"));
    expect((await eventsOf(repo)).map((event) => event.type)).toEqual([
      "workflow.started",
      "workflow.node.started",
      "orchestrate.next",
      "orchestrate.done",
      "orchestrate.done",
    ]);

    mkdirSync(join(runDirOf(repo, "feat-x"), "artifacts"), { recursive: true });
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts/plan.md"), "plan\n");
    const recorded = step([...done, ...artifact]);
    expect(recorded.code).toBe(0);
    expect(JSON.parse(recorded.stdout)).toMatchObject({ nodeId: "make", status: "completed" });
    expect(stateOf(repo).nodeRuns.make).toMatchObject({
      nodeRunId: reply.nodeRunId,
      output: { ok: true },
      artifacts: [{ name: "plan", path: "artifacts/plan.md" }],
    });
  });

  test("done records an artifact the stage never declared", () => {
    const { repo, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const artifactsDir = join(runDirOf(repo, "feat-x"), "artifacts");
    writeFileSync(join(artifactsDir, "plan.md"), "plan\n");
    writeFileSync(join(artifactsDir, "notes.md"), "notes\n");
    const recorded = step([
      ...["done", reply.nodeRunId, "--run", "feat-x", "--output", '{"ok":true}'],
      ...["--artifact", "plan=artifacts/plan.md", "--artifact", "notes=artifacts/notes.md"],
    ]);
    expect(recorded.code).toBe(0);
    expect(stateOf(repo).nodeRuns.make.artifacts).toEqual([
      { name: "plan", path: "artifacts/plan.md" },
      { name: "notes", path: "artifacts/notes.md" },
    ]);
  });

  test("a stage with invalid output stays running and can submit corrected output", async () => {
    const { repo, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const artifactPath = join(runDirOf(repo, "feat-x"), "artifacts", "plan.md");
    writeFileSync(artifactPath, "plan\n");
    const command = [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--artifact",
      "plan=artifacts/plan.md",
    ];
    const before = (await eventsOf(repo)).length;

    const invalid = step([...command, "--output", "[]"]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stderr)).toMatchObject({
      kind: "validation",
      retryable: true,
      issues: [{ kind: "output-schema", schema: "demo.output.v1" }],
    });
    expect(stateOf(repo).nodeRuns.make.status).toBe("running");
    expect(await eventsOf(repo)).toHaveLength(before + 1);
    expect((await eventsOf(repo)).some((event) => event.type === "workflow.node.completed")).toBe(
      false,
    );

    const corrected = step([...command, "--output", '{"ok":true}']);
    expect(corrected.code).toBe(0);
    expect(stateOf(repo).nodeRuns.make).toMatchObject({
      status: "completed",
      output: { ok: true },
    });
  });

  test("done reports output and artifact issues together", () => {
    const { repo, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const invalid = step(["done", reply.nodeRunId, "--run", "feat-x", "--output", "[]"]);
    expect(invalid.code).toBe(1);
    expect(JSON.parse(invalid.stderr).issues).toEqual([
      { kind: "required-artifact", name: "plan" },
      expect.objectContaining({ kind: "output-schema", schema: "demo.output.v1" }),
    ]);
    expect(stateOf(repo).nodeRuns.make.status).toBe("running");
  });

  test("done reports every missing required artifact and missing registered file", () => {
    const { repo, step } = stageRun("[{ artifact: plan }, { artifact: notes }]");
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const done = ["done", reply.nodeRunId, "--run", "feat-x", "--output", '{"ok":true}'];

    const omitted = step(done);
    expect(JSON.parse(omitted.stderr).issues).toEqual([
      { kind: "required-artifact", name: "plan" },
      { kind: "required-artifact", name: "notes" },
    ]);

    const missingFiles = step([
      ...done,
      "--artifact",
      "plan=artifacts/plan.md",
      "--artifact",
      "notes=artifacts/notes.md",
    ]);
    expect(JSON.parse(missingFiles.stderr).issues).toEqual([
      expect.objectContaining({ kind: "artifact-file", name: "plan", reason: "missing" }),
      expect.objectContaining({ kind: "artifact-file", name: "notes", reason: "missing" }),
    ]);
    expect(stateOf(repo).nodeRuns.make.status).toBe("running");
  });

  test("concurrent done calls record exactly one completion", async () => {
    const { repo, home, skills, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts", "plan.md"), "plan\n");
    const args = [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--output",
      '{"ok":true}',
      "--artifact",
      "plan=artifacts/plan.md",
    ];
    const results = await Promise.all([
      orchestrateAsync(repo, home, args, { HARNESS_SKILLS_DIR: skills }),
      orchestrateAsync(repo, home, args, { HARNESS_SKILLS_DIR: skills }),
    ]);
    expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
    const rejected = results.find((result) => result.code === 1);
    expect(JSON.parse(rejected?.stderr ?? "")).toMatchObject({
      kind: "not-running",
      retryable: false,
      nodeRunId: reply.nodeRunId,
    });
    expect(
      (await eventsOf(repo)).filter((event) => event.type === "workflow.node.completed"),
    ).toHaveLength(1);
  });

  test("optional produced artifacts may be omitted but must exist when registered", async () => {
    const { repo, step } = stageRun("[{ artifact: plan }, { artifact: notes, optional: true }]");
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts", "plan.md"), "plan\n");
    const done = [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--output",
      '{"ok":true}',
      "--artifact",
      "plan=artifacts/plan.md",
    ];
    const missingOptional = step([...done, "--artifact", "notes=artifacts/notes.md"]);
    expect(missingOptional.code).toBe(1);
    expect(missingOptional.stderr).toContain("notes.md");
    expect(stateOf(repo).nodeRuns.make.status).toBe("running");

    const completed = step(done);
    expect(completed.code).toBe(0);
    expect(stateOf(repo).nodeRuns.make.artifacts).toEqual([
      { name: "plan", path: "artifacts/plan.md" },
    ]);
  });

  test("a stage cannot register an artifact through a symlink outside the run", () => {
    const { repo, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const outside = join(repo, "outside.md");
    const plan = join(runDirOf(repo, "feat-x"), "artifacts", "plan.md");
    writeFileSync(outside, "old plan\n");
    symlinkSync(outside, plan);
    const args = [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--output",
      '{"ok":true}',
      "--artifact",
      "plan=artifacts/plan.md",
    ];
    const invalid = step(args);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("inside artifacts/");
    expect(stateOf(repo).nodeRuns.make.status).toBe("running");

    unlinkSync(plan);
    writeFileSync(plan, "new plan\n");
    expect(step(args).code).toBe(0);
  });

  test("a stage cannot replace the run artifact directory with an external symlink", () => {
    const { repo, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const runDir = runDirOf(repo, "feat-x");
    const outside = join(repo, "external-artifacts");
    mkdirSync(outside);
    writeFileSync(join(outside, "plan.md"), "old plan\n");
    renameSync(join(runDir, "artifacts"), join(runDir, "artifacts-stored"));
    symlinkSync(outside, join(runDir, "artifacts"));
    const invalid = step([
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--output",
      '{"ok":true}',
      "--artifact",
      "plan=artifacts/plan.md",
    ]);
    expect(invalid.code).toBe(1);
    expect(invalid.stderr).toContain("run artifacts/ must be a real directory");
    expect(stateOf(repo).nodeRuns.make.status).toBe("running");
  });

  test.each([
    ["plain words", "all checks green"],
    ["text that looks like JSON", '{"ok":true}'],
  ])("a node with no output schema records its output as plain text: %s", (_case, text) => {
    const { repo, home } = startedRun(AGENT);
    const reply = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    const done = orchestrate(repo, home, [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--output",
      text,
    ]);
    expect(done.code).toBe(0);
    expect(stateOf(repo).nodeRuns.ask.output).toBe(text);
  });

  test("a node with an output schema rejects output that is not JSON", () => {
    const zodUrl = import.meta.resolve("zod");
    const run = startedRun(`name: checked
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: ask
    type: agent
    prompt: check it
    output: { module: ./schemas.ts, zodSchema: result }
    input: {}
`);
    writeFileSync(
      join(run.repo, "schemas.ts"),
      `import { z } from "${zodUrl}";\nexport const schemas = { result: z.object({ ok: z.boolean() }) };\n`,
    );
    const reply = JSON.parse(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    const done = orchestrate(run.repo, run.home, [
      ...["done", reply.nodeRunId, "--run", "feat-x", "--output", "looks fine to me"],
    ]);
    expect(done.code).toBe(1);
    expect(JSON.parse(done.stderr)).toMatchObject({
      kind: "validation",
      retryable: true,
      issues: [{ kind: "output-schema", schema: "result", message: "output is not valid JSON" }],
    });
    expect(stateOf(run.repo).nodeRuns.ask.status).toBe("running");
  });

  test("IW19 — a plain agent can repair output that fails its workflow.yaml schema", () => {
    const zodUrl = import.meta.resolve("zod");
    const run = startedRun(`name: checked
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: ask
    type: agent
    prompt: check it
    output: { module: ./schemas.ts, zodSchema: result }
    input: {}
`);
    writeFileSync(
      join(run.repo, "schemas.ts"),
      `import { z } from "${zodUrl}";\nexport const schemas = { result: z.object({ ok: z.boolean() }) };\n`,
    );
    const next = orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]);
    expect(next.code).toBe(0);
    const reply = JSON.parse(next.stdout);
    expect(reply).toMatchObject({ kind: "agent", prompt: "check it", input: {} });
    const done = orchestrate(run.repo, run.home, [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--output",
      '{"ok":"yes"}',
    ]);
    expect(done.code).toBe(1);
    expect(JSON.parse(done.stderr)).toMatchObject({
      kind: "validation",
      retryable: true,
      issues: [{ kind: "output-schema", schema: "result", path: "ok" }],
    });
    expect(stateOf(run.repo).nodeRuns.ask.status).toBe("running");
    const fixed = orchestrate(run.repo, run.home, [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--output",
      '{"ok":true}',
    ]);
    expect(fixed.code).toBe(0);
    expect(stateOf(run.repo).nodeRuns.ask.status).toBe("completed");
  });

  test("a plain agent cannot register the same artifact name twice", () => {
    const run = startedRun(`name: checked
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: ask, type: agent, prompt: Make it, input: null }
`);
    const next = orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]);
    expect(next.code, next.stderr).toBe(0);
    const reply = JSON.parse(next.stdout);
    writeFileSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "first.md"), "first\n");
    writeFileSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "second.md"), "second\n");
    const done = orchestrate(run.repo, run.home, [
      "done",
      reply.nodeRunId,
      "--run",
      "feat-x",
      "--output",
      "null",
      "--artifact",
      "note=artifacts/first.md",
      "--artifact",
      "note=artifacts/second.md",
    ]);
    expect(done.code).toBe(1);
    expect(JSON.parse(done.stderr)).toMatchObject({
      kind: "validation",
      issues: [{ kind: "artifact-name", name: "note", reason: "duplicate" }],
    });
    expect(stateOf(run.repo).nodeRuns.ask.status).toBe("running");
  });

  test("IW30 — done reads --output - and --error - from stdin, keeping quotes and $(…) as plain text", () => {
    const { repo, home, skills } = stageRun();
    const env = { HARNESS_SKILLS_DIR: skills };
    const next = () => JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"], env).stdout);
    const make = next();
    const output = '{"note":"can\'t stop; $(touch PWNED)"}';
    mkdirSync(join(runDirOf(repo, "feat-x"), "artifacts"), { recursive: true });
    writeFileSync(join(runDirOf(repo, "feat-x"), "artifacts/plan.md"), "plan\n");
    const artifact = ["--artifact", "plan=artifacts/plan.md"];
    const doneArgs = ["done", make.nodeRunId, "--run", "feat-x", "--output", "-", ...artifact];
    const done = orchestrate(repo, home, doneArgs, env, output);
    expect(done.code).toBe(0);
    expect(stateOf(repo).nodeRuns.make.output).toEqual({ note: "can't stop; $(touch PWNED)" });

    const use = next();
    const reason = "couldn't read the plan; `rm -rf x`\n";
    const failed = orchestrate(
      repo,
      home,
      ["done", use.nodeRunId, "--run", "feat-x", "--error", "-"],
      env,
      reason,
    );
    expect(failed.code).toBe(1);
    expect(stateOf(repo).nodeRuns.use.output).toEqual({
      kind: "exception",
      message: reason.trim(),
    });
    expect(existsSync(join(repo, "PWNED"))).toBe(false);
  });

  test("IW20 — done refuses bad flags before touching the run, and done --error fails the node", async () => {
    const { repo, step } = stageRun();
    const reply = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const done = ["done", reply.nodeRunId, "--run", "feat-x"];
    const before = (await eventsOf(repo)).length;
    const refusals = [
      { flags: ["--output", "{}", "--error", "no"], names: ["--output", "--error"] },
      { flags: [], names: ["--output", "--error"] },
      { flags: ["--error", "x", "--artifact", "plan"], names: ["--artifact", "plan"] },
      { flags: ["--error", "x", "--artifact", "artifacts/plan.md"], names: ["--artifact"] },
    ];
    for (const { flags, names } of refusals) {
      const refused = step([...done, ...flags]);
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.stderr)).toMatchObject({ kind: "input", retryable: true });
      for (const name of names) expect(refused.stderr).toContain(name);
    }
    expect(await eventsOf(repo)).toHaveLength(before);

    const wrongCommand = step(["exec", reply.nodeRunId, "--run", "feat-x"]);
    expect(wrongCommand.code).toBe(1);
    expect(wrongCommand.stderr).toContain(reply.nodeRunId);

    const failed = step([...done, "--error", "could not"]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      status: "failed",
      error: { message: "could not" },
    });
  });
});

const MIXED = `name: mixed
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: fix
    type: loop
    until: "{{ iteration.index >= 3 }}"
    maxIterations: 5
    input: {}
    nodes:
      - { id: test, type: exec, runtime: sh, script: cat, input: "pass {{ iteration.index }}" }
  - id: decide
    type: switch
    dependsOn: [fix]
    expression: "{{ inputs.prompt }}"
    input: {}
    cases:
      - id: hello
        value: hi
        nodes:
          - { id: greet, type: exec, runtime: sh, script: echo hello-case, input: {} }
    default:
      - { id: greet, type: exec, runtime: sh, script: echo default-case, input: {} }
  - { id: sub, type: include, workflow: child.yaml, dependsOn: [decide], input: {} }
  - id: last
    type: exec
    runtime: sh
    script: cat
    dependsOn: [sub, fix]
    input: "{{ nodes.sub.output }} / {{ nodes.fix.output }}"
`;

const CHILD = `name: child
inputs:
  word: { type: string, default: hi }
nodes:
  - { id: say, type: exec, runtime: sh, script: cat, input: "{{ inputs.word }}" }
`;

describe("orchestrate next and exec with containers", () => {
  test("IW28 — next and exec run a workflow mixing a loop, a switch and an include to finished", () => {
    const { repo, home } = startedRun(MIXED);
    writeFileSync(join(repo, "child.yaml"), CHILD);
    const handedOut = ["test", "test", "test", "greet", "say", "last"].map((nodeId) => {
      const reply = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
      expect(reply).toMatchObject({ kind: "exec", nodeId });
      const exec = orchestrate(repo, home, ["exec", reply.nodeRunId, "--run", "feat-x"]);
      expect(JSON.parse(exec.stdout)).toMatchObject({ nodeId, status: "completed" });
      return reply.nodeRunId;
    });
    const last = orchestrate(repo, home, ["next", "--run", "feat-x"]);
    expect(JSON.parse(last.stdout)).toEqual({ kind: "finished", status: "completed" });
    const nodes = stateOf(repo).nodeRuns;
    expect(nodes.decide.nodes.greet).toMatchObject({ nodeRunId: handedOut[3] });
    expect(nodes.decide).toMatchObject({
      output: "hello-case\n",
      nodes: { greet: { output: "hello-case\n" } },
    });
    expect(nodes.fix).toMatchObject({ iteration: 3, output: '"pass 3"' });
    expect(nodes.sub.output).toBe('"hi"');
    expect(nodes.last.input).toBe('"hi" / "pass 3"');
  });
});

const ONE_EXEC = `name: one
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: a, type: exec, runtime: sh, script: printf done, input: {} }
`;

const AGENT = `name: asked
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: ask, type: agent, prompt: check it, input: {} }
`;

const callsOf = async (repo: string) =>
  (await eventsOf(repo))
    .filter((event) => event.type.startsWith("orchestrate."))
    .map(({ type, source, payload }) => ({ type, source, payload }));

const call = (type: string, input: JsonValue, output: JsonValue, status?: string) => ({
  type: `orchestrate.${type}`,
  source: "orchestrate",
  payload: { input, output, ...(status === undefined ? {} : { status }) },
});

describe("orchestrate call log", () => {
  test("OL1 — next and exec each log their input and whole reply, after the engine events the call recorded", async () => {
    const { repo, home } = startedRun(ONE_EXEC);
    const step = (args: readonly string[]) => JSON.parse(orchestrate(repo, home, args).stdout);

    const exec = step(["next", "--run", "feat-x"]);
    const report = step(["exec", exec.nodeRunId, "--run", "feat-x"]);
    const finished = step(["next", "--run", "feat-x"]);

    expect(exec).toMatchObject({ kind: "exec", nodeId: "a" });
    expect(finished).toEqual({ kind: "finished", status: "completed" });
    expect(await callsOf(repo)).toEqual([
      call("next", {}, exec),
      call("exec", { nodeRunId: exec.nodeRunId }, report),
      call("next", {}, finished),
    ]);
    expect((await eventsOf(repo)).map((event) => event.type)).toEqual([
      "workflow.started",
      "workflow.node.started",
      "orchestrate.next",
      "workflow.node.completed",
      "orchestrate.exec",
      "workflow.completed",
      "orchestrate.next",
    ]);
  });

  test("OL2 — a stage reply, a refused done, a completed done and the next stage are logged", async () => {
    const run = startedRun(STAGES_WORKFLOW);
    const env = { HARNESS_SKILLS_DIR: stageSkills() };
    const step = (args: readonly string[]) => orchestrate(run.repo, run.home, args, env);
    const stage = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    const done = ["done", stage.nodeRunId, "--run", "feat-x"];

    const refused = step([
      ...done,
      "--output",
      '{"ok":true}',
      "--artifact",
      "plan=artifacts/plan.md",
    ]);
    writeFileSync(join(runDirOf(run.repo, "feat-x"), "artifacts", "plan.md"), "plan\n");
    const report = JSON.parse(
      step([...done, "--output", '{"ok":true}', "--artifact", "plan=artifacts/plan.md"]).stdout,
    );
    const following = JSON.parse(step(["next", "--run", "feat-x"]).stdout);

    expect(refused.code).toBe(1);
    expect(stage).toMatchObject({ kind: "stage", nodeId: "make" });
    expect(following).toMatchObject({ kind: "stage", nodeId: "use" });
    const artifacts = [{ name: "plan", path: "artifacts/plan.md" }];
    expect(await callsOf(run.repo)).toEqual([
      call("next", {}, stage),
      call(
        "done",
        { nodeRunId: stage.nodeRunId, output: '{"ok":true}', artifacts },
        { kind: "error", message: refused.stderr.trim() },
        "rejected",
      ),
      call(
        "done",
        { nodeRunId: stage.nodeRunId, output: '{"ok":true}', artifacts },
        report,
        "completed",
      ),
      call("next", {}, following),
    ]);
  });

  test("OL3 — an agent reply and a done --error log the error as the agent reported it", async () => {
    const { repo, home } = startedRun(AGENT);
    const agent = JSON.parse(orchestrate(repo, home, ["next", "--run", "feat-x"]).stdout);
    const failed = orchestrate(repo, home, [
      "done",
      agent.nodeRunId,
      "--run",
      "feat-x",
      "--error",
      "could not",
    ]);

    expect(agent).toMatchObject({ kind: "agent", prompt: "check it" });
    expect(await callsOf(repo)).toEqual([
      call("next", {}, agent),
      call(
        "done",
        { nodeRunId: agent.nodeRunId, error: "could not", artifacts: [] },
        JSON.parse(failed.stdout),
        "failed",
      ),
    ]);
  });

  test("OL4 — a next that throws logs the error with its stack, fails as before, and leaves state.json alone but for lastEventSeq", async () => {
    const { repo, home } = startedRun(ONE_EXEC);
    writeFileSync(join(runDirOf(repo, "feat-x"), "workflow.yaml"), "name: one\nnodes: 3\n");
    const before = stateOf(repo);

    const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);

    expect(next.code).toBe(1);
    expect(next.stdout).toBe("");
    expect(await callsOf(repo)).toEqual([
      call(
        "next",
        {},
        {
          kind: "error",
          message: expect.stringContaining("nodes: Invalid input"),
          stack: expect.stringContaining("workflow/compile.ts"),
        },
      ),
    ]);
    expect(stateOf(repo)).toEqual({ ...before, lastEventSeq: before.lastEventSeq + 1 });
  });

  test("OL5 — a next refused over a config broken after init is logged", async () => {
    const { repo, home } = startedRun(ONE_EXEC);
    writeFileSync(join(repo, "orchestrate.config.json"), "{");

    const next = orchestrate(repo, home, ["next", "--run", "feat-x"]);

    expect(next.code).toBe(1);
    expect(next.stderr).toContain("orchestrate.config.json: invalid YAML");
    expect(await callsOf(repo)).toEqual([
      call(
        "next",
        {},
        {
          kind: "error",
          message: expect.stringContaining("orchestrate.config.json: invalid YAML"),
        },
      ),
    ]);
  });

  test("OL6 — exec and done refuse an empty node run id before touching the run", async () => {
    const { repo, home } = startedRun(ONE_EXEC);
    const before = (await eventsOf(repo)).length;

    const exec = orchestrate(repo, home, ["exec", "", "--run", "feat-x"]);
    const done = orchestrate(repo, home, ["done", "", "--run", "feat-x", "--output", "{}"]);

    for (const refused of [exec, done]) {
      expect(refused.code).toBe(1);
      expect(refused.stderr.trim()).toBe("nodeRunId must not be empty");
    }
    expect(await eventsOf(repo)).toHaveLength(before);
  });
});

const ONE_AGENT = `name: one
inputs:
  prompt: { type: string, required: true }
nodes:
  - id: plan
    type: agent
    prompt: plan it
    input: {}
`;

describe("orchestrate hook stop", () => {
  const STOP = JSON.stringify({ session_id: "s1", stop_hook_active: false });
  const RUN_ENV = { HARNESS_RUN_ID: "r-1" };

  // A run whose claude session s1 was handed node plan by next and has not run done.
  const openNodeRun = () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);
    const next = JSON.parse(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    expect(next).toMatchObject({ kind: "agent", nodeId: "plan" });
    return run;
  };

  const stop = (run: Readonly<{ repo: string; home: string }>, input = STOP, env: Env = RUN_ENV) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", "stop", "--agent", "claude", "--handler", "continue-workflow"],
      env,
      input,
    );

  test("SC20 — the hook blocks a turn that left an agent node open, and logs the call", async () => {
    const run = openNodeRun();

    const first = stop(run);

    expect(first.code).toBe(0);
    const reply = JSON.parse(first.stdout);
    expect(reply).toEqual({
      decision: "block",
      reason: expect.stringContaining("orchestrate done"),
    });
    const last = (await eventsOf(run.repo)).at(-1);
    expect(last).toMatchObject({
      type: "hooks.stop.called",
      payload: {
        agent: "claude",
        sessionId: "s1",
        decision: "continue",
        reason: "node-not-done",
        blockStreak: 1,
        message: reply.reason,
      },
    });
    expect(stateOf(run.repo).stopHook).toEqual({ blockStreak: 1, seq: last?.seq });
  });

  test("SC21 — a second stop with nothing done lets the turn end, and that call is logged too", async () => {
    const run = openNodeRun();
    stop(run);
    const before = (await eventsOf(run.repo)).length;

    const second = stop(run);

    expect(second).toMatchObject({ code: 0, stdout: "" });
    const events = await eventsOf(run.repo);
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)?.payload).toEqual({
      agent: "claude",
      sessionId: "s1",
      touchedRun: null,
      decision: "allow",
      reason: "max-blocks-reached",
      blockStreak: 1,
    });
  });

  test("SC22 — a session that is not the run's own is never blocked", async () => {
    const run = openNodeRun();
    const before = await eventsOf(run.repo);

    expect(stop(run, JSON.stringify({ session_id: "other" }))).toMatchObject({
      code: 0,
      stdout: "",
    });
    expect(stop(run, STOP, {})).toMatchObject({ code: 0, stdout: "" });
    expect(await eventsOf(run.repo)).toEqual(before);
  });

  // A run between nodes, and a Claude transcript whose last lines are PROMPT and then COMMAND, if any.
  const betweenNodes = (prompt: string, command?: string) => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);
    const transcript = join(tempDir(), "s1.jsonl");
    const lines = [
      { type: "user", message: { role: "user", content: prompt } },
      ...(command === undefined
        ? [{ type: "assistant", message: { content: [{ type: "text", text: "answer" }] } }]
        : [
            {
              type: "assistant",
              message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
            },
          ]),
    ];
    writeFileSync(transcript, lines.map((line) => JSON.stringify(line)).join("\n"));
    return { run, input: JSON.stringify({ session_id: "s1", transcript_path: transcript }) };
  };

  test("a chat turn between nodes ends, and is logged as chat", async () => {
    const { run, input } = betweenNodes("what does this workflow do?");

    expect(stop(run, input)).toMatchObject({ code: 0, stdout: "" });
    expect((await eventsOf(run.repo)).at(-1)?.payload).toMatchObject({
      decision: "allow",
      reason: "user-chat",
      touchedRun: false,
    });
  });

  test("a turn that ran orchestrate but not next is sent back with the next command", () => {
    const { run, input } = betweenNodes("go", "bun run orchestrate done n1 --run feat-x");

    const reply = JSON.parse(stop(run, input).stdout);

    expect(reply.reason).toContain("bun run orchestrate next --run feat-x");
  });

  test("SC23 — a broken state.json lets the turn end", () => {
    const run = openNodeRun();
    writeFileSync(join(runDirOf(run.repo, "feat-x"), "state.json"), '{"schemaVersion":2}');

    expect(stop(run)).toMatchObject({ code: 0, stdout: "" });
  });
});

describe("orchestrate hook pre-tool-use", () => {
  const RUN_ENV = { HARNESS_RUN_ID: "r-1" };

  const openNodeRun = () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "s1"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);
    const next = JSON.parse(orchestrate(run.repo, run.home, ["next", "--run", "feat-x"]).stdout);
    expect(next).toMatchObject({ kind: "agent", nodeId: "plan" });
    return run;
  };

  const preToolUse = (
    run: Readonly<{ repo: string; home: string }>,
    toolName: string,
    toolInput: Record<string, unknown>,
    handler = "record-guard",
  ) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", "pre-tool-use", "--agent", "claude", "--handler", handler],
      RUN_ENV,
      JSON.stringify({
        session_id: "s1",
        tool_name: toolName,
        tool_input: toolInput,
        cwd: run.repo,
      }),
    );

  test("SC16 — the hook command refuses a shell write to state.json and logs it", async () => {
    const run = openNodeRun();

    const result = preToolUse(run, "Bash", {
      command: "mv /tmp/s .harness/feat-x/state.json",
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("bun run orchestrate next --run feat-x"),
    });
    const events = await eventsOf(run.repo);
    expect(events.at(-1)).toMatchObject({
      type: "hooks.pre-tool-use.called",
      payload: { handler: "record-guard", decision: "deny" },
    });
    expect(stateOf(run.repo)).toMatchObject({ runName: "feat-x", lastEventSeq: events.length });
  });

  test("an allowed tool call is not logged", async () => {
    const run = openNodeRun();
    const before = (await eventsOf(run.repo)).length;

    preToolUse(run, "Bash", { command: "echo hi > notes.md" });

    expect(await eventsOf(run.repo)).toHaveLength(before);
  });

  test("an unknown handler prints nothing, so no agent is ever trapped", () => {
    const run = openNodeRun();

    const result = preToolUse(run, "Bash", { command: "rm .harness/feat-x/state.json" }, "nope");

    expect(result).toMatchObject({ code: 0, stdout: "" });
  });

  test("SC17 — a read passes silently", () => {
    const run = openNodeRun();

    expect(preToolUse(run, "Read", { file_path: ".harness/feat-x/state.json" })).toMatchObject({
      code: 0,
      stdout: "",
    });
    expect(preToolUse(run, "Bash", { command: "jq . .harness/feat-x/state.json" })).toMatchObject({
      code: 0,
      stdout: "",
    });
  });

  test("SC23 — the bash-antipatterns handler refuses an anti-pattern and logs its name", async () => {
    const run = openNodeRun();

    const result = preToolUse(run, "Bash", { command: "git add -A" }, "bash-antipatterns");

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("git add -A"),
    });
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "hooks.pre-tool-use.called",
      payload: { handler: "bash-antipatterns", decision: "deny" },
    });
  });
});

describe("the task workflow's ticket-fetcher stage", () => {
  const TASK = readFileSync(
    join(import.meta.dir, "..", "..", "..", "workflows", "task.yaml"),
    "utf8",
  );
  const TICKET = {
    schemaVersion: 1,
    provider: "linear",
    id: "id-1",
    key: "ENG-1",
    url: "https://linear.app/x/issue/ENG-1",
    title: "Add export",
    body: "Export to CSV",
    properties: {},
    comments: [],
    references: [],
    assets: [],
    complete: true,
    fetchedAt: "2026-09-30T12:00:00Z",
  };

  const taskRun = (prompt: string) => {
    const run = startedRun(TASK);
    const registry = readRegistry(run.home);
    writeRegistry(run.home, [
      ...Object.values(registry.runs).map((r) => ({ ...r, inputs: { prompt } })),
    ]);
    const step = (args: readonly string[]) => orchestrate(run.repo, run.home, args);
    return { ...run, step };
  };

  const finishFetcher = (
    step: (args: readonly string[]) => ReturnType<typeof orchestrate>,
    output: unknown,
    artifact: readonly string[] = [],
  ) => {
    const fetcher = JSON.parse(step(["next", "--run", "feat-x"]).stdout);
    expect(fetcher).toMatchObject({
      nodeId: "ticket-fetcher",
      input: expect.anything(),
      variables: { provider: "linear" },
    });
    const done = step([
      "done",
      fetcher.nodeRunId,
      "--run",
      "feat-x",
      "--output",
      JSON.stringify(output),
      ...artifact,
    ]);
    expect(done.stderr).toBe("");
    expect(done.code).toBe(0);
    return JSON.parse(step(["next", "--run", "feat-x"]).stdout);
  };

  test("a plain prompt passes through to create-workspace unchanged", () => {
    const { step } = taskRun("fix the login bug");

    const workspace = finishFetcher(step, { task: "fix the login bug" });

    expect(workspace).toMatchObject({
      nodeId: "create-workspace",
      input: { request: "fix the login bug" },
    });
  });

  test("a ticket bundle registers as an artifact and its task text reaches create-workspace", async () => {
    const { repo, step } = taskRun("work on ENG-1");
    const dir = join(runDirOf(repo, "feat-x"), "artifacts", "ticket");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ticket.json"), JSON.stringify(TICKET));
    expect(await validateTicketDir(dir)).toMatchObject({ ok: true });
    const task = "Add export\n\nExport to CSV";

    const workspace = finishFetcher(
      step,
      {
        task,
        ticket: {
          provider: "linear",
          key: "ENG-1",
          url: TICKET.url,
          path: "artifacts/ticket/ticket.json",
          complete: true,
        },
      },
      ["--artifact", "ticket=artifacts/ticket/ticket.json"],
    );

    expect(workspace).toMatchObject({ nodeId: "create-workspace", input: { request: task } });
  });
});

describe("orchestrate hook session-start", () => {
  const RUN_ENV = { HARNESS_RUN_ID: "r-1" };
  const START = JSON.stringify({ session_id: "B", source: "clear", cwd: "/x" });

  const sessionStart = (
    run: Readonly<{ repo: string; home: string }>,
    input = START,
    env: Env = RUN_ENV,
  ) =>
    orchestrate(
      run.repo,
      run.home,
      ["hook", "session-start", "--agent", "claude", "--handler", "link-session"],
      env,
      input,
    );

  test("SC10: a new session id after /clear is linked to its run and its Stop hook call is recognized", async () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "A"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);

    const result = sessionStart(run);

    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect(readRegistry(run.home).runs["r-1"]?.sessions).toEqual([
      { agent: "claude", sessionId: "A" },
      { agent: "claude", sessionId: "B" },
    ]);
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "hooks.session-start.called",
      payload: { agent: "claude", sessionId: "B", source: "clear" },
    });
    const stop = orchestrate(
      run.repo,
      run.home,
      ["hook", "stop", "--agent", "claude", "--handler", "continue-workflow"],
      RUN_ENV,
      JSON.stringify({ session_id: "B" }),
    );
    expect(stop.code).toBe(0);
    expect((await eventsOf(run.repo)).at(-1)?.type).toBe("hooks.stop.called");
  });

  test("SC11: a session with no run, or a run with no name yet, is left alone", async () => {
    const run = startedRun(ONE_AGENT);
    const before = (await eventsOf(run.repo)).length;
    const registryBefore = readRegistry(run.home);

    expect(sessionStart(run, START, {})).toMatchObject({ code: 0, stdout: "" });
    expect(sessionStart(run, START, { HARNESS_RUN_ID: "unknown" })).toMatchObject({
      code: 0,
      stdout: "",
    });

    expect(readRegistry(run.home)).toEqual(registryBefore);
    expect(await eventsOf(run.repo)).toHaveLength(before);

    const home = tempDir();
    writeRegistry(home, [savedRun(run.repo)]);
    expect(sessionStart({ repo: run.repo, home })).toMatchObject({ code: 0, stdout: "" });
    expect(readRegistry(home).runs["r-1"]?.sessions).toEqual([]);
  });

  test("SC12: input that is not JSON prints nothing and exits 0", () => {
    const run = startedRun(ONE_AGENT);

    expect(sessionStart(run, "not json")).toMatchObject({ code: 0, stdout: "" });
  });
});

const withContext = (node: string) => `name: context
inputs:
  prompt: { type: string, required: true }
nodes:
  - { id: first, type: agent, prompt: one, input: {} }
  - { id: fresh, type: context, ${node}, dependsOn: [first] }
  - { id: second, type: agent, prompt: two, dependsOn: [fresh], input: {} }
`;

const FAKE_AGENT = join(import.meta.dir, "agents", "fixtures", "fake-agent.ts");
const RESUME = "/orchestrate-v2 --resume feat-x";

// A run whose agent is the fake agent in a private tmux pane, driven to its context node.
const runToContextNode = async (node: string, socket: string) => {
  const run = startedRun(withContext(node));
  const out = join(tempDir(), "agent.jsonl");
  const tmux = (...args: string[]) =>
    execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8" });
  tmux(
    ...["new-session", "-d", "-s", "agent", "-x", "200", "-y", "50", "-c", run.repo],
    ...["-e", `FAKE_AGENT_OUT=${out}`, "--", "bun", FAKE_AGENT],
  );
  const socketPath = tmux("display-message", "-p", "-t", "agent", "#{socket_path}").trim();
  const pane = tmux("display-message", "-p", "-t", "agent", "#{pane_id}").trim();
  const inPane = {
    TMUX: `${socketPath},1,0`,
    TMUX_PANE: pane,
    HARNESS_CLAUDE_BIN: FAKE_AGENT,
  };
  const step = (args: readonly string[], env: Env = {}, input = "") =>
    orchestrate(run.repo, run.home, args, { HARNESS_RUN_ID: "r-1", ...env }, input);
  const next = () => JSON.parse(step(["next", "--run", "feat-x"]).stdout);
  const records = (): Array<Record<string, unknown>> =>
    existsSync(out)
      ? readFileSync(out, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line))
      : [];
  const typed = () =>
    records()
      .map((record) => record.line)
      .filter((line): line is string => typeof line === "string");
  const launches = () => records().filter((record) => Array.isArray(record.argv));

  expect(
    step(["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "A"]).code,
  ).toBe(0);
  await waitFor(() => launches().length === 1);
  await Bun.sleep(300);
  const first = next();
  expect(step(["done", first.nodeRunId, "--run", "feat-x", "--output", "{}"]).code).toBe(0);
  const context = next();
  const stop = () =>
    step(
      ["hook", "stop", "--agent", "claude", "--handler", "continue-workflow"],
      inPane,
      JSON.stringify({ session_id: "A" }),
    );
  // What Claude does once a new session starts or a compact finishes: run its SessionStart hook.
  const sessionStart = (sessionId: string, source: string) =>
    step(
      ["hook", "session-start", "--agent", "claude", "--handler", "link-session"],
      inPane,
      JSON.stringify({ session_id: sessionId, source }),
    );
  return { run, step, next, stop, sessionStart, typed, launches, context };
};

const contextOutput = async (repo: string) =>
  (await eventsOf(repo)).find(
    (event) => event.type === "workflow.node.completed" && event.nodeId === "fresh",
  )?.payload;

describe("context node through a real tmux pane", () => {
  test("new: the helper restarts the agent in its pane on a new session, whose SessionStart completes the node", async () => {
    const socket = `harness-e2e-${crypto.randomUUID()}`;
    try {
      const flow = await runToContextNode("action: new", socket);
      expect(flow.context).toMatchObject({ kind: "context", action: "new", nodeId: "fresh" });

      expect(flow.stop()).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.launches().length === 2);

      const argv = flow.launches()[1]?.argv as string[];
      const sessionId = argv[argv.indexOf("--session-id") + 1] ?? "";
      expect(argv.at(-1)).toBe(RESUME);
      expect(await contextOutput(flow.run.repo)).toBeUndefined();
      expect(flow.sessionStart(sessionId, "startup")).toMatchObject({ code: 0, stdout: "" });
      expect(flow.launches()[1]?.runId).toBe("r-1");
      expect(flow.typed()).toEqual([]);
      expect(stateOf(flow.run.repo).activeSessions).toEqual([{ agent: "claude", sessionId }]);
      expect(await contextOutput(flow.run.repo)).toMatchObject({
        output: { action: "new", applied: true, sessionId },
      });
      expect(flow.next()).toMatchObject({ kind: "agent", nodeId: "second" });
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 30_000);

  test("compact: the helper types /compact; the compact's SessionStart completes the node and types the resume prompt", async () => {
    const socket = `harness-e2e-${crypto.randomUUID()}`;
    try {
      const flow = await runToContextNode('action: compact, prompt: "keep the plan"', socket);
      expect(flow.context).toMatchObject({ kind: "context", action: "compact" });
      const sessionsBefore = stateOf(flow.run.repo).activeSessions;

      expect(flow.stop()).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.typed().includes("/compact keep the plan"));
      expect(flow.sessionStart("A", "compact")).toMatchObject({ code: 0, stdout: "" });
      await waitFor(() => flow.typed().includes(RESUME));

      expect(flow.typed()).toEqual(["/compact keep the plan", RESUME]);
      expect(stateOf(flow.run.repo).activeSessions).toEqual(sessionsBefore);
      expect(await contextOutput(flow.run.repo)).toMatchObject({
        output: { action: "compact", applied: true, sessionId: "A" },
      });
      expect(flow.next()).toMatchObject({ kind: "agent", nodeId: "second" });
    } finally {
      spawnSync("tmux", ["-L", socket, "kill-server"]);
    }
  }, 30_000);
});

describe("orchestrate hook stop-failure", () => {
  // The test itself may run inside tmux; the helper must not find this pane and type into it.
  const RUN_ENV = { HARNESS_RUN_ID: "r-1", TMUX: undefined, TMUX_PANE: undefined };

  test("a usage limit is logged as agent.limit.reached and its detached wait starts, which with no terminal only logs why it cannot type", async () => {
    const run = startedRun(ONE_AGENT);
    const link = ["link-session", "--run", "feat-x", "--agent", "claude", "--session-id", "A"];
    expect(orchestrate(run.repo, run.home, link).code).toBe(0);

    const result = orchestrate(
      run.repo,
      run.home,
      ["hook", "stop-failure", "--agent", "claude", "--handler", "resume-after-limit"],
      RUN_ENV,
      JSON.stringify({
        session_id: "A",
        error: "rate_limit",
        last_assistant_message: "resets 3pm (UTC)",
      }),
    );

    expect(result).toMatchObject({ code: 0, stdout: "" });
    expect((await eventsOf(run.repo)).at(-1)).toMatchObject({
      type: "agent.limit.reached",
      payload: {
        agent: "claude",
        sessionId: "A",
        error: "rate_limit",
        message: "resets 3pm (UTC)",
      },
    });
    const log = join(runDirOf(run.repo, "feat-x"), "limit-wait.log");
    await waitFor(
      () => existsSync(log) && readFileSync(log, "utf8").includes("no terminal to type into"),
    );
  }, 20_000);
});

describe("orchestrate statusline", () => {
  const runWithRunningNode = () => {
    const repo = tempRepo();
    const home = tempDir();
    writeRegistry(home, [savedRun(repo)]);
    orchestrate(repo, home, ["init", "feat-x", "--run-id", "r-1"]);
    const dir = runDirOf(repo, "feat-x");
    const statePath = join(dir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    state.nodeRuns = {
      design: {
        nodeRunId: "nr-1",
        nodeType: "agent",
        status: "running",
        startedAt: new Date().toISOString(),
        completedAt: null,
        artifacts: [],
      },
    };
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(
      join(dir, "workflow.yaml"),
      "name: ok\nnodes:\n  - id: design\n    type: agent\n    input: {}\n    prompt: do it\n  - id: plan\n    type: agent\n    input: {}\n    prompt: do it\n",
    );
    return { repo, home, statePath };
  };

  test("SC9: prints the run and its running node from Claude's stdin, and exits 0", () => {
    const { repo, home } = runWithRunningNode();
    const stdin = JSON.stringify({ model: { display_name: "Opus" } });

    const result = orchestrate(repo, home, ["statusline"], { HARNESS_RUN_ID: "r-1" }, stdin);

    expect(result.code).toBe(0);
    expect(stripVTControlCharacters(result.stdout)).toMatch(
      /^harness feat-x ▸ design \[░░░░░░░░░░\] 0\/2 · \d+s · Opus\n$/,
    );
  });

  test("SC9: with HARNESS_RUN_ID unset it prints nothing and exits 0", () => {
    const { repo, home } = runWithRunningNode();

    const result = orchestrate(repo, home, ["statusline"], {}, "{}");

    expect(result).toMatchObject({ code: 0, stdout: "" });
  });

  test("SC9: a corrupt state.json prints the run name alone and exits 0", () => {
    const { repo, home, statePath } = runWithRunningNode();
    writeFileSync(statePath, "{ corrupt");

    const result = orchestrate(repo, home, ["statusline"], { HARNESS_RUN_ID: "r-1" }, "{}");

    expect(result).toMatchObject({ code: 0, stdout: "harness feat-x\n" });
  });

  test("SC9: a corrupt registry prints the starting line and exits 0", () => {
    const { repo, home } = runWithRunningNode();
    writeFileSync(join(home, "registry.json"), "{ corrupt");

    const result = orchestrate(repo, home, ["statusline"], { HARNESS_RUN_ID: "r-1" }, "{}");

    expect(result).toMatchObject({ code: 0, stdout: "harness · starting\n" });
  });
});
