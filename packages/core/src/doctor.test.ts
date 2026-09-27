import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Check, checkBinary, type Exec, execWithTimeout, fail } from "@harness/sdk";
import { evaluate, runDoctor, summarize, verdict } from "./doctor.ts";

const key = (command: string, args: readonly string[]): string => `${command} ${args.join(" ")}`;

// A fake Exec keyed by "command args", resolving or rejecting per entry.
const fakeExec = (
  entries: Readonly<Record<string, { code: number; stdout: string } | Error>>,
): Exec => {
  return (command, args) => {
    const result = entries[key(command, args)];
    if (result === undefined) throw new Error(`no fake exec entry for ${key(command, args)}`);
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve({ stderr: "", ...result });
  };
};

// checkOrchestrateConfig reads the real filesystem (not exec), so "every check passes"
// scenarios need a real directory holding a valid, doctor-less config.
let cleanRoot: string;

beforeAll(async () => {
  cleanRoot = await mkdtemp(join(tmpdir(), "doctor-clean-"));
  await writeFile(join(cleanRoot, "orchestrate.config.json"), "{}");
});

afterAll(async () => {
  await rm(cleanRoot, { recursive: true, force: true });
});

const allToolsOk = (root: string): Record<string, { code: number; stdout: string }> => ({
  "git --version": { code: 0, stdout: "git version 2.43.0" },
  "git rev-parse --show-toplevel": { code: 0, stdout: root },
  [key("git", ["check-ignore", "-q", join(root, ".harness", "probe")])]: { code: 0, stdout: "" },
  "jq --version": { code: 0, stdout: "jq-1.7" },
  "curl --version": { code: 0, stdout: "curl 8.4.0" },
  "gh --version": { code: 0, stdout: "gh version 2.40.0" },
  "gh auth status": { code: 0, stdout: "Logged in to github.com" },
  "agent-browser --version": { code: 0, stdout: "agent-browser 1.0.0" },
  "ffmpeg -version": { code: 0, stdout: "ffmpeg version 6.0" },
  "samskara --version": { code: 0, stdout: "1.4.0" },
  "samskara status": { code: 0, stdout: "paired as ritesh" },
});

const BUILT_IN_NAMES = [
  "git",
  "git-repo",
  "jq",
  "curl",
  "harness-gitignored",
  "orchestrate-config",
  "gh",
  "agent-browser",
  "ffmpeg",
  "samskara",
];

