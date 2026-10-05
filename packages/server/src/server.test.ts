import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComments, agentBinary, readComments } from "@yok/core";
import type { WorkflowRun } from "@yok/sdk";
import { runDirOf } from "@yok/sdk";
import { claudeOver, EMPTY_BOX, fakeHost } from "./fake-host.ts";
import { runtimeChecks, startServer } from "./server.ts";

test("SC26: a restarted server types the comments an earlier one left behind, with no viewer request", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "yok-srv-")));
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yok-srv-cwd-")));
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
    tiers: null,
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

test("SC128: each agent's runtime checks carry its plugin check, run against the binary agentBinary names", () => {
  expect(runtimeChecks("claude").map((check) => check.name)).toContain("claude-plugin");
  expect(runtimeChecks("codex").map((check) => check.name)).toContain("codex-plugin");
  expect(agentBinary("claude", { YOK_CLAUDE_BIN: "/x/claude" })).toBe("/x/claude");
  expect(agentBinary("codex", { YOK_CODEX_BIN: "/x/codex" })).toBe("/x/codex");
  expect([agentBinary("claude", {}), agentBinary("codex", {})]).toEqual(["claude", "codex"]);
});
