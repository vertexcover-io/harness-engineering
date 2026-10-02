import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createRegistry,
  createRegistryReader,
  RegistryFileSchema,
  type WorkflowRun,
} from "./registry.ts";
import { findRunByIdOrName, type RunTarget } from "./runs.ts";

const run = (id: string, overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id,
  workflow: "demo",
  workflowPath: "/abs/workflow.yaml",
  inputs: {},
  cwd: "/abs/repo",
  sessions: [],
  name: null,
  terminal: null,
  config: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

const tempRegistryPath = (): string =>
  join(mkdtempSync(join(tmpdir(), "harness-registry-")), "registry.json");

describe("createRegistry", () => {
  test("SC8: two update calls started together both land on disk and parse", async () => {
    const path = tempRegistryPath();
    const registry = createRegistry(path);

    const p1 = registry.addRun(run("r-1"));
    const p2 = registry.addRun(run("r-2"));
    await Promise.all([p1, p2]);

    const parsed = RegistryFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(Object.keys(parsed.runs).sort()).toEqual(["r-1", "r-2"]);
  });

  test("SC8a: an awaited change is on disk, and a second registry reads it", async () => {
    const path = tempRegistryPath();
    await createRegistry(path).addRun(run("r-3"));

    const parsed = RegistryFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(parsed.runs["r-3"]?.id).toBe("r-3");
    expect((await createRegistry(path).findRun("r-3"))?.id).toBe("r-3");
  });

  test("a failed write rejects only its own update, and later updates still land", async () => {
    const path = tempRegistryPath();
    const registry = createRegistry(path);

    chmodSync(dirname(path), 0o500);
    const failed = registry.addRun(run("r-lost")).catch(() => "rejected");
    expect(await failed).toBe("rejected");
    chmodSync(dirname(path), 0o700);

    await registry.addRun(run("r-kept"));

    const parsed = RegistryFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
    expect(Object.keys(parsed.runs)).toEqual(["r-kept"]);
    expect(await registry.findRun("r-lost")).toBeUndefined();
    expect((await registry.findRun("r-kept"))?.id).toBe("r-kept");
  });

  test("a change that changes nothing writes nothing", async () => {
    const path = tempRegistryPath();
    const registry = createRegistry(path);

    await registry.initRun("r-missing", "t");

    expect(existsSync(path)).toBe(false);
  });

  test("linkSession adds a session once, however often it is linked", async () => {
    const registry = createRegistry(tempRegistryPath());
    await registry.addRun(run("r-1"));
    const session = { agent: "codex", sessionId: "s1" } as const;

    await registry.linkSession("r-1", session);
    await registry.linkSession("r-1", session);
    expect((await registry.findRun("r-1"))?.sessions).toEqual([session]);
  });

  test("findRunsByName lists every run with that name, newest first", async () => {
    const registry = createRegistry(tempRegistryPath());
    await registry.addRun(run("r-old", { name: "fix", createdAt: "2026-09-01T00:00:00.000Z" }));
    await registry.addRun(run("r-new", { name: "fix", createdAt: "2026-09-02T00:00:00.000Z" }));
    await registry.addRun(run("r-unnamed"));

    expect((await registry.findRunsByName("fix")).map((found) => found.id)).toEqual([
      "r-new",
      "r-old",
    ]);
    expect(await registry.findRunsByName("missing")).toEqual([]);
  });
});

describe("config", () => {
  test("a run record written before config existed loads with config null", async () => {
    const path = tempRegistryPath();
    const { config: _omitted, ...legacy } = run("r-old");
    await writeFile(path, JSON.stringify({ version: 1, runs: { "r-old": legacy } }));

    expect((await createRegistry(path).findRun("r-old"))?.config).toBeNull();
  });
});

describe("terminal", () => {
  test("SC2: a registry file written before terminal existed loads with null, and setTerminal stores a name", async () => {
    const path = tempRegistryPath();
    const { terminal: _omitted, ...legacy } = run("r-old");
    await writeFile(path, JSON.stringify({ version: 1, runs: { "r-old": legacy } }));
    const registry = createRegistry(path);

    expect((await registry.findRun("r-old"))?.terminal).toBeNull();
    await registry.setTerminal("r-old", "claude-fix-login-r-old");

    expect((await createRegistry(path).findRun("r-old"))?.terminal).toBe("claude-fix-login-r-old");
  });
});

describe("findRunByIdOrName", () => {
  const setUp = async () => {
    const root = mkdtempSync(join(tmpdir(), "registry-root-"));
    const registry = createRegistry(tempRegistryPath());
    await registry.addRun(run("r-1a2b3c4d", { cwd: root, name: "fix-login", terminal: "t-1" }));
    mkdirSync(join(root, ".harness", "fix-login"), { recursive: true });
    return { root, registry };
  };

  test("finds a run by its id, or by its name in the given repo root", async () => {
    const { root, registry } = await setUp();

    const byId = await findRunByIdOrName(registry, { runId: "r-1a2b3c4d" });
    const byName = await findRunByIdOrName(registry, { name: "fix-login", root });

    expect(byId).toMatchObject({ ok: true, value: { id: "r-1a2b3c4d", terminal: "t-1" } });
    expect(byName).toMatchObject({ ok: true, value: { id: "r-1a2b3c4d", terminal: "t-1" } });
  });

  test("an unknown id, an unknown name, or a name whose run folder is gone is an error", async () => {
    const { root, registry } = await setUp();
    const errorOf = async (target: RunTarget) => {
      const found = await findRunByIdOrName(registry, target);
      return found.ok ? "" : found.error;
    };

    expect(await errorOf({ runId: "r-00000000" })).toContain("r-00000000");
    expect(await errorOf({ name: "nope", root })).toContain('no run named "nope"');
    rmSync(join(root, ".harness", "fix-login"), { recursive: true });
    expect(await errorOf({ name: "fix-login", root })).toContain("no longer exists");
  });
});

describe("createRegistryReader", () => {
  test("SC10: finds what the registry wrote and exposes no write methods", async () => {
    const path = tempRegistryPath();
    const registry = createRegistry(path);
    await registry.addRun(run("r-10"));
    await registry.initRun("r-10", "spec");

    const reader = createRegistryReader(path);

    expect((await reader.findRun("r-10"))?.name).toBe("spec");
    expect((await reader.findRunsByName("spec")).map((found) => found.id)).toEqual(["r-10"]);
    expect(Object.keys(reader).sort()).toEqual(["findRun", "findRunsByName"]);
  });
});
