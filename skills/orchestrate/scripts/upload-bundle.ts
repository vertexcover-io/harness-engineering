#!/usr/bin/env node --experimental-strip-types
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { API, currentTicketRef, findTaskByRef, readCredentials, readTrackerConfig, type Credentials } from "../../_shared/asana.ts";

const MAX_ATTACHMENT_BYTES = 90 * 1024 * 1024;
const ZIP_ALWAYS_EXCLUDES = ["*.zip"];
const ZIP_OVERSIZE_EXCLUDES = ["*.zip", "verification/traces/*"];

function zipSpecDir(specDir: string, zipPath: string, excludes: ReadonlyArray<string>): void {
  execFileSync("zip", ["-qr", zipPath, ".", "-x", ...excludes], { cwd: specDir, stdio: "ignore" });
}

async function attachToTask(options: {
  readonly zipPath: string;
  readonly zipName: string;
  readonly gid: string;
  readonly creds: Credentials;
}): Promise<boolean> {
  const form = new FormData();
  form.append("parent", options.gid);
  form.append("file", new Blob([readFileSync(options.zipPath)], { type: "application/zip" }), options.zipName);
  const response = await fetch(`${API}/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.creds.pat}` },
    body: form,
  });
  return response.ok;
}

const specDir = process.argv[2];
const zipName = process.argv[3];
if (!specDir || !zipName) {
  console.log("usage: upload-bundle.ts <spec-dir> <zip-name>");
  process.exit(1);
}

const config = readTrackerConfig();
if (!config) {
  console.log(`no asana tracker configured — skipping ${zipName} upload`);
  process.exit(0);
}

const creds = readCredentials();
if (!creds) {
  console.log(`ASANA_PAT or ASANA_WORKSPACE_GID unset — skipping ${zipName} upload`);
  process.exit(0);
}

const ref = currentTicketRef();
if (!ref) {
  console.log(`branch carries no ticket ref — skipping ${zipName} upload`);
  process.exit(0);
}

const lookup = await findTaskByRef(ref, config.refField, creds);
if (lookup.kind !== "found") {
  const reason =
    lookup.kind === "error"
      ? `could not search for ${ref} — ${lookup.detail}`
      : lookup.kind === "ambiguous"
        ? `${lookup.count} tasks carry ${ref}`
        : `no task carries ${ref}`;
  console.log(`${reason} — skipping ${zipName} upload`);
  process.exit(0);
}
const task = lookup.task;

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
  const attached = await attachToTask({ zipPath, zipName, gid: task.gid, creds });
  console.log(attached ? `attached ${zipName} to task ${task.gid}${note}` : `FAILED to attach ${zipName}`);
} catch (error) {
  console.log(`FAILED to attach ${zipName}: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
