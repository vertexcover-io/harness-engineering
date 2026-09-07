import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UploadDeps, UploadInput } from "./samskara.ts";
import { spawnRunner, uploadStageArtifacts } from "./samskara.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "samskara-test-"));

type Call = { readonly cmd: string; readonly args: readonly string[] };

const fakeDeps = (overrides: Partial<UploadDeps> = {}): { deps: UploadDeps; calls: Call[] } => {
  const calls: Call[] = [];
  const deps: UploadDeps = {
    run: (cmd, args) => {
      calls.push({ cmd, args });
      if (args[0] === "artifacts" && args[1] === "upload" && args[2] === "--help") {
        return { exit: 0, stdout: "usage: samskara artifacts upload SESSION PATH... --base-dir DIR", stderr: "" };
      }
      return { exit: 0, stdout: "", stderr: "" };
    },
    exists: () => true,
    session: () => "sess-fallback",
    ...overrides,
  };
  return { deps, calls };
};

test("SC2: a finished stage's reported files reach the CLI in one call", () => {
  const { deps, calls } = fakeDeps();
  const input: UploadInput = {
    repoRoot: "/repo",
    artifacts: [
      { name: "review", path: ".harness/spec/review/review.md" },
      { name: "plan", path: ".harness/spec/plan.html" },
    ],
  };
  const result = uploadStageArtifacts(input, deps);

  const uploadCalls = calls.filter((c) => c.args[1] === "upload" && c.args[2] !== "--help");
  assert.equal(uploadCalls.length, 1);
  assert.ok(uploadCalls[0]?.args.includes("/repo/.harness/spec/review/review.md"));
  assert.ok(uploadCalls[0]?.args.includes("/repo/.harness/spec/plan.html"));
  assert.equal(result.status, "uploaded");
});

test("SC3: the upload names the session id the run recorded", () => {
  const { deps, calls } = fakeDeps({ session: (artifactDir) => (artifactDir === "/repo/.harness/spec" ? "sess-abc" : null) });
  const input: UploadInput = {
    repoRoot: "/repo",
    artifactDir: "/repo/.harness/spec",
    artifacts: [{ name: "review", path: "review.md" }],
  };
  const result = uploadStageArtifacts(input, deps);

  const uploadCall = calls.find((c) => c.args[1] === "upload" && c.args[2] !== "--help");
  assert.equal(uploadCall?.args[2], "sess-abc");
  assert.equal(result.status, "uploaded");
});

test("SC4: the artifact directory is what the session lookup is asked about", () => {
  const { deps, calls } = fakeDeps({ session: () => "sess-xyz" });
  const input: UploadInput = {
    repoRoot: "/repo",
    artifactDir: "/repo/.harness/spec",
    artifacts: [{ name: "review", path: "review.md" }],
  };
  uploadStageArtifacts(input, deps);

  const uploadCall = calls.find((c) => c.args[1] === "upload" && c.args[2] !== "--help");
  assert.equal(uploadCall?.args[2], "sess-xyz");
});

test("SC5: with no session id anywhere, nothing uploads and the hook says why", () => {
  const { deps, calls } = fakeDeps({ session: () => null });
  const input: UploadInput = {
    repoRoot: "/repo",
    artifactDir: "/repo/.harness/spec",
    artifacts: [{ name: "review", path: "review.md" }],
  };
  const result = uploadStageArtifacts(input, deps);

  assert.equal(calls.some((c) => c.args[1] === "upload" && c.args[2] !== "--help"), false);
  assert.equal(result.status, "skipped");
  assert.match(result.detail, /session/i);
});

test("SC6: an installed CLI without the upload command uploads nothing", () => {
  const { deps, calls } = fakeDeps({
    run: (cmd, args) => {
      calls.push({ cmd, args });
      return { exit: 0, stdout: "usage: samskara [command]\n\ncommands: login, logout, artifacts", stderr: "" };
    },
  });
  const input: UploadInput = { repoRoot: "/repo", artifacts: [{ name: "review", path: "review.md" }] };
  const result = uploadStageArtifacts(input, deps);

  assert.equal(calls.some((c) => c.args[1] === "upload" && c.args[2] !== "--help"), false);
  assert.equal(result.status, "skipped");
  assert.match(result.detail, /artifacts upload/i);
});

test("SC7: a CLI that is not installed uploads nothing", () => {
  const { deps, calls } = fakeDeps({
    run: (cmd, args) => {
      calls.push({ cmd, args });
      return { exit: 127, stdout: "", stderr: "command not found: samskara" };
    },
  });
  const input: UploadInput = { repoRoot: "/repo", artifacts: [{ name: "review", path: "review.md" }] };
  const result = uploadStageArtifacts(input, deps);

  assert.equal(calls.some((c) => c.args[1] === "upload" && c.args[2] !== "--help"), false);
  assert.equal(result.status, "skipped");
});

test("SC8: a stage that reports no files makes no CLI call", () => {
  const { deps, calls } = fakeDeps();
  const input: UploadInput = { repoRoot: "/repo", artifacts: [] };
  const result = uploadStageArtifacts(input, deps);

  assert.equal(calls.length, 0);
  assert.equal(result.status, "skipped");
});

