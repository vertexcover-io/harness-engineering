#!/usr/bin/env node --experimental-strip-types
// Tracker bridge — harness skills speak a small canonical verb set (resolve, get,
// comment, transition, link); a provider translates each verb into one tracker's
// API; the `tracker` block in orchestrate.config.json maps this project's own
// workflow (branch→ticket rule, state names) onto both. Skills never learn a
// project's stage names, and projects never write API calls.
//
// Exit discipline: reads (resolve, get) exit 1 on a miss, because the caller asked
// for data. Writes are best-effort — an outage, an unmapped state, or an
// unsupported verb prints one line and exits 0. A tracker problem never fails a run.
//
// Usage:
//   tracker.ts resolve
//   tracker.ts get        [--ref R]
//   tracker.ts comment    (--body S | --body-file F) [--marker M] [--ref R]
//   tracker.ts transition --to <started|in_review|verified|done|blocked> [--ref R]
//   tracker.ts link       --url URL [--title T] [--ref R]
//   tracker.ts attach     --file PATH [--name N] [--ref R]
// Global: --dry-run prints what would be sent and sends nothing.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectConfig } from "./harness-config.ts";

export const LIFECYCLE_STATES = ["started", "in_review", "verified", "done", "blocked"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const VERBS = ["resolve", "get", "comment", "transition", "link", "attach"] as const;
export type Verb = (typeof VERBS)[number];
const READ_VERBS: ReadonlySet<Verb> = new Set(["resolve", "get"]);

export class TrackerError extends Error {}

export type Ticket = {
  readonly ref: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly labels: readonly string[];
};

export type WriteResult = { readonly ok: boolean; readonly detail: string };

export type TrackerProvider = {
  readonly name: string;
  readonly capabilities: ReadonlySet<Verb>;
  readonly get: (ref: string) => Promise<Ticket>;
  readonly comments: (ref: string) => Promise<readonly string[]>;
  readonly comment: (ref: string, body: string) => Promise<WriteResult>;
  readonly transition: (ref: string, state: string) => Promise<WriteResult>;
  readonly link: (ref: string, url: string, title: string) => Promise<WriteResult>;
  readonly attach: (ref: string, file: string, name: string) => Promise<WriteResult>;
};

export type TrackerConfig = {
  readonly provider: string;
  readonly pattern: string | null;
  readonly states: Readonly<Record<string, string>>;
  readonly secrets: Readonly<Record<string, string>>;
};

export type Args = {
  readonly verb: Verb;
  readonly ref: string | null;
  readonly to: LifecycleState | null;
  readonly url: string | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly marker: string | null;
  readonly file: string | null;
  readonly name: string | null;
  readonly dryRun: boolean;
};

export type Outcome = { readonly lines: readonly string[]; readonly code: number };

const isVerb = (v: string): v is Verb => (VERBS as readonly string[]).includes(v);
const isLifecycle = (v: string): v is LifecycleState => (LIFECYCLE_STATES as readonly string[]).includes(v);

export const parseArgs = (argv: readonly string[]): Args => {
  const verb = argv[0];
  if (verb === undefined || !isVerb(verb)) {
    throw new TrackerError(`Unknown verb "${verb ?? ""}". Supported: ${VERBS.join(", ")}.`);
  }

  let ref: string | null = null;
  let to: LifecycleState | null = null;
  let url: string | null = null;
  let title: string | null = null;
  let body: string | null = null;
  let marker: string | null = null;
  let file: string | null = null;
  let name: string | null = null;
  let dryRun = false;

  for (let i = 1; i < argv.length; ) {
    const flag = argv[i];
    if (flag === "--dry-run") {
      dryRun = true;
      i += 1;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) throw new TrackerError(`Flag "${flag}" is missing its value.`);
    switch (flag) {
      case "--ref": ref = value; break;
      case "--to":
        if (!isLifecycle(value)) {
          throw new TrackerError(`Unknown --to "${value}". Lifecycle states: ${LIFECYCLE_STATES.join(", ")}.`);
        }
        to = value;
        break;
      case "--url": url = value; break;
      case "--title": title = value; break;
      case "--body": body = value; break;
      case "--body-file": body = readFileSync(value, "utf8"); break;
      case "--marker": marker = value; break;
      case "--file": file = value; break;
      case "--name": name = value; break;
      default: throw new TrackerError(`Unknown flag "${flag}".`);
    }
    i += 2;
  }

  if (verb === "comment" && body === null) throw new TrackerError("comment needs --body or --body-file.");
  if (verb === "transition" && to === null) {
    throw new TrackerError(`transition needs --to. Lifecycle states: ${LIFECYCLE_STATES.join(", ")}.`);
  }
  if (verb === "link" && url === null) throw new TrackerError("link needs --url.");
  if (verb === "attach" && file === null) throw new TrackerError("attach needs --file.");
  return { verb, ref, to, url, title, body, marker, file, name, dryRun };
};

const recordAt = (obj: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> | null => {
  const value = obj[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
};

const stringAt = (obj: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = obj[key];
  return typeof value === "string" ? value : null;
};

const stringMap = (raw: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "string")) as Record<string, string>;

export const loadTrackerConfig = (cwd: string = process.cwd()): TrackerConfig | null => {
  const project = loadProjectConfig(cwd);
  const block = recordAt(project.raw, "tracker");
  if (block === null) return null;
  const resolveBlock = recordAt(block, "resolve");
  return {
    provider: stringAt(block, "provider") ?? "",
    pattern: resolveBlock === null ? null : stringAt(resolveBlock, "pattern"),
    states: stringMap(recordAt(block, "states") ?? {}),
    secrets: project.secrets,
  };
};

export const resolveTicketRef = (
  explicit: string | null,
  pattern: string | null,
  branch: string,
): string | null => {
  if (explicit !== null) return explicit;
  if (pattern === null) {
    throw new TrackerError("tracker.resolve.pattern is not set and no --ref was given.");
  }
  return new RegExp(pattern).exec(branch)?.[0] ?? null;
};

const failCode = (verb: Verb): number => (READ_VERBS.has(verb) ? 1 : 0);
const skip = (line: string): Outcome => ({ lines: [line], code: 0 });
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const runComment = async (
  provider: TrackerProvider,
  ref: string,
  body: string,
  marker: string | null,
  dryRun: boolean,
): Promise<Outcome> => {
  const stamped = marker !== null && !body.includes(marker) ? `${body}\n\n<!-- ${marker} -->` : body;
  if (dryRun) {
    const suffix = marker === null ? "" : `, marker ${marker}`;
    return skip(`DRY-RUN ${provider.name} comment ${ref} (${stamped.length} chars${suffix})`);
  }
  if (marker !== null) {
    const existing = await provider.comments(ref);
    if (existing.some((c) => c.includes(marker))) {
      return skip(`comment with marker "${marker}" already on ${ref} — skipping`);
    }
  }
  const result = await provider.comment(ref, stamped);
  return skip(result.ok ? `commented on ${ref}` : `comment failed: ${result.detail}`);
};

const runTransition = async (
  provider: TrackerProvider,
  ref: string,
  to: LifecycleState,
  states: Readonly<Record<string, string>>,
  dryRun: boolean,
): Promise<Outcome> => {
  const target = states[to];
  if (target === undefined) return skip(`no project state mapped for "${to}" — ticket not moved`);
  if (dryRun) return skip(`DRY-RUN ${provider.name} transition ${ref} -> "${target}"`);
  const result = await provider.transition(ref, target);
  return skip(result.ok ? `moved ${ref} -> "${target}"` : `transition skipped: ${result.detail}`);
};

const runLink = async (
  provider: TrackerProvider,
  ref: string,
  url: string,
  title: string | null,
  dryRun: boolean,
): Promise<Outcome> => {
  if (provider.capabilities.has("link")) {
    if (dryRun) return skip(`DRY-RUN ${provider.name} link ${ref} -> ${url}`);
    const result = await provider.link(ref, url, title ?? "Pull request");
    return skip(result.ok ? `linked ${url} to ${ref}` : `link skipped: ${result.detail}`);
  }
  if (provider.capabilities.has("comment")) {
    // No native link on this tracker: a marked comment is the discoverable fallback,
    // and the marker keeps a re-run of the same stage from posting it twice.
    return runComment(provider, ref, `**${title ?? "Pull request"}:** ${url}`, `harness:link:${url}`, dryRun);
  }
  return skip(`provider "${provider.name}" supports neither link nor comment — skipping link`);
};

const runAttach = async (
  provider: TrackerProvider,
  ref: string,
  file: string,
  name: string,
  dryRun: boolean,
): Promise<Outcome> => {
  if (dryRun) return skip(`DRY-RUN ${provider.name} attach ${name} -> ${ref}`);
  const result = await provider.attach(ref, file, name);
  return skip(result.ok ? `attached ${name} to ${ref}` : `attach failed: ${result.detail}`);
};

export const performVerb = async (
  args: Args,
  cfg: TrackerConfig,
  provider: TrackerProvider,
  branch: string,
): Promise<Outcome> => {
  const ref = resolveTicketRef(args.ref, cfg.pattern, branch);
  if (args.verb === "resolve") {
    return ref === null
      ? { lines: [`branch "${branch}" carries no ticket ref`], code: 1 }
      : { lines: [ref], code: 0 };
  }
  if (ref === null) {
    return { lines: [`branch "${branch}" carries no ticket ref — skipping ${args.verb}`], code: failCode(args.verb) };
  }
  if (args.verb !== "link" && !provider.capabilities.has(args.verb)) {
    return { lines: [`provider "${provider.name}" does not support ${args.verb} — skipping`], code: failCode(args.verb) };
  }

  try {
    switch (args.verb) {
      case "get":
        return { lines: [JSON.stringify(await provider.get(ref), null, 2)], code: 0 };
      case "comment":
        return await runComment(provider, ref, args.body ?? "", args.marker, args.dryRun);
      case "transition":
        return await runTransition(provider, ref, args.to ?? "started", cfg.states, args.dryRun);
      case "link":
        return await runLink(provider, ref, args.url ?? "", args.title, args.dryRun);
      case "attach": {
        const file = args.file ?? "";
        return await runAttach(provider, ref, file, args.name ?? basename(file), args.dryRun);
      }
    }
  } catch (err) {
    return { lines: [`${args.verb} failed: ${message(err)}`], code: failCode(args.verb) };
  }
};

// ---------------------------------------------------------------------------
// GitHub provider — issues via the gh CLI, which owns authentication.

export type Exec = (args: readonly string[]) => string;

const ghExec: Exec = (args) =>
  execFileSync("gh", args as string[], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const labelNames = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.flatMap((label: unknown) => {
        const name = typeof label === "object" && label !== null ? (label as Record<string, unknown>)["name"] : null;
        return typeof name === "string" ? [name] : [];
      })
    : [];

export const createGithub = (exec: Exec = ghExec): TrackerProvider => {
  const num = (ref: string): string => ref.replace(/^#/, "");
  const ok: WriteResult = { ok: true, detail: "" };
  return {
    name: "github",
    capabilities: new Set<Verb>(["get", "comment", "transition"]),

    get: async (ref) => {
      const raw = JSON.parse(
        exec(["issue", "view", num(ref), "--json", "number,title,body,state,url,labels"]),
      ) as Record<string, unknown>;
      return {
        ref: `#${String(raw["number"] ?? "")}`,
        url: asString(raw["url"]),
        title: asString(raw["title"]),
        body: asString(raw["body"]),
        state: asString(raw["state"]).toLowerCase(),
        labels: labelNames(raw["labels"]),
      };
    },

    comments: async (ref) => {
      const raw = JSON.parse(exec(["issue", "view", num(ref), "--json", "comments"])) as Record<string, unknown>;
      const list = raw["comments"];
      return Array.isArray(list)
        ? list.flatMap((c: unknown) => {
            const body = typeof c === "object" && c !== null ? (c as Record<string, unknown>)["body"] : null;
            return typeof body === "string" ? [body] : [];
          })
        : [];
    },

    comment: async (ref, body) => {
      exec(["issue", "comment", num(ref), "--body", body]);
      return ok;
    },

    transition: async (ref, state) => {
      const target = state.toLowerCase();
      if (target === "closed") {
        exec(["issue", "close", num(ref)]);
        return ok;
      }
      if (target === "open") {
        exec(["issue", "reopen", num(ref)]);
        return ok;
      }
      return {
        ok: false,
        detail: `github issues are only open/closed — cannot reach "${state}"; map states to those or leave them unmapped`,
      };
    },

    // Linking on GitHub is a PR-side write (a "Closes #N" keyword in the PR body),
    // not a ticket write — so the capability is absent and link degrades to a comment.
    link: async () => ({ ok: false, detail: "github links PRs from the PR body, not the issue" }),

    attach: async () => ({ ok: false, detail: "github issues cannot take file attachments via the API" }),
  };
};

// ---------------------------------------------------------------------------
// Asana provider — tasks via the REST API. A ticket ref resolves to the task in
// ASANA_WORKSPACE_GID whose name carries the ref (the branch→task convention the
// old upload-bundle.ts and functional-verify publish flow both used).

type FetchResponse = {
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
};
export type FetchLike = (url: string, init?: RequestInit) => Promise<FetchResponse>;

const dataOf = (body: unknown): unknown =>
  typeof body === "object" && body !== null && "data" in body ? (body as { data: unknown }).data : null;

export const createAsana = (
  secrets: Readonly<Record<string, string>>,
  fetchFn: FetchLike = fetch,
): TrackerProvider => {
  const need = (key: string): string => {
    const value = secrets[key];
    if (!value) {
      throw new TrackerError(`provider "asana" needs ${key}. Export it, or add it to .env at the repo root.`);
    }
    return value;
  };

  const API = "https://app.asana.com/api/1.0";
  const pat = need("ASANA_PAT");
  const workspace = need("ASANA_WORKSPACE_GID");

  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetchFn(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${pat}`, ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new TrackerError(`asana ${path.split("?")[0]} failed: ${response.status}`);
    return response.json();
  };

  const taskGid = async (ref: string): Promise<string> => {
    const body = await call(`/workspaces/${workspace}/tasks/search?text=${encodeURIComponent(ref)}&opt_fields=gid,name`);
    const data = dataOf(body);
    const tasks = Array.isArray(data)
      ? data.flatMap((item: unknown) => {
          const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
          const gid = record["gid"];
          const name = record["name"];
          return typeof gid === "string" && typeof name === "string" ? [{ gid, name }] : [];
        })
      : [];
    const gid = tasks.find((task) => task.name.includes(ref))?.gid;
    if (gid === undefined) throw new TrackerError(`no asana task named ${ref} in workspace ${workspace}`);
    return gid;
  };

  return {
    name: "asana",
    capabilities: new Set<Verb>(["get", "comment", "attach"]),

    get: async (ref) => {
      const gid = await taskGid(ref);
      const body = await call(`/tasks/${gid}?opt_fields=name,notes,completed,permalink_url`);
      const task = typeof dataOf(body) === "object" && dataOf(body) !== null ? (dataOf(body) as Record<string, unknown>) : {};
      return {
        ref,
        url: asString(task["permalink_url"]),
        title: asString(task["name"]),
        body: asString(task["notes"]),
        state: task["completed"] === true ? "completed" : "open",
        labels: [],
      };
    },

    comments: async (ref) => {
      const gid = await taskGid(ref);
      const body = await call(`/tasks/${gid}/stories?opt_fields=type,text`);
      const data = dataOf(body);
      return Array.isArray(data)
        ? data.flatMap((story: unknown) => {
            const record = typeof story === "object" && story !== null ? (story as Record<string, unknown>) : {};
            return record["type"] === "comment" && typeof record["text"] === "string" ? [record["text"]] : [];
          })
        : [];
    },

    comment: async (ref, body) => {
      const gid = await taskGid(ref);
      await call(`/tasks/${gid}/stories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { text: body } }),
      });
      return { ok: true, detail: "" };
    },

    // Asana states are project sections or enum fields — per-project structures the
    // provider cannot see yet. Absent from capabilities, so transition degrades cleanly.
    transition: async () => ({ ok: false, detail: "asana states are project sections — not supported yet" }),

    link: async () => ({ ok: false, detail: "asana has no native PR link" }),

    attach: async (ref, file, name) => {
      const gid = await taskGid(ref);
      const form = new FormData();
      form.append("parent", gid);
      form.append("file", new Blob([readFileSync(file)], { type: "application/octet-stream" }), name);
      await call("/attachments", { method: "POST", body: form });
      return { ok: true, detail: "" };
    },
  };
};

