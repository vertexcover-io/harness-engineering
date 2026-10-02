import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComments, readComments } from "@harness/core";
import type { WorkflowRun } from "@harness/sdk";
import { runDirOf } from "@harness/sdk";
import { claudeOver, EMPTY_BOX, fakeHost } from "./fake-host.ts";
import { startServer } from "./server.ts";

test("SC26: a restarted server types the comments an earlier one left behind, with no viewer request", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "harness-srv-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "harness-srv-cwd-")));
  const run: WorkflowRun = {
    id: "r-1",
    workflow: "w",
    workflowPath: "/w.yaml",
    inputs: {},
    cwd,
    sessions: [{ agent: "claude", sessionId: "s1" }],
    name: "demo",
    terminal: "s1",
    config: null,
    tier: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(join(home, "registry.json"), JSON.stringify({ version: 1, runs: { "r-1": run } }));
  const runDir = runDirOf(cwd, "demo");
  mkdirSync(runDir, { recursive: true });
  await addComments(runDir, [{ file: "artifacts/a.md", kind: "global", text: "hi" }], new Date());
  const { host, calls } = fakeHost(EMPTY_BOX);

  const server = await startServer({
    home,
    runtime: { host, providerFor: () => claudeOver(host) },
  });

  const delivered = async (): Promise<boolean> => {
    const read = await readComments(runDir);
    return read.ok && read.value.comments[0]?.status === "delivered";
  };
  for (let i = 0; i < 50 && !(await delivered()); i++) await Bun.sleep(100);
  await server.stop();
  expect(await delivered()).toBe(true);
  expect(calls[0]).toContain("1 new comment");
});
