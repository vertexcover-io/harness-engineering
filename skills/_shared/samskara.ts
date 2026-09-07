import { isAbsolute, join } from "node:path";

export type Runner = (
  cmd: string,
  args: readonly string[],
) => { readonly exit: number; readonly stdout: string; readonly stderr: string };

export type UploadDeps = {
  readonly run: Runner;
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string;
  readonly sessionFallback: () => string | null;
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// v0.3.0 exits 0 on an unknown subcommand and prints the top-level help, so the exit code
// says nothing. The flag only appears in the subcommand's own help.
const PROBE_FLAG = "--base-dir";

const supportsUpload = (deps: UploadDeps): boolean => {
  const probe = deps.run("samskara", ["artifacts", "upload", "--help"]);
  return probe.exit === 0 && probe.stdout.includes(PROBE_FLAG);
};

const sessionFromManifest = (deps: UploadDeps, artifactDir: string): string | null => {
  const manifest = join(artifactDir, "manifest.json");
  if (!deps.exists(manifest)) return null;
  try {
    const parsed: unknown = JSON.parse(deps.readText(manifest));
    if (!isRecord(parsed) || !isRecord(parsed["run_info"])) return null;
    const session = parsed["run_info"]["session"];
    return typeof session === "string" && session !== "" ? session : null;
  } catch {
    return null;
  }
};

const resolveSession = (input: UploadInput, deps: UploadDeps): string | null => {
  const fromManifest =
    input.artifactDir === undefined ? null : sessionFromManifest(deps, input.artifactDir);
  return fromManifest ?? deps.sessionFallback();
};

export const uploadStageArtifacts = (input: UploadInput, deps: UploadDeps): UploadResult => {
  const paths = input.artifacts
    .map((artifact) => (isAbsolute(artifact.path) ? artifact.path : join(input.repoRoot, artifact.path)))
    .filter(deps.exists);
  if (paths.length === 0) return { status: "skipped", detail: "no artifacts to upload" };

  if (!supportsUpload(deps)) {
    return { status: "skipped", detail: "installed samskara has no `artifacts upload` command" };
  }

  const session = resolveSession(input, deps);
  if (session === null) return { status: "skipped", detail: "no session id for this run" };

  const result = deps.run("samskara", ["artifacts", "upload", session, ...paths, "--base-dir", input.repoRoot]);
  if (result.exit !== 0) {
    throw new Error(`samskara upload failed (exit ${result.exit}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return { status: "uploaded", detail: `${paths.length} to session ${session}` };
};