describe("runDoctor", () => {
  test("SC1: READY when every built-in check passes", async () => {
    const report = await runDoctor({ cwd: cleanRoot, exec: fakeExec(allToolsOk(cleanRoot)) });
    expect(verdict(report)).toBe("READY");
    expect(report.failed).toEqual([]);
    expect(report.warned).toEqual([]);
  });

  test("SC5: a missing tool fails with its fix, a present tool reports its version's first line, in order", async () => {
    const report = await runDoctor({
      cwd: cleanRoot,
      exec: fakeExec({
        ...allToolsOk(cleanRoot),
        "ffmpeg -version": { code: 127, stdout: "" },
        "git --version": { code: 0, stdout: "git version 2.43.0\nsecond line" },
      }),
    });
    expect(report.results.map((row) => row.name)).toEqual(BUILT_IN_NAMES);
    expect(report.results[0]).toMatchObject({
      name: "git",
      status: "ok",
      detail: "git version 2.43.0",
    });
    expect(report.results.find((row) => row.name === "ffmpeg")).toMatchObject({
      name: "ffmpeg",
      status: "fail",
      detail: "not on PATH",
      fix: ["brew install ffmpeg", "apt install ffmpeg", "dnf install ffmpeg"],
    });
  });

  test("SC6: a command that rejects with a timeout becomes a FAIL row, without blocking the other rows", async () => {
    const report = await runDoctor({
      cwd: cleanRoot,
      exec: fakeExec({
        ...allToolsOk(cleanRoot),
        "jq --version": new Error("timed out after 30s"),
      }),
    });
    const jqRow = report.results.find((row) => row.name === "jq");
    expect(jqRow).toMatchObject({ status: "fail", detail: "timed out after 30s" });
    expect(report.results.find((row) => row.name === "git")).toMatchObject({ status: "ok" });
  });

  test("SC4: an optional extra check that fails is capped at warn, and the verdict is DEGRADED not BLOCKED", async () => {
    const optionalCheck: Check = {
      name: "custom-check",
      optional: true,
      fix: ["set it up"],
      run: () => Promise.resolve(fail("not configured")),
    };
    const report = await runDoctor({
      cwd: cleanRoot,
      exec: fakeExec(allToolsOk(cleanRoot)),
      extraChecks: [optionalCheck],
    });
    const row = report.results.find((r) => r.name === "custom-check");
    expect(row).toMatchObject({ status: "warn", optional: true });
    expect(verdict(report)).toBe("DEGRADED custom-check");
  });

  test("SC23: an extra check built from checkBinary reports after the built-in rows", async () => {
    const dockerCheck: Check = {
      name: "docker",
      fix: ["brew install docker"],
      run: checkBinary("docker"),
    };
    const report = await runDoctor({
      cwd: cleanRoot,
      exec: fakeExec({ ...allToolsOk(cleanRoot), "docker --version": { code: 127, stdout: "" } }),
      extraChecks: [dockerCheck],
    });
    expect(report.results.map((row) => row.name)).toEqual([...BUILT_IN_NAMES, "docker"]);
    expect(report.results.at(-1)).toMatchObject({
      name: "docker",
      status: "fail",
      detail: "not on PATH",
      fix: ["brew install docker"],
    });
    expect(verdict(report)).toBe("BLOCKED docker");
  });

  test("SC12: gh installed but logged out is a WARN pointing to gh auth login", async () => {
    const report = await runDoctor({
      cwd: cleanRoot,
      exec: fakeExec({ ...allToolsOk(cleanRoot), "gh auth status": { code: 1, stdout: "" } }),
    });
    const ghRow = report.results.find((row) => row.name === "gh");
    expect(ghRow).toMatchObject({
      status: "warn",
      detail: "installed but not authenticated",
      fix: ["gh auth login"],
    });
    expect(verdict(report)).toBe("DEGRADED gh");
  });

  test("SC13: a missing gh is a WARN, not a FAIL, because it is optional", async () => {
    const report = await runDoctor({
      cwd: cleanRoot,
      exec: fakeExec({ ...allToolsOk(cleanRoot), "gh --version": { code: 127, stdout: "" } }),
    });
    const ghRow = report.results.find((row) => row.name === "gh");
    expect(ghRow).toMatchObject({ status: "warn", detail: "not on PATH" });
    expect(ghRow?.fix[0]).toBe("brew install gh");
    expect(verdict(report)).not.toMatch(/^BLOCKED/);
  });

  test("SC14: samskara is OK only when its status says it is paired", async () => {
    const paired = await runDoctor({ cwd: cleanRoot, exec: fakeExec(allToolsOk(cleanRoot)) });
    expect(paired.results.find((row) => row.name === "samskara")).toMatchObject({
      status: "ok",
      detail: "v1.4.0 paired",
    });

    const notPaired = await runDoctor({
      cwd: cleanRoot,
      exec: fakeExec({
        ...allToolsOk(cleanRoot),
        "samskara status": { code: 0, stdout: "not paired" },
      }),
    });
    const row = notPaired.results.find((r) => r.name === "samskara");
    expect(row).toMatchObject({ status: "warn", detail: "v1.4.0 installed but not paired" });
    expect(row?.fix[0]).toBe("npm i -g samskara");
  });

  test("SC15: the report lists ten built-in rows in v1's order", async () => {
    const report = await runDoctor({ cwd: cleanRoot, exec: fakeExec(allToolsOk(cleanRoot)) });
    expect(report.results.map((row) => row.name)).toEqual(BUILT_IN_NAMES);
    expect(report.results.some((row) => row.name === "harness-version")).toBe(false);
  });
});

describe("evaluate", () => {
  test("a check whose run throws becomes a fail row with the error's message as detail", async () => {
    const throwing: Check = {
      name: "flaky",
      fix: ["retry"],
      run: () => Promise.reject(new Error("boom")),
    };
    const row = await evaluate(throwing, { root: "/repo", exec: fakeExec({}) });
    expect(row).toMatchObject({ name: "flaky", status: "fail", detail: "boom" });
  });
});

describe("summarize/verdict", () => {
  test("SC2: BLOCKED names the failed rows even when warnings are also present", () => {
    const report = summarize([
      { name: "jq", status: "fail", optional: false, detail: "not on PATH", fix: [] },
      { name: "gh", status: "warn", optional: true, detail: "not authenticated", fix: [] },
    ]);
    expect(verdict(report)).toBe("BLOCKED jq");
  });

  test("SC3: DEGRADED names every warned row in order when nothing failed", () => {
    const report = summarize([
      { name: "gh", status: "warn", optional: true, detail: "not authenticated", fix: [] },
      { name: "samskara", status: "warn", optional: true, detail: "not paired", fix: [] },
    ]);
    expect(verdict(report)).toBe("DEGRADED gh samskara");
  });
});

