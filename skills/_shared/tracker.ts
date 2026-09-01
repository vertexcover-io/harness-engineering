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
//   tracker.ts event      NAME [--var KEY=VALUE]... [--ref R]
// Global: --dry-run prints what would be sent and sends nothing.
//
// `event` runs the ordered action list bound to NAME in tracker.on — the
// project's declaration of what each pipeline moment does to its ticket.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectConfig } from "./harness-config.ts";

export const LIFECYCLE_STATES = ["started", "in_review", "verified", "done", "blocked"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const VERBS = ["resolve", "get", "comment", "transition", "link", "attach", "event"] as const;
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

export type EventAction = Readonly<Record<string, unknown>>;

export type TrackerConfig = {
  readonly provider: string;
  readonly pattern: string | null;
  readonly states: Readonly<Record<string, string>>;
  readonly on: Readonly<Record<string, readonly EventAction[]>>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly repoRoot: string;
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
  readonly event: string | null;
  readonly vars: Readonly<Record<string, string>>;
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
  let event: string | null = null;
  const vars: Record<string, string> = {};
  let dryRun = false;

  let first = 1;
  if (verb === "event") {
    const positional = argv[1];
    if (positional === undefined || positional.startsWith("--")) {
      throw new TrackerError("event needs a name, e.g. `event pr-created`.");
    }
    event = positional;
    first = 2;
  }

  for (let i = first; i < argv.length; ) {
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
      case "--var": {
        const eq = value.indexOf("=");
        if (eq < 1) throw new TrackerError(`--var wants KEY=VALUE, got "${value}".`);
        vars[value.slice(0, eq)] = value.slice(eq + 1);
        break;
      }
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
  return { verb, ref, to, url, title, body, marker, file, name, event, vars, dryRun };
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
  const on = Object.fromEntries(
    Object.entries(recordAt(block, "on") ?? {}).map(([eventName, actions]) => [
      eventName,
      Array.isArray(actions)
        ? actions.filter((action): action is EventAction => typeof action === "object" && action !== null)
        : [],
    ]),
  );
  return {
    provider: stringAt(block, "provider") ?? "",
    pattern: resolveBlock === null ? null : stringAt(resolveBlock, "pattern"),
    states: stringMap(recordAt(block, "states") ?? {}),
    on,
    secrets: project.secrets,
    repoRoot: project.repoRoot,
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

const substitute = (template: string, vars: Readonly<Record<string, string>>): string =>
  template.replace(/\{([A-Z_]+)\}/g, (whole, key: string) => vars[key] ?? whole);

const runAction = async (
  provider: TrackerProvider,
  cfg: TrackerConfig,
  ref: string,
  eventName: string,
  action: EventAction,
  vars: Readonly<Record<string, string>>,
  dryRun: boolean,
): Promise<Outcome> => {
  // Comments from an event are stamped per event (and per SPEC when the caller
  // passes one), so a re-run of the same stage never posts a duplicate.
  const marker = ["harness", eventName, vars["SPEC"]].filter(Boolean).join(":");
  const gate = (verb: Verb): Outcome | null =>
    provider.capabilities.has(verb) ? null : skip(`provider "${provider.name}" does not support ${verb} — skipping action`);

  const transitionTo = stringAt(action, "transition");
  if (transitionTo !== null) {
    if (!isLifecycle(transitionTo)) {
      return skip(`event action transition "${transitionTo}" is not a lifecycle state (${LIFECYCLE_STATES.join(", ")}) — skipping`);
    }
    return gate("transition") ?? runTransition(provider, ref, transitionTo, cfg.states, dryRun);
  }

  const linkTemplate = stringAt(action, "link");
  if (linkTemplate !== null) {
    return runLink(provider, ref, substitute(linkTemplate, vars), null, dryRun);
  }

  const commentTemplate = stringAt(action, "comment");
  if (commentTemplate !== null) {
    return gate("comment") ?? runComment(provider, ref, substitute(commentTemplate, vars), marker, dryRun);
  }

  const commentFile = stringAt(action, "comment_file");
  if (commentFile !== null) {
    const path = resolvePath(cfg.repoRoot, commentFile);
    let template: string;
    try {
      template = readFileSync(path, "utf8");
    } catch {
      return skip(`comment_file ${commentFile} not found at ${path} — skipping action`);
    }
    return gate("comment") ?? runComment(provider, ref, substitute(template, vars), marker, dryRun);
  }

  const attachTemplate = stringAt(action, "attach");
  if (attachTemplate !== null) {
    const path = substitute(attachTemplate, vars);
    return gate("attach") ?? runAttach(provider, ref, path, basename(path), dryRun);
  }

  const runTemplate = stringAt(action, "run");
  if (runTemplate !== null) {
    const command = substitute(runTemplate, vars);
    if (dryRun) return skip(`DRY-RUN run: ${command}`);
    try {
      const output = execFileSync("bash", ["-c", command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return skip(`ran: ${command}${output.trim() ? ` -> ${output.trim().split("\n")[0]}` : ""}`);
    } catch (err) {
      return skip(`run failed: ${command}: ${message(err)}`);
    }
  }

  return skip(`unknown event action ${JSON.stringify(action)} — skipping`);
};

const runEvent = async (
  provider: TrackerProvider,
  cfg: TrackerConfig,
  ref: string,
  eventName: string,
  vars: Readonly<Record<string, string>>,
  dryRun: boolean,
): Promise<Outcome> => {
  const actions = cfg.on[eventName];
  if (actions === undefined || actions.length === 0) {
    return skip(`no actions bound for event "${eventName}" — skipping`);
  }
  const lines: string[] = [];
  for (const action of actions) {
    const outcome = await runAction(provider, cfg, ref, eventName, action, vars, dryRun);
    lines.push(...outcome.lines);
  }
  return { lines, code: 0 };
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
  if (args.verb !== "link" && args.verb !== "event" && !provider.capabilities.has(args.verb)) {
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
      case "event": {
        const vars = { ...args.vars, TICKET: ref, BRANCH: branch };
        return await runEvent(provider, cfg, ref, args.event ?? "", vars, args.dryRun);
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

const needSecret = (secrets: Readonly<Record<string, string>>, providerName: string, key: string): string => {
  const value = secrets[key];
  if (!value) {
    throw new TrackerError(`provider "${providerName}" needs ${key}. Export it, or add it to .env at the repo root.`);
  }
  return value;
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
  const API = "https://app.asana.com/api/1.0";
  const pat = needSecret(secrets, "asana", "ASANA_PAT");
  const workspace = needSecret(secrets, "asana", "ASANA_WORKSPACE_GID");

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

// ---------------------------------------------------------------------------
// Linear provider — GraphQL. A ref is the issue identifier ("ENG-123"); a state
// is resolved to the issue's team's stateId by name, so the config's `states`
// values are the names shown in Linear's UI.

type LinearIssue = {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
  readonly stateName: string;
};

export const createLinear = (
  secrets: Readonly<Record<string, string>>,
  fetchFn: FetchLike = fetch,
): TrackerProvider => {
  const key = needSecret(secrets, "linear", "LINEAR_API_KEY");

  const gql = async (query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetchFn("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new TrackerError(`linear graphql failed: ${response.status}`);
    const body = await response.json();
    const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
    if (record["errors"] !== undefined) {
      throw new TrackerError(`linear: ${JSON.stringify(record["errors"]).slice(0, 200)}`);
    }
    return typeof record["data"] === "object" && record["data"] !== null
      ? (record["data"] as Record<string, unknown>)
      : {};
  };

  const findIssue = async (ref: string): Promise<LinearIssue> => {
    const data = await gql(
      `query($ref: String!) { issueSearch(query: $ref, first: 10) {
         nodes { id identifier title description url state { name } } } }`,
      { ref },
    );
    const nodes = (recordAt(data, "issueSearch") ?? {})["nodes"];
    const issues = Array.isArray(nodes)
      ? nodes.flatMap((node: unknown): LinearIssue[] => {
          const record = typeof node === "object" && node !== null ? (node as Record<string, unknown>) : {};
          const id = record["id"];
          const identifier = record["identifier"];
          if (typeof id !== "string" || typeof identifier !== "string") return [];
          return [{
            id,
            identifier,
            title: asString(record["title"]),
            description: asString(record["description"]),
            url: asString(record["url"]),
            stateName: asString((recordAt(record, "state") ?? {})["name"]),
          }];
        })
      : [];
    const issue = issues.find((candidate) => candidate.identifier.toLowerCase() === ref.toLowerCase());
    if (issue === undefined) throw new TrackerError(`no linear issue with identifier ${ref}`);
    return issue;
  };

  const teamStates = async (issueId: string): Promise<ReadonlyArray<{ id: string; name: string }>> => {
    const data = await gql(
      `query($id: String!) { issue(id: $id) { team { states { nodes { id name } } } } }`,
      { id: issueId },
    );
    const nodes = (recordAt(recordAt(recordAt(data, "issue") ?? {}, "team") ?? {}, "states") ?? {})["nodes"];
    return Array.isArray(nodes)
      ? nodes.flatMap((node: unknown) => {
          const record = typeof node === "object" && node !== null ? (node as Record<string, unknown>) : {};
          const id = record["id"];
          const name = record["name"];
          return typeof id === "string" && typeof name === "string" ? [{ id, name }] : [];
        })
      : [];
  };

  return {
    name: "linear",
    capabilities: new Set<Verb>(["get", "comment", "transition", "link"]),

    get: async (ref) => {
      const issue = await findIssue(ref);
      return {
        ref: issue.identifier,
        url: issue.url,
        title: issue.title,
        body: issue.description,
        state: issue.stateName.toLowerCase(),
        labels: [],
      };
    },

    comments: async (ref) => {
      const issue = await findIssue(ref);
      const data = await gql(
        `query($id: String!) { issue(id: $id) { comments { nodes { body } } } }`,
        { id: issue.id },
      );
      const nodes = (recordAt(recordAt(data, "issue") ?? {}, "comments") ?? {})["nodes"];
      return Array.isArray(nodes)
        ? nodes.flatMap((node: unknown) => {
            const body = typeof node === "object" && node !== null ? (node as Record<string, unknown>)["body"] : null;
            return typeof body === "string" ? [body] : [];
          })
        : [];
    },

    comment: async (ref, body) => {
      const issue = await findIssue(ref);
      await gql(
        `mutation($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
        { issueId: issue.id, body },
      );
      return { ok: true, detail: "" };
    },

    transition: async (ref, state) => {
      const issue = await findIssue(ref);
      const states = await teamStates(issue.id);
      const target = states.find((candidate) => candidate.name.toLowerCase() === state.toLowerCase());
      if (target === undefined) {
        return { ok: false, detail: `team has no state named "${state}" — it has: ${states.map((s) => s.name).join(", ")}` };
      }
      await gql(
        `mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
        { id: issue.id, stateId: target.id },
      );
      return { ok: true, detail: "" };
    },

    link: async (ref, url, title) => {
      const issue = await findIssue(ref);
      await gql(
        `mutation($issueId: String!, $url: String!, $title: String!) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }`,
        { issueId: issue.id, url, title },
      );
      return { ok: true, detail: "" };
    },

    attach: async () => ({ ok: false, detail: "linear file uploads are not supported yet — link a URL instead" }),
  };
};

// ---------------------------------------------------------------------------
// Jira provider — REST v2 with basic auth. The crucial semantics: Jira has no
// "set status" — a move must be one of the legal transitions from the current
// status, so the target state name is matched against those and the transition
// id is what gets posted.

export const createJira = (
  secrets: Readonly<Record<string, string>>,
  fetchFn: FetchLike = fetch,
): TrackerProvider => {
  const base = needSecret(secrets, "jira", "JIRA_BASE_URL").replace(/\/+$/, "");
  const email = needSecret(secrets, "jira", "JIRA_EMAIL");
  const token = needSecret(secrets, "jira", "JIRA_API_TOKEN");
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;

  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await fetchFn(`${base}/rest/api/2${path}`, {
      ...init,
      headers: { Authorization: auth, "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    if (!response.ok) throw new TrackerError(`jira ${path.split("?")[0]} failed: ${response.status}`);
    return response.json();
  };

  return {
    name: "jira",
    capabilities: new Set<Verb>(["get", "comment", "transition", "link", "attach"]),

    get: async (ref) => {
      const body = await call(`/issue/${ref}?fields=summary,description,status,labels`);
      const fields = recordAt(typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}, "fields") ?? {};
      const labels = fields["labels"];
      return {
        ref,
        url: `${base}/browse/${ref}`,
        title: asString(fields["summary"]),
        body: asString(fields["description"]),
        state: asString((recordAt(fields, "status") ?? {})["name"]).toLowerCase(),
        labels: Array.isArray(labels) ? labels.filter((label): label is string => typeof label === "string") : [],
      };
    },

    comments: async (ref) => {
      const body = await call(`/issue/${ref}/comment`);
      const comments = (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {})["comments"];
      return Array.isArray(comments)
        ? comments.flatMap((comment: unknown) => {
            const text = typeof comment === "object" && comment !== null ? (comment as Record<string, unknown>)["body"] : null;
            return typeof text === "string" ? [text] : [];
          })
        : [];
    },

    comment: async (ref, body) => {
      await call(`/issue/${ref}/comment`, { method: "POST", body: JSON.stringify({ body }) });
      return { ok: true, detail: "" };
    },

    transition: async (ref, state) => {
      const body = await call(`/issue/${ref}/transitions`);
      const raw = (typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {})["transitions"];
      const transitions = Array.isArray(raw)
        ? raw.flatMap((item: unknown) => {
            const record = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
            const id = record["id"];
            const toName = (recordAt(record, "to") ?? {})["name"];
            return typeof id === "string" && typeof toName === "string" ? [{ id, toName }] : [];
          })
        : [];
      const target = transitions.find((candidate) => candidate.toName.toLowerCase() === state.toLowerCase());
      if (target === undefined) {
        return {
          ok: false,
          detail: `no legal transition to "${state}" from the current status — reachable: ${transitions.map((t) => t.toName).join(", ")}`,
        };
      }
      await call(`/issue/${ref}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: target.id } }) });
      return { ok: true, detail: "" };
    },

    link: async (ref, url, title) => {
      await call(`/issue/${ref}/remotelink`, { method: "POST", body: JSON.stringify({ object: { url, title } }) });
      return { ok: true, detail: "" };
    },

    attach: async (ref, file, name) => {
      const form = new FormData();
      form.append("file", new Blob([readFileSync(file)], { type: "application/octet-stream" }), name);
      const response = await fetchFn(`${base}/rest/api/2/issue/${ref}/attachments`, {
        method: "POST",
        headers: { Authorization: auth, "X-Atlassian-Token": "no-check" },
        body: form,
      });
      if (!response.ok) return { ok: false, detail: `jira attachment failed: ${response.status}` };
      return { ok: true, detail: "" };
    },
  };
};

const providers: Record<string, (secrets: Readonly<Record<string, string>>) => TrackerProvider> = {
  github: () => createGithub(),
  asana: (secrets) => createAsana(secrets),
  linear: (secrets) => createLinear(secrets),
  jira: (secrets) => createJira(secrets),
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
