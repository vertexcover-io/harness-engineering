import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const API = "https://app.asana.com/api/1.0";

export type Credentials = { readonly pat: string; readonly workspace: string };

export type TrackerConfig = {
  readonly provider: string;
  readonly project: string;
  readonly refField: string;
  readonly ownerField: string;
  readonly sections: Readonly<Record<string, string>>;
};

export type AsanaTask = {
  readonly gid: string;
  readonly name: string;
  readonly projects: ReadonlyArray<{ readonly gid: string }>;
  readonly customFields: ReadonlyArray<AsanaCustomField>;
};

export type AsanaCustomField = {
  readonly gid: string;
  readonly people_value?: ReadonlyArray<{ readonly gid: string; readonly name: string }>;
};

const TICKET_REF = /[A-Z]{2,}-\d+/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readEnvFile = (file: string, key: string): string | null => {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = new RegExp(`^${key}=(.*)$`).exec(line.trim());
    if (match?.[1] !== undefined) return match[1].replace(/^["']|["']$/g, "").trim() || null;
  }
  return null;
};

export const readEnvValue = (key: string): string | null =>
  process.env[key]?.trim() || readEnvFile(".env", key);

export const readCredentials = (): Credentials | null => {
  const pat = readEnvValue("ASANA_PAT");
  const workspace = readEnvValue("ASANA_WORKSPACE_GID");
  return pat && workspace ? { pat, workspace } : null;
};

export const currentTicketRef = (): string | null => {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return TICKET_REF.exec(branch)?.[0] ?? null;
  } catch {
    return null;
  }
};

export const readTrackerConfig = (file = "orchestrate.config.json"): TrackerConfig | null => {
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const tracker = parsed["tracker"];
  if (!isRecord(tracker)) return null;

  const { provider, project, refField, ownerField, sections } = tracker;
  if (typeof provider !== "string" || provider !== "asana") return null;
  if (typeof project !== "string" || typeof refField !== "string" || typeof ownerField !== "string") return null;
  if (!isRecord(sections)) return null;

  const named = Object.entries(sections).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return { provider, project, refField, ownerField, sections: Object.fromEntries(named) };
};

const request = async (
  path: string,
  creds: Credentials,
  init: RequestInit = {},
): Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }> => {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${creds.pat}`, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
};

const TASK_FIELDS = "gid,name,projects.gid,custom_fields.gid,custom_fields.people_value.gid,custom_fields.people_value.name";

const toTask = (value: unknown): AsanaTask | null => {
  if (!isRecord(value) || typeof value["gid"] !== "string") return null;
  const projects = Array.isArray(value["projects"])
    ? value["projects"].filter(isRecord).flatMap((p) => (typeof p["gid"] === "string" ? [{ gid: p["gid"] }] : []))
    : [];
  const customFields = Array.isArray(value["custom_fields"])
    ? value["custom_fields"].filter(isRecord).flatMap((f) => (typeof f["gid"] === "string" ? [f as AsanaCustomField] : []))
    : [];
  return {
    gid: value["gid"],
    name: typeof value["name"] === "string" ? value["name"] : "",
    projects,
    customFields,
  };
};

export type LookupResult =
  | { readonly kind: "found"; readonly task: AsanaTask }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly count: number }
  | { readonly kind: "error"; readonly detail: string };

export const findTaskByRef = async (ref: string, refField: string, creds: Credentials): Promise<LookupResult> => {
  const query = `custom_fields.${refField}.value=${encodeURIComponent(ref)}`;
  const { ok, status, body } = await request(
    `/workspaces/${creds.workspace}/tasks/search?${query}&opt_fields=${TASK_FIELDS}&limit=20`,
    creds,
  );

  if (!ok) {
    const reason =
      status === 401 ? "bad or expired ASANA_PAT" : status === 429 ? "rate limited" : `HTTP ${status}`;
    return { kind: "error", detail: reason };
  }
  if (!isRecord(body) || !Array.isArray(body["data"])) return { kind: "error", detail: "unreadable search response" };

  const tasks = body["data"].flatMap((item) => toTask(item) ?? []);
  if (tasks.length > 1) return { kind: "ambiguous", count: tasks.length };
  const first = tasks[0];
  return first ? { kind: "found", task: first } : { kind: "none" };
};

export const readPeopleField = (task: AsanaTask, fieldGid: string): { readonly gid: string; readonly name: string } | null =>
  task.customFields.find((field) => field.gid === fieldGid)?.people_value?.[0] ?? null;

export const isInProject = (task: AsanaTask, projectGid: string): boolean =>
  task.projects.some((project) => project.gid === projectGid);

export const addTaskToProject = async (taskGid: string, projectGid: string, creds: Credentials): Promise<boolean> => {
  const { ok } = await request(`/tasks/${taskGid}/addProject`, creds, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { project: projectGid } }),
  });
  return ok;
};

export const moveTaskToSection = async (taskGid: string, sectionGid: string, creds: Credentials): Promise<boolean> => {
  const { ok } = await request(`/sections/${sectionGid}/addTask`, creds, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { task: taskGid } }),
  });
  return ok;
};

export const assignTask = async (taskGid: string, assigneeGid: string, creds: Credentials): Promise<boolean> => {
  const { ok } = await request(`/tasks/${taskGid}`, creds, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { assignee: assigneeGid } }),
  });
  return ok;
};

const log = (line: string): void => console.log(`asana-transition: ${line}`);
const skip = (reason: string): void => log(`skipped — ${reason}`);

const parseTarget = (argv: readonly string[]): string | null => {
  const index = argv.indexOf("--to");
  return index === -1 ? null : (argv[index + 1] ?? null);
};

export const runTransition = async (argv: readonly string[]): Promise<void> => {
  const target = parseTarget(argv);
  if (!target) {
    console.log("usage: asana.ts --to <section-name>");
    process.exitCode = 1;
    return;
  }

  const config = readTrackerConfig();
  if (!config) return skip("no asana tracker configured in orchestrate.config.json");

  const section = config.sections[target];
  if (!section) {
    const known = Object.keys(config.sections).join(", ") || "none";
    return skip(`tracker.sections has no "${target}" (known: ${known})`);
  }

  const creds = readCredentials();
  if (!creds) return skip("ASANA_PAT or ASANA_WORKSPACE_GID unset");

  const ref = currentTicketRef();
  if (!ref) return skip("branch carries no ticket ref");

  const lookup = await findTaskByRef(ref, config.refField, creds);
  if (lookup.kind === "error") return skip(`could not search for ${ref} — ${lookup.detail}`);
  if (lookup.kind === "ambiguous") return skip(`${lookup.count} tasks carry ${ref} — resolve it by hand`);
  if (lookup.kind === "none") return skip(`no task carries ${ref}`);

  const { task } = lookup;

  if (!isInProject(task, config.project)) {
    const added = await addTaskToProject(task.gid, config.project, creds);
    log(
      added
        ? `added ${ref} to project ${config.project}`
        : `FAILED to add ${ref} to project ${config.project} — section move may not land`,
    );
  }

  const moved = await moveTaskToSection(task.gid, section, creds);
  log(moved ? `moved ${ref} to ${target}` : `FAILED to move ${ref} to ${target} (section ${section})`);

  const owner = readPeopleField(task, config.ownerField);
  if (!owner) return log(`owner field unset on ${ref} — left unassigned`);

  const assigned = await assignTask(task.gid, owner.gid, creds);
  log(assigned ? `assigned ${ref} to ${owner.name}` : `FAILED to assign ${ref} to ${owner.name}`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runTransition(process.argv.slice(2));
}
