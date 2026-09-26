import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { DoctorJsonSchema } from "@harness/core";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const BIN = join(REPO_ROOT, "node_modules", ".bin", "harness");

const runBin = (args: readonly string[]): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(BIN, [...args], { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout }));
  });

describe("harness doctor (installed bin)", () => {
  test("SC11: prints ENVIRONMENT, a header row, a git row and a VERDICT line, exiting per the verdict", async () => {
    const { code, stdout } = await runBin(["doctor"]);
    expect(stdout.startsWith("ENVIRONMENT")).toBe(true);
    expect(stdout).toMatch(/CHECK\s+REQUIRED\s+STATUS\s+DETAIL\s+FIX/);
    expect(stdout).toMatch(/^git\s/m);
    const verdictLine = stdout.split("\n").find((line) => /^(READY|DEGRADED|BLOCKED)/.test(line));
    expect(verdictLine).toBeDefined();
    expect(code).toBe(verdictLine?.startsWith("BLOCKED") ? 1 : 0);
  }, 40_000);

  test("--json prints a report that parses against DoctorJsonSchema, exiting per the verdict", async () => {
    const { code, stdout } = await runBin(["doctor", "--json"]);
    const json = DoctorJsonSchema.parse(JSON.parse(stdout));
    expect(json.results.map((row) => row.name)).toContain("git");
    expect(code).toBe(json.verdict.startsWith("BLOCKED") ? 1 : 0);
  }, 40_000);
});