// Real git, in fresh mkdtemp directories, so the repository checks run against the real thing.
// Only git and sh run for real. Every other tool answers at once, so these tests neither wait
// on nor depend on what this machine has installed or logged in (gh auth status calls GitHub).
const onlyGitAndSh =
  (inner: Exec): Exec =>
  (command, args, cwd) =>
    command === "git" || command === "sh"
      ? inner(command, args, cwd)
      : Promise.resolve({ code: 0, stdout: "", stderr: "" });

describe("runDoctor (integration)", () => {
  const exec = onlyGitAndSh(execWithTimeout(5000));
  const dirs: string[] = [];

  const makeDir = async (prefix: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  };

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test("SC16: outside a git repository, the repository checks fail", async () => {
    const dir = await makeDir("doctor-none-");
    const report = await runDoctor({ cwd: dir, exec });
    expect(report.results.find((row) => row.name === "git-repo")).toMatchObject({
      status: "fail",
      detail: "not inside a git repository",
    });
    expect(report.results.find((row) => row.name === "harness-gitignored")).toMatchObject({
      status: "fail",
      detail: ".harness/ is not gitignored",
    });
    expect(report.results.find((row) => row.name === "orchestrate-config")).toMatchObject({
      status: "fail",
      detail: "orchestrate.config.json not found",
    });
  });

  test("SC17: a repository that ignores .harness/ and has a valid config passes the repository checks", async () => {
    const dir = await makeDir("doctor-clean-repo-");
    await exec("git", ["init"], dir);
    await writeFile(join(dir, ".gitignore"), ".harness/\n");
    await writeFile(join(dir, "orchestrate.config.json"), "{}");

    const report = await runDoctor({ cwd: dir, exec });
    expect(report.results.find((row) => row.name === "git-repo")).toMatchObject({ status: "ok" });
    expect(report.results.find((row) => row.name === "harness-gitignored")).toMatchObject({
      status: "ok",
    });
    expect(report.results.find((row) => row.name === "orchestrate-config")).toMatchObject({
      status: "ok",
    });
    expect(report.results.find((row) => row.name === "project-doctor")).toBeUndefined();
  });

  test("SC18: a config file that is not JSON fails the config check and runs no project doctor", async () => {
    const dir = await makeDir("doctor-bad-config-");
    await exec("git", ["init"], dir);
    await writeFile(join(dir, "orchestrate.config.json"), "{ doctor: ");

    const report = await runDoctor({ cwd: dir, exec });
    expect(report.results.find((row) => row.name === "orchestrate-config")).toMatchObject({
      status: "fail",
      detail: "orchestrate.config.json is not valid JSON",
    });
    expect(report.results.find((row) => row.name === "project-doctor")).toBeUndefined();
  });

  test("a config that exists but cannot be read is a FAIL row, not a crash", async () => {
    const dir = await makeDir("doctor-unreadable-config-");
    await exec("git", ["init"], dir);
    await mkdir(join(dir, "orchestrate.config.json"));

    const report = await runDoctor({ cwd: dir, exec });
    const row = report.results.find((r) => r.name === "orchestrate-config");
    expect(row?.status).toBe("fail");
    expect(row?.detail).toStartWith("orchestrate.config.json cannot be read:");
    expect(report.results.find((r) => r.name === "project-doctor")).toBeUndefined();
  });

  test("a doctor key that is not a string fails the config check instead of vanishing", async () => {
    const dir = await makeDir("doctor-bad-doctor-key-");
    await exec("git", ["init"], dir);
    await writeFile(join(dir, "orchestrate.config.json"), JSON.stringify({ doctor: 42 }));

    const report = await runDoctor({ cwd: dir, exec });
    const row = report.results.find((r) => r.name === "orchestrate-config");
    expect(row?.status).toBe("fail");
    expect(row?.detail).toContain("doctor");
    expect(report.results.find((r) => r.name === "project-doctor")).toBeUndefined();
  });

  test("inside a repository that does not ignore .harness/, harness-gitignored fails", async () => {
    const dir = await makeDir("doctor-not-ignored-");
    await exec("git", ["init"], dir);
    await writeFile(join(dir, "orchestrate.config.json"), "{}");

    const report = await runDoctor({ cwd: dir, exec });
    expect(report.results.find((row) => row.name === "git-repo")).toMatchObject({ status: "ok" });
    expect(report.results.find((row) => row.name === "harness-gitignored")).toMatchObject({
      status: "fail",
      detail: ".harness/ is not gitignored",
    });
  });

  test("a project doctor that exits 0 with plain output is one OK row naming the command", async () => {
    const dir = await makeDir("doctor-project-plain-ok-");
    await exec("git", ["init"], dir);
    const script = join(dir, "doctor.sh");
    await writeFile(script, ["#!/bin/sh", 'echo "all good"', ""].join("\n"));
    await writeFile(
      join(dir, "orchestrate.config.json"),
      JSON.stringify({ doctor: `sh ${script}` }),
    );

    const report = await runDoctor({ cwd: dir, exec });
    expect(report.results.find((row) => row.name === "project-doctor")).toMatchObject({
      status: "ok",
      detail: `sh ${script}`,
    });
  });

  test("SC19: rows from a project doctor that speaks the contract follow the built-in rows, optional failures capped", async () => {
    const dir = await makeDir("doctor-project-contract-");
    await exec("git", ["init"], dir);
    const script = join(dir, "doctor.sh");
    await writeFile(
      script,
      [
        "#!/bin/sh",
        // Contract JSON only when asked with --json, so the test fails if the flag stops arriving.
        'if [ "$1" = "--json" ]; then',
        '  echo \'{"results":[{"name":"db","status":"fail","fix":["start postgres"]},{"name":"cache","status":"fail","optional":true,"extra":1}]}\'',
        "else",
        '  echo "plain output"',
        "fi",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(dir, "orchestrate.config.json"),
      JSON.stringify({ doctor: `sh ${script}` }),
    );

    const report = await runDoctor({ cwd: dir, exec });
    expect(report.results.slice(-2)).toMatchObject([
      { name: "db", status: "fail", fix: ["start postgres"] },
      { name: "cache", status: "warn", detail: "" },
    ]);
    const v = verdict(report);
    expect(v).toContain("db");
    expect(v.startsWith("BLOCKED")).toBe(true);
    expect(v).not.toContain("cache");
  });

  test("SC20: a project doctor that prints no contract is one row judged by its exit code", async () => {
    const dir = await makeDir("doctor-project-plain-");
    await exec("git", ["init"], dir);
    const script = join(dir, "doctor.sh");
    await writeFile(
      script,
      ["#!/bin/sh", 'echo "checking…"', 'echo "database down"', "exit 3", ""].join("\n"),
    );
    await writeFile(
      join(dir, "orchestrate.config.json"),
      JSON.stringify({ doctor: `sh ${script}` }),
    );

    const report = await runDoctor({ cwd: dir, exec });
    expect(report.results.find((row) => row.name === "project-doctor")).toMatchObject({
      status: "fail",
      detail: "exit 3: database down",
      fix: [`sh ${script}`],
    });
  });

  test("SC21: a project doctor command that does not exist is a FAIL row telling you to fix the config", async () => {
    const dir = await makeDir("doctor-project-missing-");
    await exec("git", ["init"], dir);
    await writeFile(
      join(dir, "orchestrate.config.json"),
      JSON.stringify({ doctor: "no-such-doctor-cmd" }),
    );

    const report = await runDoctor({ cwd: dir, exec });
    expect(report.results.find((row) => row.name === "project-doctor")).toMatchObject({
      status: "fail",
      detail: "command not found: no-such-doctor-cmd",
      fix: ['fix the "doctor" entry in orchestrate.config.json'],
    });
  });

  test("SC22: a project doctor that hangs is cut off, and the report still returns", async () => {
    const dir = await makeDir("doctor-project-hang-");
    await exec("git", ["init"], dir);
    // Wrapped in its own `sh -c`, so the "--json" runDoctor appends becomes an inert $0
    // for the inner shell instead of an argument to `sleep`, which would otherwise error out.
    await writeFile(
      join(dir, "orchestrate.config.json"),
      JSON.stringify({ doctor: "sh -c 'sleep 30'" }),
    );

    const started = Date.now();
    const report = await runDoctor({ cwd: dir, exec: onlyGitAndSh(execWithTimeout(300)) });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(report.results.find((row) => row.name === "project-doctor")).toMatchObject({
      status: "fail",
      detail: "timed out after 0.3s",
    });
  });
});
