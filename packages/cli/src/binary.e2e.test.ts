import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DoctorJsonSchema } from "@yok/core";
import { runDirOf, type WorkflowRun } from "@yok/sdk";
import { jsonlEventStore, VERSION } from "@yok/sdk/internal";

const ENTRY = join(import.meta.dir, "index.ts");
const TOOLS = ["git", "jq", "sh", "tmux"] as const;
const dirs: string[] = [];
let BIN = "";

const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

// The tools this test runs next to the yok binary, which is on it too; never bun or node.
const cleanPath = (): string => {
  const bin = temp("yok-bin-");
  for (const tool of TOOLS) {
    const found = Bun.which(tool);
    if (found !== null) symlinkSync(found, join(bin, tool));
  }
  symlinkSync(BIN, join(bin, "yok"));
  return `${bin}:/usr/bin:/bin`;
};

const writeFiles = (dir: string, files: Readonly<Record<string, string>>): void => {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
};

export const pluginHome = (stages: Readonly<Record<string, Record<string, string>>>): string => {
  const home = temp("yok-claude-");
  for (const [stage, files] of Object.entries(stages)) {
    writeFiles(join(home, "plugins", "cache", "yok", "yok", VERSION, "skills", stage), files);
  }
  return home;
};

// The parent's Slack keys or BUN_BE_BUN must not reach the binary: each would change what it does.
const baseEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).flatMap(([key, value]) =>
      value === undefined || key === "BUN_BE_BUN" || key.startsWith("SLACK_") ? [] : [[key, value]],
    ),
  );

