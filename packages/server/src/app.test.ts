import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { captureLogger } from "@yok/core";
import type { IAgentProvider, ITerminal, LaunchOptions, Result } from "@yok/sdk";
import { noopLogger, WorkflowRunSchema } from "@yok/sdk";
import { createRegistry } from "@yok/sdk/internal";
import * as z from "zod";
import { createApp } from "./app.ts";
import { createYokClient } from "./client.ts";
import { socketPath } from "./protocol.ts";

// A git checkout, as yok run sends: the server reads its config to pick the launch model.
const tempWorkspace = (): { workflowPath: string; cwd: string } => {
  const cwd = mkdtempSync(join(tmpdir(), "yok-app-"));
  execFileSync("git", ["init", "-q"], { cwd });
  const workflowPath = join(cwd, "ok.yaml");
  writeFileSync(workflowPath, "name: ok\nnodes: []\n");
  return { workflowPath, cwd };
};

const done = () => Promise.resolve({ ok: true as const, value: undefined });

const fakePane = (name: string): ITerminal => ({
  sendText: done,
  sendKeys: done,
  capture: () => Promise.resolve({ ok: true, value: "" }),
  isAlive: () => Promise.resolve(true),
  rename: done,
  respawn: done,
  kill: done,
  attachCommand: () => ["tmux", "attach-session", "-t", name],
});

const fakeProvider = (
  type: IAgentProvider["type"],
  launch: (
    options: LaunchOptions,
  ) => Promise<Result<{ terminalName: string; terminal: ITerminal }>>,
): IAgentProvider => ({
  type,
  skillPrefix: type === "codex" ? "$" : "/",
  checks: [],
  launch,
  relaunch: () => Promise.resolve({ ok: true, value: undefined }),
  prompt: () => Promise.resolve({ ok: true, value: undefined }),
  stop: () => Promise.resolve({ ok: true, value: undefined }),
  run: () => Promise.resolve({ ok: false, error: new Error("not implemented") }),
  limitResetWait: () => Promise.resolve(null),
  promptWhenReady: () => Promise.resolve({ ok: true, value: "not-ready" }),
});

