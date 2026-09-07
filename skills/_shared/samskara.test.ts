import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { UploadDeps, UploadInput } from "./samskara.ts";
import { uploadStageArtifacts } from "./samskara.ts";

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
    readText: () => "",
    sessionFallback: () => "sess-fallback",
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
  const { deps, calls } = fakeDeps({
    exists: (path) => path.endsWith("manifest.json") || path.endsWith("review.md"),
    readText: () => JSON.stringify({ run_info: { session: "sess-abc" } }),
    sessionFallback: () => {
      throw new Error("fallback must not be called when the manifest has a session");
    },
  });
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

test("SC4: with no manifest, the session id comes from the fallback", () => {
  const { deps, calls } = fakeDeps({
    exists: (path) => !path.endsWith("manifest.json"),
    sessionFallback: () => "sess-xyz",
  });
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
  const { deps, calls } = fakeDeps({
    exists: (path) => !path.endsWith("manifest.json"),
    sessionFallback: () => null,
  });
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
