import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLogger } from "@harness/core";
import type { IAgentProvider, IGit, ITerminal, LaunchOptions, Result } from "@harness/sdk";
import { createGit, noopLogger } from "@harness/sdk";
import { createApp } from "./app.ts";
import { createHarnessClient } from "./client.ts";
import { type SessionRef, socketPath, type WorkflowRun } from "./protocol.ts";
import { createRegistry } from "./registry.ts";

const tempWorkspace = (): { workflowPath: string; cwd: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "harness-app-"));
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(workflowPath, "name: ok\nnodes: []\n");
  return { workflowPath, cwd };
};

const fakeTerminal = (): ITerminal => ({
  checks: [],
  create: () => Promise.resolve({ ok: true, value: undefined }),
  sendText: () => Promise.resolve({ ok: true, value: undefined }),
  sendKeys: () => Promise.resolve({ ok: true, value: undefined }),
  capture: () => Promise.resolve({ ok: true, value: "" }),
  isAlive: () => Promise.resolve(true),
  kill: () => Promise.resolve({ ok: true, value: undefined }),
  list: () => Promise.resolve([]),
  attachCommand: (name) => ["tmux", "attach-session", "-t", name],
});

const fakeProvider = (
  launch: (options: LaunchOptions) => Promise<Result<{ sessionId: string }>>,
): IAgentProvider => ({
  type: "claude",
  checks: [],
  launch,
  prompt: () => Promise.resolve({ ok: true, value: undefined }),
  stop: () => Promise.resolve({ ok: true, value: undefined }),
  run: () => Promise.resolve({ ok: false, error: new Error("not implemented") }),
});

const fakeGit = (): IGit => ({
  repoRoot: (cwd) => Promise.resolve(cwd),
  commonDir: () => Promise.resolve(null),
  currentBranch: () => Promise.resolve({ ok: true, value: "main" }),
  headSha: () => Promise.resolve({ ok: true, value: "0000000" }),
  defaultBranch: () => Promise.resolve(null),
  isValidBranchName: () => Promise.resolve(true),
  branchExists: () => Promise.resolve(false),
  isIgnored: () => Promise.resolve(false),
  addWorktree: () => Promise.resolve({ ok: true, value: undefined }),
  listWorktrees: () => Promise.resolve({ ok: true, value: [] }),
  removeWorktree: () => Promise.resolve({ ok: true, value: undefined }),
});

const buildDeps = async (
  launch: (options: LaunchOptions) => Promise<Result<{ sessionId: string }>>,
  log = noopLogger,
  git: IGit = fakeGit(),
) => {
  const registryPath = join(mkdtempSync(join(tmpdir(), "harness-registry-")), "registry.json");
  const registry = createRegistry(registryPath, log);
  return {
    registryPath,
    registry,
    provider: fakeProvider(launch),
    terminal: fakeTerminal(),
    git,
    log,
    home: "/home/.harness",
    pid: 4242,
    version: "0.0.0-test",
  };
};

const gitCmd = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeGitRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "harness-app-repo-"));
  gitCmd(dir, "init", "-q", "-b", "main");
  gitCmd(
    dir,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  return dir;
};

const startRun = async (
  app: ReturnType<typeof createApp>,
  body: { workflow: string; workflowPath: string; inputs: Record<string, unknown>; cwd: string },
): Promise<{ id: string; sessions: readonly SessionRef[]; name: WorkflowRun["name"] }> => {
  const res = await app.request("/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    run: { id: string; sessions: SessionRef[]; name: WorkflowRun["name"] };
  };
  return json.run;
};