export const runBinary = (
  args: readonly string[],
  opts: Readonly<{ cwd: string; env?: Readonly<Record<string, string>>; input?: string }>,
) => {
  const result = spawnSync(BIN, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    input: opts.input ?? "",
    env: {
      ...baseEnv(),
      FORCE_COLOR: "0",
      PATH: cleanPath(),
      YOK_HOME: temp("yok-home-"),
      CODEX_HOME: temp("yok-codex-"),
      ...opts.env,
    },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

const tempRepo = (files: Readonly<Record<string, string>> = {}): string => {
  const dir = temp("yok-proj-");
  writeFiles(dir, { ".gitignore": ".yok/\n", ...files });
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return dir;
};

const savedRun = (cwd: string, workflowPath: string): WorkflowRun => ({
  id: "r-1",
  workflow: "alone",
  workflowPath,
  inputs: { prompt: "hi" },
  cwd,
  sessions: [],
  name: null,
  terminal: null,
  config: null,
  tiers: null,
  createdAt: new Date().toISOString(),
});

const writeRegistry = (home: string, runs: readonly WorkflowRun[]): void => {
  mkdirSync(home, { recursive: true });
  const file = { version: 1, runs: Object.fromEntries(runs.map((run) => [run.id, run])) };
  writeFileSync(join(home, "registry.json"), JSON.stringify(file));
};

const stageFiles = (outModule: string): Record<string, string> => ({
  "SKILL.md": [
    "---",
    "name: alone-stage",
    "description: a stage only the plugin folder holds",
    "mode: inline",
    "allowed-tools: [Bash]",
    "tier: fast",
    "outputs: { description: out, schema: alone.output.v1, module: scripts/out.ts }",
    "protocols: []",
    "scopes: []",
    "---",
    "# alone-stage",
  ].join("\n"),
  "scripts/out.ts": outModule,
});

const OUT_MODULE = `import { NonEmptyStringSchema } from "@yok/sdk";
import { z } from "zod";
export const schemas = {
  "alone.output.v1": z.object({
    title: NonEmptyStringSchema.refine((value) => value.startsWith("t"), "alone-stage wants a title starting with t"),
  }),
};
`;

const BUN_NODE = `  - id: count
    type: exec
    runtime: bun
    output: { zodSchema: Json }
    input: {}
    script: |
      import { NonEmptyStringSchema } from "@yok/sdk";
      process.stdout.write(JSON.stringify({ n: NonEmptyStringSchema.parse("abc").length }));
`;

const AGENT_NODE = (dependsOn: string) => `  - id: write
    type: agent
    stage: alone-stage
    input: {}${dependsOn}
`;

const workflow = (nodes: string): string =>
  `name: alone\ninputs:\n  prompt: { type: string, required: true }\nnodes:\n${nodes}`;

const SUBSCRIBER_MODULE = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NonEmptyStringSchema } from "@yok/sdk";
import { z } from "zod";
export const record = ({ run }) => {
  writeFileSync(join(run.cwd, "subscriber.json"), JSON.stringify({
    self: process.env.YOK_SELF,
    parsed: z.string().parse(NonEmptyStringSchema.parse("x")),
  }));
};
`;

type RunOptions = Readonly<{ nodes: string; outModule?: string; files?: Record<string, string> }>;

// A registered run named feat-x whose stage comes only from the plugin folder.
const registerRun = (options: RunOptions) => {
  const repo = tempRepo({ "alone.yaml": workflow(options.nodes), ...options.files });
  const home = temp("yok-home-");
  writeRegistry(home, [savedRun(repo, join(repo, "alone.yaml"))]);
  const env = {
    YOK_HOME: home,
    YOK_RUN_ID: "",
    CLAUDE_CONFIG_DIR: pluginHome({ "alone-stage": stageFiles(options.outModule ?? OUT_MODULE) }),
  };
  const step = (args: readonly string[]) =>
    runBinary(["orchestrate", ...args, ...(args[0] === "init" ? [] : ["--run", "feat-x"])], {
      cwd: repo,
      env,
    });
  return { repo, home, env, step };
};

const startRun = (options: RunOptions) => {
  const run = registerRun(options);
  const init = run.step(["init", "feat-x", "--run-id", "r-1"]);
  if (init.code !== 0) throw new Error(`init failed: ${init.stderr}`);
  return run;
};

const stateOf = (repo: string) =>
  JSON.parse(readFileSync(join(runDirOf(repo, "feat-x"), "state.json"), "utf8"));

beforeAll(() => {
  if (process.env.YOK_BIN) {
    BIN = process.env.YOK_BIN;
    return;
  }
  BIN = join(temp("yok-build-"), "yok");
  const built = spawnSync(
    "bun",
    [
      "build",
      ENTRY,
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile",
      BIN,
    ],
    { encoding: "utf8" },
  );
  if (built.status !== 0) throw new Error(`compile failed: ${built.stderr}`);
}, 120_000);

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the compiled yok binary", () => {
  test("SC90: prints its version and runs doctor with no bun or node on PATH", () => {
    const path = cleanPath();
    const found = spawnSync("sh", ["-c", "command -v bun || command -v node"], {
      env: { PATH: path },
    });
    expect(found.status).not.toBe(0);
    const cwd = tempRepo();

    expect(runBinary(["--version"], { cwd })).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    const doctor = DoctorJsonSchema.parse(
      JSON.parse(runBinary(["doctor", "--json"], { cwd }).stdout),
    );
    expect(doctor.results.map((row) => row.name)).toContain("git");
  }, 60_000);

  test("never runs a preload from the project's bunfig.toml", () => {
    const cwd = tempRepo({
      "bunfig.toml": 'preload = ["./pre.ts"]\n',
      "pre.ts": 'require("node:fs").writeFileSync("preloaded", "");\n',
    });

    expect(runBinary(["--version"], { cwd }).code).toBe(0);
    expect(existsSync(join(cwd, "preloaded"))).toBe(false);
  }, 60_000);

  test("verifies a workflow of project stages with no plugin installed", () => {
    const stage = Object.fromEntries(
      Object.entries(stageFiles(OUT_MODULE)).map(([name, text]) => [
        `stages/alone-stage/${name}`,
        text,
      ]),
    );
    const nodes =
      "  - id: write\n    type: agent\n    stage: ./stages/alone-stage\n    input: {}\n";
    const cwd = tempRepo({ "alone.yaml": workflow(nodes), ...stage });

    const verified = runBinary(["verify", "alone.yaml"], {
      cwd,
      env: { CLAUDE_CONFIG_DIR: temp("yok-claude-") },
    });

    expect([verified.code, verified.stderr]).toEqual([0, ""]);
  }, 60_000);

  test("SC91: drives a workflow whose stage comes from the plugin folder and whose schema module imports the SDK", () => {
    const { repo, step } = startRun({
      nodes: `${BUN_NODE}${AGENT_NODE("\n    dependsOn: [count]")}`,
    });

    const count = JSON.parse(step(["next"]).stdout);
    expect(count).toMatchObject({ kind: "exec", nodeId: "count" });
    const exec = step(["exec", count.nodeRunId]);
    expect(exec.stderr).toBe("");
    expect(stateOf(repo).nodeRuns.count.output).toEqual({ n: 3 });

    const next = step(["next"]);
    expect(next.stderr).toBe("");
    const agent = JSON.parse(next.stdout);
    expect(agent).toMatchObject({ nodeId: "write", stage: "alone-stage" });

    const refused = step(["done", agent.nodeRunId, "--output", '{"title":"x"}']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("alone-stage wants a title starting with t");

    const done = step(["done", agent.nodeRunId, "--output", '{"title":"tea"}']);
    expect([done.code, done.stderr]).toEqual([0, ""]);
    expect(JSON.parse(step(["next"]).stdout)).toEqual({ kind: "finished", status: "completed" });
  }, 60_000);

  test("SC92: runs a module subscriber and loads yok:notifier", async () => {
    const config = {
      version: 2,
      subscribers: {
        "workflow.node.completed": [
          { name: "probe", module: "subscribers/probe.ts", handler: "record", blocking: true },
        ],
      },
      notifier: { enabled: true, type: "slack" },
    };
    const { repo, step } = startRun({
      nodes: AGENT_NODE(""),
      files: {
        "subscribers/probe.ts": SUBSCRIBER_MODULE,
        "orchestrate.config.json": JSON.stringify(config),
      },
    });
    const agent = JSON.parse(step(["next"]).stdout);

    const done = step(["done", agent.nodeRunId, "--output", '{"title":"tea"}']);

    expect([done.code, done.stderr]).toEqual([0, ""]);
    const subscriber = JSON.parse(readFileSync(join(repo, "subscriber.json"), "utf8"));
    expect(subscriber.parsed).toBe("x");
    expect(JSON.parse(subscriber.self)).toEqual([realpathSync(BIN)]);
    const store = jsonlEventStore(runDirOf(repo, "feat-x"));
    const notifierCall = async () =>
      (await store.read()).find(
        (event) =>
          event.type === "subscriber.called" &&
          JSON.stringify(event.payload).includes('"subscriber":"notifier"'),
      );
    const deadline = Date.now() + 5000;
    let call = await notifierCall();
    while (call === undefined && Date.now() < deadline) {
      await Bun.sleep(100);
      call = await notifierCall();
    }
    expect(call?.payload).toMatchObject({
      subscriber: "notifier",
      status: "failed",
      error: { message: expect.stringContaining("SLACK_BOT_TOKEN") },
    });
    expect(JSON.stringify(call?.payload)).not.toContain("module not found");
  }, 60_000);

  test("SC93: refuses a module importing @yok/sdk/internal", () => {
    const { step } = registerRun({
      nodes: AGENT_NODE(""),
      outModule: `import { VERSION } from "@yok/sdk/internal";\nexport const schemas = { "alone.output.v1": VERSION };\n`,
    });

    const init = step(["init", "feat-x", "--run-id", "r-1"]);

    expect(init.code).toBe(1);
    expect(init.stderr).toContain("scripts/out.ts");
    expect(init.stderr).toContain("failed to load");
  }, 60_000);

  test("SC94: yok view serves the run page and its script", async () => {
    const { repo, env } = startRun({ nodes: AGENT_NODE("") });
    try {
      const view = runBinary(["view", "feat-x", "--print"], { cwd: repo, env });
      expect([view.code, view.stderr]).toEqual([0, ""]);
      const url = view.stdout.trim();
      expect(url).toMatch(/^http:\/\/localhost:\d+\/runs\/r-1$/);

      const page = await fetch(url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<html");
      const script = await fetch(new URL("/assets/anchor.js", url));
      expect(script.status).toBe(200);
      expect(script.headers.get("content-type")).toContain("javascript");
    } finally {
      expect(runBinary(["server", "stop"], { cwd: repo, env }).code).toBe(0);
    }
  }, 60_000);

  test("SC95: yok orchestrate script runs a file outside any project", () => {
    const dir = temp("yok-script-");
    writeFileSync(
      join(dir, "x.ts"),
      `import { NonEmptyStringSchema } from "@yok/sdk";
import { z } from "zod";
export const main = (argv) => {
  console.log(z.string().parse(NonEmptyStringSchema.parse(argv[0])));
};
`,
    );
    expect(existsSync(join(dir, "node_modules"))).toBe(false);

    expect(
      runBinary(["orchestrate", "script", join(dir, "x.ts"), "hi"], { cwd: dir }),
    ).toMatchObject({
      code: 0,
      stdout: "hi\n",
    });
  }, 60_000);

  test("SC145: yok run stops before launching when Claude has yok 0.0.0-other turned on", () => {
    const bin = temp("yok-fake-claude-");
    const log = join(bin, "calls.log");
    const claude = join(bin, "claude");
    writeFileSync(
      claude,
      `#!/bin/sh
case "$1" in
  plugin) echo '[{"id":"yok@yok","version":"0.0.0-other","scope":"user","enabled":true}]' ;;
  --version) echo "2.1.288 (Claude Code)" ;;
  *) echo "$*" >> "${log}" ;;
esac
`,
    );
    chmodSync(claude, 0o755);
    const cwd = tempRepo({
      "orchestrate.config.json": '{ "version": 2 }\n',
      "ok.yaml":
        'name: ok\nnodes:\n  - id: a\n    type: exec\n    runtime: sh\n    script: "true"\n    input: null\n',
    });

    const run = runBinary(["run", "ok.yaml", "--prompt", "hi", "--no-open"], {
      cwd,
      env: { YOK_CLAUDE_BIN: claude },
    });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("BLOCKED");
    expect(run.stderr).toContain("claude-plugin: claude has yok 0.0.0-other");
    expect(run.stderr).toContain("yok plugin install --agent claude");
    expect(existsSync(log)).toBe(false);
  }, 60_000);
});
