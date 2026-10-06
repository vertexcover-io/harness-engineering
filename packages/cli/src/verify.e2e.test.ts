import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "index.ts");

const OK_WORKFLOW = [
  "name: ok",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "",
].join("\n");

const CYCLE_WORKFLOW = [
  "name: bad",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "    dependsOn: [b]",
  "  - id: b",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "    dependsOn: [a]",
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const verify = (file: string, content: string | null) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-verify-e2e-"));
  dirs.push(dir);
  if (content !== null) writeFileSync(join(dir, file), content);
  const result = spawnSync("bun", [CLI, "verify", file], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, LOG_LEVEL: "" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe("harness verify", () => {
  test("a valid workflow prints its name and node count and exits 0", () => {
    const { code, stdout } = verify("ok.yaml", OK_WORKFLOW);
    expect(code).toBe(0);
    expect(stdout).toContain("ok: workflow ok compiles (1 node)");
  });

  test("a cyclic workflow prints the compile error code and message and exits 1", () => {
    const { code, stderr } = verify("bad.yaml", CYCLE_WORKFLOW);
    expect(code).toBe(1);
    expect(stderr).toContain("cycle:");
    expect(stderr).toContain("dependency cycle");
    expect(stderr).not.toContain("    at ");
  });

  test("a yaml syntax error is reported as a yaml error", () => {
    const { code, stderr } = verify("broken.yaml", "name: [unclosed\n");
    expect(code).toBe(1);
    expect(stderr).toContain("yaml:");
  });

  test("a bare name compiles the shipped workflow of that name", () => {
    const { code, stdout } = verify("task", null);
    expect(code).toBe(0);
    expect(stdout).toContain("ok: workflow task compiles");
  });

  test("an unknown bare name is reported as a missing workflow", () => {
    const { code, stderr } = verify("nope", null);
    expect(code).toBe(1);
    expect(stderr).toContain("missing-workflow:");
  });

  test("a missing file is reported and exits 1", () => {
    const { code, stderr } = verify("nope.yaml", null);
    expect(code).toBe(1);
    expect(stderr).toContain("missing-workflow:");
  });
});
