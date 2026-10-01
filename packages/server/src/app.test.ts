import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureLogger } from "@harness/core";
import type { IAgentProvider, ITerminal, LaunchOptions, Result } from "@harness/sdk";
import { createRegistry, noopLogger } from "@harness/sdk";
import { createApp } from "./app.ts";
import { createHarnessClient } from "./client.ts";
import { socketPath } from "./protocol.ts";

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
  rename: () => Promise.resolve({ ok: true, value: undefined }),
  respawn: () => Promise.resolve({ ok: true, value: undefined }),
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
  relaunch: () => Promise.resolve({ ok: true, value: undefined }),
  prompt: () => Promise.resolve({ ok: true, value: undefined }),
  stop: () => Promise.resolve({ ok: true, value: undefined }),
  run: () => Promise.resolve({ ok: false, error: new Error("not implemented") }),
});

const buildDeps = async (
  launch: (options: LaunchOptions) => Promise<Result<{ sessionId: string }>>,
  log = noopLogger,
) => {
  const registryPath = join(mkdtempSync(join(tmpdir(), "harness-registry-")), "registry.json");
  const registry = createRegistry(registryPath, log);
  return {
    registryPath,
    registry,
    provider: fakeProvider(launch),
    terminal: fakeTerminal(),
    log,
    home: "/home/.harness",
    pid: 4242,
    version: "0.0.0-test",
  };
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
      run: { id: string; sessions: unknown[]; terminal: string | null };
      attach: string[];
    };
    expect(json.run.sessions).toEqual([{ agent: "claude", sessionId: "session-xyz" }]);
    expect(json.run.terminal).toBe("session-xyz");
    expect(json.attach).toEqual(["tmux", "attach-session", "-t", "session-xyz"]);

    const [launchOptions] = seen;
    expect(launchOptions?.cwd).toBe(cwd);
    expect(launchOptions?.prompt).toBe(
      `/orchestrate-v2 --workflow ${workflowPath} --inputs ${JSON.stringify({ a: 1 })}`,
    );
    expect(launchOptions?.env?.HARNESS_RUN_ID).toBe(json.run.id);

    expect((await deps.registry.findRun(json.run.id))?.terminal).toBe("session-xyz");
  });

  test("the run is in the registry before its agent starts, so the agent's orchestrate init finds it", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    let savedAtLaunch: unknown;
    const deps = await buildDeps(async (options) => {
      savedAtLaunch = await deps.registry.findRun(String(options.env?.HARNESS_RUN_ID));
      return { ok: true, value: { sessionId: "s1" } };
    });
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath, inputs: {}, cwd }),
    });

    expect(res.status).toBe(201);
    expect(savedAtLaunch).toMatchObject({ workflowPath, cwd, sessions: [], name: null });
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

      const refused = await client.run({
        workflow: "ok",
        workflowPath: join(cwd, "missing.yaml"),
        inputs: {},
        cwd,
      });
      expect(refused).toEqual({
        ok: false,
        error: { code: "bad-request", message: "workflowPath and cwd must exist" },
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
