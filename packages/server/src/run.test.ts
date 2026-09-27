import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateSchema } from "@harness/core";
import { createGit, noopLogger } from "@harness/sdk";
import type { WorkflowRun } from "./protocol.ts";
import { initializeRun, initialState, readGit } from "./run.ts";

const makeRun = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  id: "r-1",
  workflow: "demo",
  workflowPath: "/abs/workflow.yaml",
  inputs: {},
  cwd: "/repos/demo",
  sessions: [],
  name: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe("initialState", () => {
  test("SC18: parses with StateSchema, workflow.path is workflow.yaml, and the repository key is the slug of the repo folder", () => {
    const run = makeRun({ cwd: "/repos/Fix Login App" });
    const state = initialState(run, "fix-login", {
      branch: "main",
      startSha: "abc123",
      baseBranch: "main",
    });

    expect(StateSchema.safeParse(state).success).toBe(true);
    expect(state.workflow).toEqual({ name: "demo", path: "workflow.yaml" });
    expect(Object.keys(state.workspace.repositories)).toEqual(["fix-login-app"]);
  });
});

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "harness-run-")));
const gitCmd = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const makeRepo = (): string => {
  const dir = tempDir();
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

describe("readGit", () => {
  test("SC21: baseBranch equals branch when the repo has no origin", async () => {
    const root = makeRepo();
    const git = await readGit(root, createGit());

    expect(git.branch).toBe("main");
    expect(git.baseBranch).toBe(git.branch);
  });
});

describe("initializeRun", () => {
  test("a step that fails after the folder is made removes the folder, so a retry can succeed", async () => {
    const root = makeRepo();
    const run = makeRun({ cwd: root, workflowPath: join(root, "missing.yaml") });
    const deps = { git: createGit(), log: noopLogger };

    await expect(initializeRun(run, "fix-login", deps)).rejects.toThrow();

    expect(existsSync(join(root, ".harness", "fix-login"))).toBe(false);
  });
});