describe("POST /runs", () => {
  test("a body that is not JSON is 400 bad-request in the API's error shape", async () => {
    const app = createApp(await buildDeps(() => Promise.resolve({ ok: false, error: "unused" })));
    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad-request");
  });

  test("SC9: a relative workflowPath is 400 bad-request", async () => {
    const { cwd } = tempWorkspace();
    const deps = await buildDeps(() => Promise.resolve({ ok: true, value: { sessionId: "s1" } }));
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath: "ok.yaml", inputs: {}, cwd }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("bad-request");
  });

  test("SC10: a working provider launches with the orchestrate-v2 prompt and returns the run and attach command", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return Promise.resolve({ ok: true, value: { sessionId: "session-xyz" } });
    });
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath, inputs: { a: 1 }, cwd }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      run: { id: string; sessions: unknown[] };
      attach: string[];
    };
    expect(json.run.sessions).toEqual([{ agent: "claude", sessionId: "session-xyz" }]);
    expect(json.attach).toEqual(["tmux", "attach-session", "-t", "session-xyz"]);

    const [launchOptions] = seen;
    expect(launchOptions?.cwd).toBe(cwd);
    expect(launchOptions?.prompt).toBe(
      `/orchestrate-v2 --workflow ${workflowPath} --inputs ${JSON.stringify({ a: 1 })}`,
    );
    expect(launchOptions?.env?.HARNESS_RUN_ID).toBe(json.run.id);

    expect(await deps.registry.findRun(json.run.id)).toBeDefined();
  });

  test("init called by the agent while it is still starting finds its run", async () => {
    const cwd = makeGitRepo();
    const workflowPath = join(cwd, "ok.yaml");
    writeFileSync(workflowPath, "name: ok\nnodes: []\n");
    let initStatus = 0;
    let app: ReturnType<typeof createApp> | undefined;
    const deps = await buildDeps(
      async (options) => {
        const res = await app?.request(`/runs/${options.env?.HARNESS_RUN_ID}/init`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "early" }),
        });
        initStatus = res?.status ?? 0;
        return { ok: true, value: { sessionId: "s1" } };
      },
      noopLogger,
      createGit(),
    );
    app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath, inputs: {}, cwd }),
    });

    expect(res.status).toBe(201);
    expect(initStatus).toBe(201);
  });

  test("SC11: a failing provider is 502 agent-failed and records no run", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }));
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath, inputs: {}, cwd }),
    });

    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("agent-failed");
    const saved = existsSync(deps.registryPath)
      ? JSON.parse(readFileSync(deps.registryPath, "utf8")).runs
      : {};
    expect(saved).toEqual({});
  });

  test("a handler that throws answers 500 with an internal error body and logs it", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const { log, at } = captureLogger();
    const deps = await buildDeps(() => Promise.reject(new Error("tmux timed out")), log);
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath, inputs: {}, cwd }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "tmux timed out" } });
    expect(at("error").some((line) => line.msg === "request failed with an unexpected error")).toBe(
      true,
    );
    expect(JSON.parse(readFileSync(deps.registryPath, "utf8")).runs).toEqual({});
  });
});

describe("POST /runs logging", () => {
  test("SC36: a working provider logs 'run started' and an http 201 line with x-request-id", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const { log, lines, at } = captureLogger();
    const deps = await buildDeps(
      () => Promise.resolve({ ok: true, value: { sessionId: "s1" } }),
      log,
    );
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath, inputs: {}, cwd }),
    });

    expect(res.headers.get("x-request-id")).toBeString();
    const runStarted = at("info").find((line) => line.msg === "run started");
    expect(runStarted).toMatchObject({ runId: expect.any(String), sessionId: "s1" });
    const httpLine = at("info").find(
      (line) => line.component === "http" && line.msg === "request finished",
    );
    expect(httpLine).toMatchObject({ status: 201 });
    void lines;
  });

  test("SC36: a failing provider logs one error line 'launch failed'", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const { log, at } = captureLogger();
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }), log);
    const app = createApp(deps);

    await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath, inputs: {}, cwd }),
    });

    const failures = at("error").filter(
      (line) => line.msg === "run not started: the agent session failed to launch",
    );
    expect(failures).toHaveLength(1);
  });
});

