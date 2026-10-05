import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(REPO_ROOT, "packages", "cli", "src", "index.ts");
const SDK_VERSION: unknown = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages", "sdk", "package.json"), "utf8"),
).version;

const tempDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "yok-agent-")));

// Stands in for the agent: prints its first PATH entry, then one argument per line, and exits 3.
const printingAgent = (): string => {
  const file = join(tempDir(), "agent.sh");
  writeFileSync(file, '#!/bin/sh\necho "$PATH" | cut -d: -f1\nprintf \'%s\\n\' "$@"\nexit 3\n');
  chmodSync(file, 0o755);
  return file;
};

const openAgent = (agent: "claude" | "codex", args: readonly string[]) => {
  const home = tempDir();
  const binVar = agent === "claude" ? "YOK_CLAUDE_BIN" : "YOK_CODEX_BIN";
  const run = spawnSync("bun", ["--no-env-file", CLI, agent, ...args], {
    cwd: tempDir(),
    encoding: "utf8",
    env: { ...process.env, YOK_HOME: home, [binVar]: printingAgent() },
  });
  const [firstPath = "", ...argv] = run.stdout.trimEnd().split("\n");
  return { home, code: run.status, firstPath, argv, stderr: run.stderr };
};

describe("yok claude|codex", () => {
  test("SC68: yok claude --resume abc --help opens Claude with a shim under YOK_HOME/shims first on PATH, the repo as --plugin-dir, the user's arguments, and its exit code", () => {
    const ran = openAgent("claude", ["--resume", "abc", "--help"]);
    expect(ran.code).toBe(3);
    expect(dirname(ran.firstPath)).toBe(join(ran.home, "shims"));
    expect(ran.argv).toEqual([
      "--settings",
      JSON.stringify({ enabledPlugins: { "yok@yok": false } }),
      "--plugin-dir",
      realpathSync(REPO_ROOT),
      "--resume",
      "abc",
      "--help",
    ]);
    const version = spawnSync(join(ran.firstPath, "yok"), ["--version"], { encoding: "utf8" });
    expect(version.stdout.trim()).toBe(String(SDK_VERSION));
  });

  test('SC69: yok codex exec "hi" opens Codex with a shim first on PATH and exactly exec hi, no --plugin-dir', () => {
    const ran = openAgent("codex", ["exec", "hi"]);
    expect(ran.code).toBe(3);
    expect(dirname(ran.firstPath)).toBe(join(ran.home, "shims"));
    expect(ran.argv).toEqual(["exec", "hi"]);
  });
});
