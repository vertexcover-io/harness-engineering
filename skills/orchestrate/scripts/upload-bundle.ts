#!/usr/bin/env node --experimental-strip-types
// Zips a spec directory and attaches it to the run's ticket through the project's
// configured tracker (the `tracker` block in orchestrate.config.json). Best-effort
// by contract: every missing piece — config, credentials, ticket, capability, the
// upload itself — prints one line and exits 0, because Stage 6 must never fail on
// tracker trouble.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentBranch,
  loadTrackerConfig,
  resolveProvider,
  resolveTicketRef,
} from "../../_shared/tracker.ts";
import type { TrackerProvider } from "../../_shared/tracker.ts";

const MAX_ATTACHMENT_BYTES = 90 * 1024 * 1024;
const ZIP_ALWAYS_EXCLUDES = ["*.zip"];
const ZIP_OVERSIZE_EXCLUDES = ["*.zip", "verification/traces/*"];

function zipSpecDir(specDir: string, zipPath: string, excludes: ReadonlyArray<string>): void {
  execFileSync("zip", ["-qr", zipPath, ".", "-x", ...excludes], { cwd: specDir, stdio: "ignore" });
}

const skip = (line: string): never => {
  console.log(line);
  process.exit(0);
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const specDir = process.argv[2];
const zipName = process.argv[3];
if (!specDir || !zipName) {
  console.log("usage: upload-bundle.ts <spec-dir> <zip-name>");
  process.exit(1);
}

let provider: TrackerProvider;
let ref: string;
try {
  const cfg = loadTrackerConfig();
  if (cfg === null) skip(`no tracker block in orchestrate.config.json — skipping ${zipName} upload`);
  provider = resolveProvider(cfg);
  if (!provider.capabilities.has("attach")) {
    skip(`provider "${provider.name}" does not support attach — skipping ${zipName} upload`);
  }
  const branch = currentBranch(process.cwd());
  const resolved = resolveTicketRef(null, cfg.pattern, branch);
  if (resolved === null) skip(`branch "${branch}" carries no ticket ref — skipping ${zipName} upload`);
  ref = resolved;
} catch (err) {
  skip(`${message(err)} — skipping ${zipName} upload`);
}

const tempDir = mkdtempSync(join(tmpdir(), "harness-bundle-"));
const zipPath = join(tempDir, zipName);
try {
  zipSpecDir(specDir, zipPath, ZIP_ALWAYS_EXCLUDES);
  const oversize = statSync(zipPath).size > MAX_ATTACHMENT_BYTES;
  if (oversize) {
    rmSync(zipPath);
    zipSpecDir(specDir, zipPath, ZIP_OVERSIZE_EXCLUDES);
  }
  const note = oversize ? " (over 90MB — verification/traces excluded)" : "";
  const result = await provider.attach(ref, zipPath, zipName);
  console.log(result.ok ? `attached ${zipName} to ${ref}${note}` : `FAILED to attach ${zipName}: ${result.detail}`);
} catch (error) {
  console.log(`FAILED to attach ${zipName}: ${message(error)}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