const buildDeps = async (
  launch: (
    options: LaunchOptions,
  ) => Promise<Result<{ terminalName: string; terminal: ITerminal }>>,
  log = noopLogger,
) => {
  const registryPath = join(mkdtempSync(join(tmpdir(), "yok-registry-")), "registry.json");
  const registry = createRegistry(registryPath, log);
  const asked: string[] = [];
  return {
    registryPath,
    registry,
    asked,
    providerFor: (agent: IAgentProvider["type"]) => {
      asked.push(agent);
      return fakeProvider(agent, launch);
    },
    log,
    home: mkdtempSync(join(tmpdir(), "yok-home-")),
    viewerOrigin: "http://localhost:1",
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
    const deps = await buildDeps(() =>
      Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
    );
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath: "ok.yaml", inputs: {}, cwd }),
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("bad-request");
  });

  test("SC10: a working provider launches with the orchestrate prompt and returns the run and attach command", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return Promise.resolve({
        ok: true,
        value: { terminalName: "session-xyz", terminal: fakePane("%7") },
      });
    });
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: { a: 1 }, cwd }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      run: { id: string; sessions: unknown[]; terminal: string | null };
      attach: string[];
    };
    expect(json.run.sessions).toEqual([]);
    expect(json.run.terminal).toBe("session-xyz");
    // The pane id, not the session name, so the attach survives init renaming the session.
    expect(json.attach).toEqual(["tmux", "attach-session", "-t", "%7"]);

    const [launchOptions] = seen;
    expect(launchOptions?.cwd).toBe(cwd);
    expect(launchOptions?.prompt).toBe(
      `/orchestrate --workflow ${workflowPath} --inputs ${JSON.stringify({ a: 1 })}`,
    );
    expect(launchOptions?.env?.YOK_RUN_ID).toBe(json.run.id);

    expect((await deps.registry.findRun(json.run.id))?.terminal).toBe("session-xyz");
  });

  test("SC4: the provider for the body's agent launches, no session is linked, and the terminal name is stored", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = await buildDeps(() =>
      Promise.resolve({ ok: true, value: { terminalName: "t-1", terminal: fakePane("t-1") } }),
    );

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        env: {},
        workflowPath,
        inputs: {},
        cwd,
        agent: "codex",
      }),
    });

    expect(res.status).toBe(201);
    const { run } = (await res.json()) as { run: { id: string } };
    expect(deps.asked).toEqual(["codex"]);
    expect(await deps.registry.findRun(run.id)).toMatchObject({ sessions: [], terminal: "t-1" });
  });

  test("SC16: the first prompt invokes the skill the way the agent does: $orchestrate for codex", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    let prompt: string | undefined;
    const deps = await buildDeps((options) => {
      prompt = options.prompt;
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        env: {},
        workflowPath,
        inputs: {},
        cwd,
        agent: "codex",
      }),
    });

    expect(res.status).toBe(201);
    expect(prompt).toBe(`$orchestrate --workflow ${workflowPath} --inputs {}`);
  });

  test("a supplied name reaches the agent as the run name", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    let prompt: string | undefined;
    const deps = await buildDeps((options) => {
      prompt = options.prompt;
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        env: {},
        workflowPath,
        inputs: { prompt: "different" },
        cwd,
        name: "fix-login",
      }),
    });

    expect(res.status).toBe(201);
    expect(prompt).toBe(
      `/orchestrate --workflow ${workflowPath} --inputs ${JSON.stringify({ prompt: "different" })} --name fix-login`,
    );
  });

  test("an invalid supplied name is rejected before launching an agent", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    let launched = false;
    const deps = await buildDeps(() => {
      launched = true;
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        env: {},
        workflowPath,
        inputs: {},
        cwd,
        name: "Bad/Name",
      }),
    });

    expect(res.status).toBe(400);
    expect(launched).toBe(false);
  });

  test("the run is in the registry before its agent starts, so the agent's orchestrate init finds it", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    let savedAtLaunch: unknown;
    const deps = await buildDeps(async (options) => {
      savedAtLaunch = await deps.registry.findRun(String(options.env?.YOK_RUN_ID));
      return { ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } };
    });
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
    });

    expect(res.status).toBe(201);
    expect(savedAtLaunch).toMatchObject({ workflowPath, cwd, sessions: [], name: null });
  });

  test("a config file in the body is saved on the run; with none the run's config is null", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = await buildDeps(() =>
      Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
    );
    const app = createApp(deps);
    const config = join(cwd, "custom.json");
    writeFileSync(config, '{"version": 2}');
    const start = (extra: object) =>
      app.request("/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd, ...extra }),
      });

    const runOf = async (extra: object) =>
      z.object({ run: WorkflowRunSchema }).parse(await (await start(extra)).json()).run;
    const withConfig = await runOf({ config });
    const without = await runOf({});

    expect(withConfig.config).toBe(config);
    expect((await deps.registry.findRun(withConfig.id))?.config).toBe(config);
    expect(without.config).toBeNull();
  });

  // Starts a run of AGENT with the config file CONFIG holds and the request's TIERS; gives back the
  // reply and the launch options the provider saw.
  const startTiered = async (agent: string, config: string, tiers?: object) => {
    const { workflowPath, cwd } = tempWorkspace();
    const configPath = join(cwd, "tiers.yaml");
    writeFileSync(configPath, config);
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });
    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        env: {},
        workflowPath,
        inputs: {},
        cwd,
        agent,
        config: configPath,
        ...(tiers === undefined ? {} : { tiers }),
      }),
    });
    const launched = seen.map(({ model, effort }) => ({ model, effort }));
    return { res, launched, deps };
  };

  test("a claude run with no tiers anywhere launches on the built-in deep tier: claude-opus-5-5 at high effort", async () => {
    const { res, launched } = await startTiered("claude", "version: 2\n");

    expect(res.status).toBe(201);
    expect(launched).toEqual([{ model: "claude-opus-5-5", effort: "high" }]);
  });

  test("a codex run with no tiers anywhere launches on the built-in deep tier: gpt-6-sol at high effort", async () => {
    const { res, launched } = await startTiered("codex", "version: 2\n");

    expect(res.status).toBe(201);
    expect(launched).toEqual([{ model: "gpt-6-sol", effort: "high" }]);
  });

  test("a codex run launches on the model and effort of its config's default tier", async () => {
    const config =
      "version: 2\nagents:\n  codex:\n    tiers:\n      default: deep\n      models:\n        deep: { model: gpt-5-codex, effort: high }\n";
    const { res, launched } = await startTiered("codex", config);

    expect(res.status).toBe(201);
    expect(launched).toEqual([{ model: "gpt-5-codex", effort: "high" }]);
  });

  test("SC23: a request whose tiers map deep to opus-y launches on opus-y over the config's opus-x", async () => {
    const config =
      "version: 2\nagents:\n  claude:\n    tiers:\n      models:\n        deep: { model: opus-x }\n";
    const { res, launched } = await startTiered("claude", config, {
      models: { deep: { model: "opus-y" } },
    });

    expect(res.status).toBe(201);
    expect(launched).toEqual([{ model: "opus-y", effort: undefined }]);
  });

  test("the run saved at start holds the built-in, config and request tiers merged, and launches on its default fast tier's haiku-x", async () => {
    const config =
      "version: 2\nagents:\n  claude:\n    tiers:\n      default: fast\n      models:\n        fast: { model: haiku-x }\n";
    const { res, launched, deps } = await startTiered("claude", config, {
      models: { deep: { model: "opus-y" } },
    });

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    const tiers = {
      default: "fast",
      models: { fast: { model: "haiku-x" }, deep: { model: "opus-y" } },
    };
    expect((await deps.registry.findRun(run.id))?.tiers).toEqual(tiers);
    expect(launched).toEqual([{ model: "haiku-x", effort: undefined }]);
  });

  test("the session starts with the env the request carries, under yok's own variables", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        workflowPath,
        inputs: {},
        cwd,
        env: { API_URL: "http://x", YOK_RUN_ID: "spoofed" },
      }),
    });

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    expect(seen[0]?.env).toEqual({
      API_URL: "http://x",
      PATH: expect.stringContaining(join(deps.home, "shims")),
      YOK_RUN_ID: run.id,
      YOK_HOME: deps.home,
    });
  });

  test("SC66: from source, a run's session gets a shim folder under the home first on PATH, holding an executable yok, and the repo as its plugin folder", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const seen: LaunchOptions[] = [];
    const deps = await buildDeps((options) => {
      seen.push(options);
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath, inputs: {}, cwd, env: {} }),
    });

    expect(res.status).toBe(201);
    const { run } = z.object({ run: WorkflowRunSchema }).parse(await res.json());
    const [shimDir = ""] = (seen[0]?.env?.PATH ?? "").split(delimiter);
    expect(dirname(shimDir)).toBe(join(deps.home, "shims"));
    accessSync(join(shimDir, "yok"), constants.X_OK);
    expect(seen[0]?.env?.YOK_RUN_ID).toBe(run.id);
    const pluginDir = seen[0]?.pluginDir ?? "";
    expect(existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  test("a request without env is 400 and launches nothing", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    let launched = false;
    const deps = await buildDeps(() => {
      launched = true;
      return Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } });
    });

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", workflowPath, inputs: {}, cwd }),
    });

    expect(res.status).toBe(400);
    expect(launched).toBe(false);
  });

  test("a request whose tiers default names a tier no layer maps is 400 and launches nothing", async () => {
    const { res, launched, deps } = await startTiered("claude", "version: 2\n", {
      default: "turbo",
    });

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: { code: string; message: string } };
    expect(error.code).toBe("bad-request");
    expect(error.message).toContain('default tier "turbo"');
    expect(launched).toEqual([]);
    expect(await deps.registry.listRuns()).toEqual([]);
  });

  test("SC11: a failing provider is 502 agent-failed and records no run", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = await buildDeps(() => Promise.resolve({ ok: false, error: "boom" }));
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
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
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
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
  test("no log line carries an env value from the request", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const { log, lines } = captureLogger();
    const deps = await buildDeps(
      () => Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
      log,
    );

    const res = await createApp(deps).request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workflow: "ok",
        workflowPath,
        inputs: {},
        cwd,
        env: { API_KEY: "top-secret-value" },
      }),
    });

    expect(res.status).toBe(201);
    expect(JSON.stringify(lines)).not.toContain("top-secret-value");
  });

  test("SC36: a working provider logs 'run started' and an http 201 line with x-request-id", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const { log, lines, at } = captureLogger();
    const deps = await buildDeps(
      () => Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
      log,
    );
    const app = createApp(deps);

    const res = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
    });

    expect(res.headers.get("x-request-id")).toBeString();
    const runStarted = at("info").find((line) => line.msg === "run started");
    expect(runStarted).toMatchObject({ runId: expect.any(String), terminalName: "s1" });
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
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
    });

    const failures = at("error").filter(
      (line) => line.msg === "run not started: the agent session failed to launch",
    );
    expect(failures).toHaveLength(1);
  });
});