test("SC9: a failed upload throws, carrying the CLI's own message", () => {
  const { deps } = fakeDeps({
    run: (cmd, args) => {
      if (args[0] === "artifacts" && args[1] === "upload" && args[2] === "--help") {
        return { exit: 0, stdout: "--base-dir", stderr: "" };
      }
      return { exit: 1, stdout: "", stderr: "session not found" };
    },
  });
  const input: UploadInput = { repoRoot: "/repo", artifacts: [{ name: "review", path: "review.md" }] };

  assert.throws(() => uploadStageArtifacts(input, deps), /session not found/);
});

test("SC10: a reported folder is passed to the CLI as one argument", () => {
  const dir = tmp();
  const folder = join(dir, "verification");
  mkdirSync(folder);
  writeFileSync(join(folder, "a.txt"), "a");
  writeFileSync(join(folder, "b.txt"), "b");
  const { deps, calls } = fakeDeps({ exists: () => true });
  const input: UploadInput = { repoRoot: dir, artifacts: [{ name: "verification", path: "verification" }] };
  uploadStageArtifacts(input, deps);

  const uploadCall = calls.find((c) => c.args[1] === "upload" && c.args[2] !== "--help");
  assert.equal(uploadCall?.args.filter((a) => a === folder).length, 1);
});

test("SC11: paths are anchored at the repo root", () => {
  const { deps, calls } = fakeDeps();
  const input: UploadInput = { repoRoot: "/repo/root", artifacts: [{ name: "plan", path: ".harness/spec/plan.html" }] };
  uploadStageArtifacts(input, deps);

  const uploadCall = calls.find((c) => c.args[1] === "upload" && c.args[2] !== "--help");
  const args = uploadCall?.args ?? [];
  assert.equal(args[args.length - 2], "--base-dir");
  assert.equal(args[args.length - 1], "/repo/root");
  assert.ok(args.includes("/repo/root/.harness/spec/plan.html"));
});

test("SC17: a reported path that climbs out of the repo root is never uploaded", () => {
  const { deps, calls } = fakeDeps();
  const input: UploadInput = {
    repoRoot: "/repo",
    artifacts: [
      { name: "escape", path: "../../.ssh/id_rsa" },
      { name: "plan", path: ".harness/spec/plan.html" },
    ],
  };
  const result = uploadStageArtifacts(input, deps);

  const upload = calls.find((c) => c.args[1] === "upload" && c.args[2] !== "--help");
  assert.ok(upload, "the contained path should still upload");
  assert.ok(!upload.args.some((a) => a.includes("id_rsa")));
  assert.ok(upload.args.includes("/repo/.harness/spec/plan.html"));
  assert.equal(result.status, "uploaded");
});

test("SC18: an absolute path outside the repo root is never uploaded", () => {
  const { deps, calls } = fakeDeps();
  const input: UploadInput = {
    repoRoot: "/repo",
    artifacts: [{ name: "creds", path: "/Users/someone/.aws/credentials" }],
  };
  const result = uploadStageArtifacts(input, deps);

  assert.equal(calls.length, 0, "nothing is left to upload, so not even the probe should run");
  assert.equal(result.status, "skipped");
});

test("SC19: a path whose name would read as a CLI flag cannot reach the argument list", () => {
  const { deps, calls } = fakeDeps();
  const input: UploadInput = {
    repoRoot: "/repo",
    artifacts: [{ name: "flag", path: "--base-dir" }],
  };
  uploadStageArtifacts(input, deps);

  const upload = calls.find((c) => c.args[1] === "upload" && c.args[2] !== "--help");
  // Contained paths are always emitted absolute, so no argument can begin with a dash.
  const paths = upload?.args.slice(3, -2) ?? [];
  assert.ok(paths.every((a) => a.startsWith("/")));
});

test("SC20: a CLI call that outruns its bound is killed instead of blocking the run", () => {
  const started = Date.now();
  const result = spawnRunner(200)("sleep", ["5"]);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 4000, `the child must be killed at the bound, took ${elapsed}ms`);
  assert.notEqual(result.exit, 0);
});

test("SC21: a CLI that is not on PATH reports 127 with the reason", () => {
  const result = spawnRunner(2000)("samskara-does-not-exist", ["--help"]);

  assert.equal(result.exit, 127);
  assert.notEqual(result.stderr, "");
});

test("SC22: a CLI that prints the flag but exits non-zero is not treated as capable", () => {
  // A broken or half-installed CLI can print usage text on its way to failing. Only stdout
  // carrying the flag AND a clean exit means the command is really there.
  const { deps, calls } = fakeDeps({
    run: () => ({ exit: 1, stdout: "usage: samskara artifacts upload SESSION PATH... --base-dir DIR", stderr: "boom" }),
  });
  const input: UploadInput = {
    repoRoot: "/repo",
    artifacts: [{ name: "review", path: ".harness/spec/review.md" }],
  };
  const result = uploadStageArtifacts(input, deps);

  assert.equal(calls.filter((c) => c.args[2] !== "--help").length, 0, "no upload may be attempted");
  assert.equal(result.status, "skipped");
  assert.match(result.detail, /artifacts upload/);
});
