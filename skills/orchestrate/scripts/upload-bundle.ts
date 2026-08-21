#!/usr/bin/env node --experimental-strip-types
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Credentials = { readonly pat: string; readonly workspace: string };
type AsanaTask = { readonly gid: string; readonly name: string };

const API = "https://app.asana.com/api/1.0";
const MAX_ATTACHMENT_BYTES = 90 * 1024 * 1024;
const TICKET_REF = /[A-Z]{2,}-\d+/;
const ZIP_ALWAYS_EXCLUDES = ["*.zip"];
const ZIP_OVERSIZE_EXCLUDES = ["*.zip", "verification/traces/*"];

function currentTicketRef(): string | null {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return TICKET_REF.exec(branch)?.[0] ?? null;
  } catch {
    return null;
  }
}

function readTasks(body: unknown): ReadonlyArray<AsanaTask> {
  if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) return [];
  return body.data.filter(
    (item: unknown): item is AsanaTask =>
      typeof item === "object" &&
      item !== null &&
      "gid" in item &&
      typeof item.gid === "string" &&
      "name" in item &&
      typeof item.name === "string",
  );
}

async function findTaskNamedRef(ref: string, creds: Credentials): Promise<string | null> {
  const url = `${API}/workspaces/${creds.workspace}/tasks/search?text=${encodeURIComponent(ref)}&opt_fields=gid,name`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${creds.pat}` } });
  if (!response.ok) return null;
  return readTasks(await response.json()).find((task) => task.name.includes(ref))?.gid ?? null;
}

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

const pat = process.env["ASANA_PAT"];
const workspace = process.env["ASANA_WORKSPACE_GID"];
if (!pat || !workspace) {
  console.log(`ASANA_PAT or ASANA_WORKSPACE_GID unset — skipping ${zipName} upload`);
  process.exit(0);
}

const ref = currentTicketRef();
if (!ref) {
  console.log(`branch carries no ticket ref — skipping ${zipName} upload`);
  process.exit(0);
}

const creds: Credentials = { pat, workspace };
const gid = await findTaskNamedRef(ref, creds);
if (!gid) {
  console.log(`no Asana task named ${ref} — skipping ${zipName} upload`);
  process.exit(0);
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
  const attached = await attachToTask({ zipPath, zipName, gid, creds });
  console.log(attached ? `attached ${zipName} to task ${gid}${note}` : `FAILED to attach ${zipName}`);
} catch (error) {
  console.log(`FAILED to attach ${zipName}: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