describe("createYokClient", () => {
  const serveOn = (fetch: (request: Request) => Response | Promise<Response>) => {
    const home = mkdtempSync(join(tmpdir(), "yok-home-"));
    return { home, server: Bun.serve({ unix: socketPath(home), fetch }) };
  };

  test("calls the real routes over the socket and returns their typed bodies", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = await buildDeps(() =>
      Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
    );
    const { home, server } = serveOn(createApp(deps).fetch);
    try {
      const client = createYokClient({ home });

      const health = await client.health();
      expect(health).toEqual({ ok: true, value: { pid: 4242, version: "0.0.0-test" } });

      const started = await client.run({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd });
      expect(started.ok && started.value.run.sessions).toEqual([]);

      const refused = await client.run({
        workflow: "ok",
        env: {},
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
      expect(await createYokClient({ home }).health()).toEqual({
        ok: false,
        error: { code: "internal", message: "500 Internal Server Error" },
      });
    } finally {
      await server.stop(true);
    }
  });

  test("no server behind the socket is an unreachable error", async () => {
    const home = mkdtempSync(join(tmpdir(), "yok-home-"));
    expect(await createYokClient({ home }).health()).toEqual({
      ok: false,
      error: { code: "internal", message: "server unreachable" },
    });
  });
});

describe("run page URL", () => {
  test("SC11: POST /runs returns the page URL, GET /runs/:id/view returns it later, and a missing run is 404", async () => {
    const { workflowPath, cwd } = tempWorkspace();
    const deps = {
      ...(await buildDeps(() =>
        Promise.resolve({ ok: true, value: { terminalName: "s1", terminal: fakePane("s1") } }),
      )),
      viewerOrigin: "http://localhost:4321",
    };
    const app = createApp(deps);

    const started = await app.request("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workflow: "ok", env: {}, workflowPath, inputs: {}, cwd }),
    });
    const { run, view } = (await started.json()) as { run: { id: string }; view: string };
    expect(view).toBe(`http://localhost:4321/runs/${run.id}`);

    const again = await app.request(`/runs/${run.id}/view`);
    expect(await again.json()).toEqual({ view });

    const missing = await app.request("/runs/r-missing/view");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not-found");
  });
});
