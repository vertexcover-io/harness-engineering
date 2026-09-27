import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkflowRun } from "./protocol.ts";
import { createRegistry, RegistryFileSchema } from "./registry.ts";

const run = (id: string): WorkflowRun => ({
  id,
  workflow: "demo",
  workflowPath: "/abs/workflow.yaml",
  inputs: {},
  cwd: "/abs/repo",
  sessions: [],
  name: null,
  createdAt: new Date().toISOString(),
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

  test("linkSession says whether the session was new", async () => {
    const registry = createRegistry(tempRegistryPath());
    await registry.addRun(run("r-1"));
    const session = { agent: "codex", sessionId: "s1" } as const;

    expect(await registry.linkSession("r-1", session)).toBe(true);
    expect(await registry.linkSession("r-1", session)).toBe(false);
    expect((await registry.findRun("r-1"))?.sessions).toEqual([session]);
  });
});