describe("POST /runs/:id/init", () => {
  test("SC19: writes workflow.yaml, one workflow.started event, and a state.json with lastEventSeq 1", async () => {
    const cwd = makeGitRepo();
    const workflowPath = join(cwd, "ok.yaml");
    writeFileSync(workflowPath, "name: ok\nnodes: []\n");
    const deps = await buildDeps(
      () => Promise.resolve({ ok: true, value: { sessionId: "s1" } }),
      noopLogger,
      createGit(),
    );
    const app = createApp(deps);
    const run = await startRun(app, { workflow: "ok", workflowPath, inputs: {}, cwd });

    const res = await app.request(`/runs/${run.id}/init`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "fix-login" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      dir: string;
      state: { lastEventSeq: number; specName: string };
    };
    const dir = join(cwd, ".harness", "fix-login");
    expect(body.dir).toBe(dir);
    expect(readFileSync(join(dir, "workflow.yaml"), "utf8")).toBe(
      readFileSync(workflowPath, "utf8"),
    );

    const eventLines = readFileSync(join(dir, "event.jsonl"), "utf8").trim().split("\n");
    expect(eventLines).toHaveLength(1);
    const event = JSON.parse(eventLines[0] as string) as {
      type: string;
      seq: number;
      runId: string;
      ts: string;
    };
    expect(event.type).toBe("workflow.started");
    expect(event.runId).toBe(run.id);
    expect(event.seq).toBe(1);

    expect(body.state.lastEventSeq).toBe(1);
    expect(body.state.specName).toBe("fix-login");
  });

  test("SC20: a second init is 409, a pre-existing run folder is 409, a bad name is 400, an unknown run is 404", async () => {
    const cwd = makeGitRepo();
    const workflowPath = join(cwd, "ok.yaml");
    writeFileSync(workflowPath, "name: ok\nnodes: []\n");
    const deps = await buildDeps(() => Promise.resolve({ ok: true, value: { sessionId: "s1" } }));
    const app = createApp(deps);
    const run = await startRun(app, { workflow: "ok", workflowPath, inputs: {}, cwd });

    const init = async (runId: string, name: string) =>
      app.request(`/runs/${runId}/init`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });

    const first = await init(run.id, "fix-login");
    expect(first.status).toBe(201);

    const second = await init(run.id, "fix-login-2");
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("conflict");

    const otherRun = await startRun(app, { workflow: "ok", workflowPath, inputs: {}, cwd });
    mkdirSync(join(cwd, ".harness", "dupe"), { recursive: true });
    const dupe = await init(otherRun.id, "dupe");
    expect(dupe.status).toBe(409);
    expect(((await dupe.json()) as { error: { code: string } }).error.code).toBe("conflict");

    const badName = await init(otherRun.id, "Bad Name");
    expect(badName.status).toBe(400);

    const unknown = await init("r-missing", "fix-login");
    expect(unknown.status).toBe(404);
  });
});

describe("POST /runs/:id/link-session", () => {
  test("SC22: links a new agent session once and rejects an unknown agent without changing state", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = await buildDeps(() => Promise.resolve({ ok: true, value: { sessionId: "s1" } }));
    const app = createApp(deps);
    const run = await startRun(app, { workflow: "ok", workflowPath, inputs: {}, cwd });

    const link = async (body: Record<string, unknown>) =>
      app.request(`/runs/${run.id}/link-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const first = await link({ agent: "codex", sessionId: "s2" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { run: { sessions: SessionRef[] } };
    expect(firstBody.run.sessions).toContainEqual({ agent: "codex", sessionId: "s2" });

    const second = await link({ agent: "codex", sessionId: "s2" });
    const secondBody = (await second.json()) as { run: { sessions: SessionRef[] } };
    expect(
      secondBody.run.sessions.filter((s) => s.agent === "codex" && s.sessionId === "s2"),
    ).toHaveLength(1);

    const third = await link({ agent: "gpt", sessionId: "s3" });
    expect(third.status).toBe(400);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe("bad-request");
    expect((await deps.registry.findRun(run.id))?.sessions.some((s) => s.sessionId === "s3")).toBe(
      false,
    );
  });
});

describe("createHarnessClient", () => {
  const serveOn = (fetch: (request: Request) => Response | Promise<Response>) => {
    const home = mkdtempSync(join(tmpdir(), "harness-home-"));
    return { home, server: Bun.serve({ unix: socketPath(home), fetch }) };
  };

  test("calls the real routes over the socket and returns their typed bodies", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = await buildDeps(() => Promise.resolve({ ok: true, value: { sessionId: "s1" } }));
    const { home, server } = serveOn(createApp(deps).fetch);
    try {
      const client = createHarnessClient({ home });

      const health = await client.health();
      expect(health).toEqual({ ok: true, value: { pid: 4242, version: "0.0.0-test" } });

      const started = await client.run({ workflow: "ok", workflowPath, inputs: {}, cwd });
      expect(started.ok && started.value.run.sessions).toEqual([
        { agent: "claude", sessionId: "s1" },
      ]);

      const missing = await client.linkSession("r-nope", { agent: "codex", sessionId: "s2" });
      expect(missing).toEqual({
        ok: false,
        error: { code: "not-found", message: "run r-nope not found" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("a non-JSON error reply comes back as an internal error, not a thrown parse error", async () => {
    const { home, server } = serveOn(() => new Response("Internal Server Error", { status: 500 }));
    try {
      expect(await createHarnessClient({ home }).health()).toEqual({
        ok: false,
        error: { code: "internal", message: "500 Internal Server Error" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("no server behind the socket is an unreachable error", async () => {
    const home = mkdtempSync(join(tmpdir(), "harness-home-"));
    expect(await createHarnessClient({ home }).health()).toEqual({
      ok: false,
      error: { code: "internal", message: "server unreachable" },
    });
  });
});
