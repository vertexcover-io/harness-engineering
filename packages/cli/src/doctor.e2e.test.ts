import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DoctorJsonSchema } from "@harness/core";

const CLI = join(import.meta.dir, "index.ts");

const WORKFLOW = [
  "name: needs-key",
  "doctor:",
  "  - check: env",
  "    key: DOCTOR_E2E_KEY",
  "    fix: Set DOCTOR_E2E_KEY in .env",
  "nodes:",
  "  - id: a",
  "    type: exec",
  "    runtime: sh",
  '    script: "true"',
  "    input: null",
  "",
].join("\n");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const doctor = (files: Record<string, string>, args: readonly string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "harness-doctor-e2e-"));
  dirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const { DOCTOR_E2E_KEY: _unset, ...env } = process.env;
  const result = spawnSync("bun", [CLI, "doctor", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...env, LOG_LEVEL: "" },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
};

const rowOf = (stdout: string, name: string) =>
  DoctorJsonSchema.parse(JSON.parse(stdout)).results.find((row) => row.name === name);

describe("harness doctor --workflow", () => {
  test("a declared env key missing from .env blocks and shows the declared fix", () => {
    const { code, stdout } = doctor({ "wf.yaml": WORKFLOW }, ["--workflow", "wf.yaml", "--json"]);
    expect(code).toBe(1);
    expect(rowOf(stdout, "env:DOCTOR_E2E_KEY")).toMatchObject({
      status: "fail",
      optional: false,
      fix: ["Set DOCTOR_E2E_KEY in .env"],
    });
  });

  test("the same key set in .env passes without printing its value", () => {
    const { stdout } = doctor({ "wf.yaml": WORKFLOW, ".env": "DOCTOR_E2E_KEY=top-secret\n" }, [
      "--workflow",
      "wf.yaml",
      "--json",
    ]);
    expect(rowOf(stdout, "env:DOCTOR_E2E_KEY")).toMatchObject({ status: "ok" });
    expect(stdout).not.toContain("top-secret");
  });

  test("the key set only in the config's env passes", () => {
    const config = JSON.stringify({ version: 2, env: { DOCTOR_E2E_KEY: "from-config" } });
    const { stdout } = doctor({ "wf.yaml": WORKFLOW, "orchestrate.config.json": config }, [
      "--workflow",
      "wf.yaml",
      "--json",
    ]);
    expect(rowOf(stdout, "env:DOCTOR_E2E_KEY")).toMatchObject({ status: "ok" });
  });

  test("a workflow envFile that is missing fails the env check naming the file", () => {
    const { stdout } = doctor({ "wf.yaml": `envFile: gone.env\n${WORKFLOW}` }, [
      "--workflow",
      "wf.yaml",
      "--json",
    ]);
    const row = rowOf(stdout, "env:DOCTOR_E2E_KEY");
    expect(row?.status).toBe("fail");
    expect(row?.detail).toContain("gone.env");
  });

  test("without --workflow the declared checks do not run", () => {
    const { stdout } = doctor({ "wf.yaml": WORKFLOW }, ["--json"]);
    expect(rowOf(stdout, "env:DOCTOR_E2E_KEY")).toBeUndefined();
  });

  test("a workflow that does not compile prints its error and exits 1", () => {
    const { code, stderr } = doctor({}, ["--workflow", "missing.yaml"]);
    expect(code).toBe(1);
    expect(stderr).toContain("missing-workflow:");
  });
});
