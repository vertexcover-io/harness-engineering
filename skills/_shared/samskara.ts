import { spawnSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type Runner = (
  cmd: string,
  args: readonly string[],
) => { readonly exit: number; readonly stdout: string; readonly stderr: string };

export type UploadDeps = {
  readonly run: Runner;
  readonly exists: (path: string) => boolean;
  readonly session: (artifactDir: string | undefined) => string | null;
};

export type UploadResult = {
  readonly status: "uploaded" | "skipped";
  readonly detail: string;
};

export type StageArtifact = { readonly name: string; readonly path: string };

export type UploadInput = {
  readonly repoRoot: string;
  readonly artifactDir?: string;
  readonly artifacts: readonly StageArtifact[];
};

/** Uploading a folder of screen recordings outruns any short bound, so the hook declares a long
 * one. It has to sit on the child process: spawnSync blocks the event loop, so the timer race in
 * hooks.ts's runFn cannot preempt it and a hung upload would otherwise stall the stage forever.
 * `error` is set both by that kill and by a missing binary, and carries the reason for each. */
export const spawnRunner =
  (timeoutMs: number): Runner =>
  (cmd, args) => {
    const r = spawnSync(cmd, [...args], { encoding: "utf8", timeout: timeoutMs });
    return {
      exit: r.status ?? 127,
      stdout: r.stdout ?? "",
      stderr: r.error === undefined ? (r.stderr ?? "") : r.error.message,
    };
  };

// v0.3.0 exits 0 on an unknown subcommand and prints the top-level help, so the exit code
// says nothing. The flag only appears in the subcommand's own help.
const PROBE_FLAG = "--base-dir";

const supportsUpload = (deps: UploadDeps): boolean => {
  const probe = deps.run("samskara", ["artifacts", "upload", "--help"]);
  return probe.exit === 0 && probe.stdout.includes(PROBE_FLAG);
};

/** A reported path is a free string an agent wrote into the event; nothing upstream checks where
 * it points. Anything resolving outside the repo root is dropped rather than sent to a remote
 * service. Containment also keeps every emitted argument absolute, so no path can be read as a
 * CLI flag. */
const containedPath = (repoRoot: string, path: string): string | null => {
  const absolute = resolve(repoRoot, path);
  const rel = relative(repoRoot, absolute);
  const escapes = rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  return escapes ? null : absolute;
};

export const uploadStageArtifacts = (input: UploadInput, deps: UploadDeps): UploadResult => {
  const paths = input.artifacts
    .map((artifact) => containedPath(input.repoRoot, artifact.path))
    .filter((path): path is string => path !== null)
    .filter(deps.exists);
  if (paths.length === 0) return { status: "skipped", detail: "no artifacts to upload" };

  if (!supportsUpload(deps)) {
    return { status: "skipped", detail: "installed samskara has no `artifacts upload` command" };
  }

  const session = deps.session(input.artifactDir);
  if (session === null) return { status: "skipped", detail: "no session id for this run" };

  const result = deps.run("samskara", ["artifacts", "upload", session, ...paths, "--base-dir", input.repoRoot]);
  if (result.exit !== 0) {
    throw new Error(`samskara upload failed (exit ${result.exit}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { status: "uploaded", detail: `${paths.length} to session ${session}` };
};