const providers: Record<string, (secrets: Readonly<Record<string, string>>) => TrackerProvider> = {
  github: () => createGithub(),
  asana: (secrets) => createAsana(secrets),
};

export const resolveProvider = (cfg: TrackerConfig): TrackerProvider => {
  const factory = providers[cfg.provider];
  if (factory === undefined) {
    throw new TrackerError(
      `Unknown tracker provider "${cfg.provider}". Supported: ${Object.keys(providers).join(", ")}.`,
    );
  }
  return factory(cfg.secrets);
};

export const currentBranch = (cwd: string): string => {
  try {
    return execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
};

export const main = async (
  argv: readonly string[],
  injected: TrackerProvider | null = null,
  cwd: string = process.cwd(),
): Promise<number> => {
  const args = parseArgs(argv);
  const cfg = loadTrackerConfig(cwd);
  if (cfg === null) {
    process.stderr.write("tracker: no tracker block in orchestrate.config.json — skipping.\n");
    return failCode(args.verb);
  }
  const provider = injected ?? resolveProvider(cfg);
  const outcome = await performVerb(args, cfg, provider, currentBranch(cwd));
  for (const line of outcome.lines) process.stdout.write(`${line}\n`);
  return outcome.code;
};

if (fileURLToPath(import.meta.url) === resolvePath(process.argv[1] ?? "")) {
  const argv = process.argv.slice(2);
  let failExit = 1; // usage errors are loud; a parsed write verb fails soft below
  try {
    failExit = failCode(parseArgs(argv).verb);
    process.exitCode = await main(argv);
  } catch (err) {
    process.stderr.write(`tracker: ${message(err)}\n`);
    process.exitCode = failExit;
  }
}
