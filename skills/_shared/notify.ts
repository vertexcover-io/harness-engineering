#!/usr/bin/env node --experimental-strip-types

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const EVENTS = [
  "run-started",
  "stage-started",
  "stage-completed",
  "question-pending",
  "run-interrupted",
  "run-completed",
  "hook-failed",
] as const;

export type NotifyEvent = (typeof EVENTS)[number];

export type PendingQuestion = { readonly question: string; readonly answers?: readonly string[] };
export type HookFailure = {
  readonly name: string;
  readonly event: string;
  readonly required: boolean;
  readonly detail: string;
};

export type Args = {
  readonly event: NotifyEvent;
  readonly stage: string | null;
  readonly title: string | null;
  readonly body: string | null;
  readonly questions: readonly PendingQuestion[];
  readonly failure: HookFailure | null;
  readonly thread: string | null;
  readonly artifacts: readonly string[];
};

export type Message = {
  readonly title: string;
  readonly body: string;
  /** Questions stay structured to here: each provider renders them in its own markup. */
  readonly questions: readonly PendingQuestion[];
  readonly failure: HookFailure | null;
  readonly threadRef: string | null;
  /** Address the message to a person. True for the events a human must act on. */
  readonly mention: boolean;
};

export type Provider = {
  readonly send: (msg: Message) => Promise<string | null>;
  readonly upload: (file: string, msg: Message) => Promise<void>;
};

export type Config = {
  readonly provider: string;
  readonly secrets: Readonly<Record<string, string>>;
};

export class NotifierError extends Error {}

export const parseArgs = (argv: readonly string[]): Args => {
  let event: NotifyEvent | null = null;
  let stage: string | null = null;
  let title: string | null = null;
  let body: string | null = null;
  let thread: string | null = null;
  const artifacts: string[] = [];

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new NotifierError(`Flag "${flag}" is missing its value.`);
    switch (flag) {
      case "--event":
        if (!(EVENTS as readonly string[]).includes(value)) {
          throw new NotifierError(`Unknown --event "${value}". Supported: ${EVENTS.join(", ")}.`);
        }
        event = value as NotifyEvent;
        break;
      case "--stage": stage = value; break;
      case "--title": title = value; break;
      case "--body": body = value; break;
      case "--thread": thread = value; break;
      case "--artifact": artifacts.push(value); break;
      default: throw new NotifierError(`Unknown flag "${flag}".`);
    }
  }

  if (event === null) throw new NotifierError("--event is required.");
  return { event, stage, title, body, questions: [], failure: null, thread, artifacts };
};

const CONFIG_FILE = "orchestrate.config.json";

type NotifierBlock = {
  readonly notifier?: { readonly enabled?: boolean; readonly provider?: string };
};

export const loadConfig = (cwd: string = process.cwd()): Config | null => {
  let roots: string[] = [];
  try {
    roots = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim().split("\n");
  } catch {
    throw new NotifierError(`Not a git repository: ${cwd}. The harness needs one to locate ${CONFIG_FILE}.`);
  }

  const repoRoot = roots[0] ?? "";
  const mainCheckout = dirname(roots[1] ?? "");

  const configFile = join(repoRoot, CONFIG_FILE);
  if (!existsSync(configFile)) {
    throw new NotifierError(`${CONFIG_FILE} not found at ${repoRoot}. Run setup-harness to create it.`);
  }

  const { notifier } = JSON.parse(readFileSync(configFile, "utf8")) as NotifierBlock;
  if (notifier?.enabled !== true) return null;

  let fromDotenv: Record<string, string> = {};
  try {
    fromDotenv = parseEnv(readFileSync(join(mainCheckout, ".env"), "utf8")) as Record<string, string>;
  } catch {
    fromDotenv = {};
  }

  return {
    provider: notifier.provider ?? "",
    secrets: { ...fromDotenv, ...process.env } as Record<string, string>,
  };
};

const SLACK_API = "https://slack.com/api";

const slackPost = async (
  token: string,
  method: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> => {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: new URLSearchParams(form).toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json["ok"] !== true) {
    throw new NotifierError(`slack ${method} failed: ${String(json["error"] ?? res.status)}`);
  }
  return json;
};

const slackQuestion = (q: PendingQuestion): string =>
  [`*${q.question}*`, ...(q.answers ?? []).map((a) => `\u2022 ${a}`)].join("\n");

const slackFailure = (f: HookFailure): string => `*${f.name}* failed on ${f.event}\n${f.detail}`;

export const slackText = (msg: Message, memberId: string): string => {
  // Outside the bold marker: Slack renders `<@ID>` as a name, and bold-wrapping it reads as shouting.
  const heading = msg.mention ? `<@${memberId}> *${msg.title}*` : `*${msg.title}*`;
  const questions = msg.questions.map(slackQuestion).join("\n\n");
  const failure = msg.failure === null ? "" : slackFailure(msg.failure);
  return [heading, msg.body, questions, failure].filter((part) => part !== "").join("\n");
};

const createSlack = (secrets: Readonly<Record<string, string>>): Provider => {
  const need = (key: string): string => {
    const value = secrets[key];
    if (!value) {
      throw new NotifierError(
        `notifier: provider "slack" needs ${key}. Export it, or add it to .env at the repo root.`,
      );
    }
    return value;
  };

  const token = need("SLACK_BOT_TOKEN");
  const channel = need("SLACK_CHANNEL_ID");
  const memberId = need("SLACK_MEMBER_ID");
  const thread = (msg: Message): Record<string, string> =>
    msg.threadRef === null ? {} : { thread_ts: msg.threadRef };

  return {
    send: async (msg) => {
      const res = await slackPost(token, "chat.postMessage", {
        channel,
        text: slackText(msg, memberId),
        ...thread(msg),
      });
      return typeof res["ts"] === "string" ? res["ts"] : null;
    },

    upload: async (file, msg) => {
      const name = basename(file);
      const bytes = readFileSync(file);
      const ticket = await slackPost(token, "files.getUploadURLExternal", {
        filename: name,
        length: String(bytes.byteLength),
      });
      const uploadUrl = String(ticket["upload_url"] ?? "");
      const fileId = String(ticket["file_id"] ?? "");
      if (!uploadUrl || !fileId) throw new NotifierError("slack files.getUploadURLExternal returned no upload url");

      const put = await fetch(uploadUrl, { method: "POST", body: bytes });
      if (!put.ok) throw new NotifierError(`slack file upload failed: ${put.status}`);

      await slackPost(token, "files.completeUploadExternal", {
        files: JSON.stringify([{ id: fileId, title: name }]),
        channel_id: channel,
        ...thread(msg),
      });
    },
  };
};

const providers: Record<string, (secrets: Readonly<Record<string, string>>) => Provider> = {
  slack: createSlack,
};

export const resolveProvider = (config: Config): Provider => {
  const factory = providers[config.provider];
  if (factory === undefined) {
    throw new NotifierError(
      `Unknown notifier provider "${config.provider}". Supported: ${Object.keys(providers).join(", ")}.`,
    );
  }
  return factory(config.secrets);
};

// The events a person is expected to act on. Stage traffic stays unaddressed, so a run of
// six stages does not notify anybody six times over.
const MENTIONED: ReadonlySet<NotifyEvent> = new Set([
  "run-started",
  "question-pending",
  "run-interrupted",
  "run-completed",
]);

export const formatMessage = (args: Args): Message => {
  const spec = args.title ?? "harness";
  const stage = args.stage ?? "unknown";

  let title: string;
  switch (args.event) {
    case "run-started":      title = `Harness run started: ${spec}`; break;
    case "stage-started":    title = `Stage ${stage} · started`; break;
    case "stage-completed":  title = `Stage ${stage} · done`; break;
    case "question-pending": title = `Waiting for you · stage ${stage}`; break;
    case "run-interrupted":  title = `Run interrupted · stage ${stage}`; break;
    case "run-completed":    title = `Run complete: ${spec}`; break;
    case "hook-failed":      title = `Hook failed \u00b7 stage ${stage}`; break;
  }

  return {
    title,
    body: args.body ?? "",
    questions: args.questions,
    failure: args.failure,
    threadRef: args.thread,
    // A hook that broke is only worth waking someone for when the run depended on it.
    mention: MENTIONED.has(args.event) || args.failure?.required === true,
  };
};

export const main = async (
  argv: readonly string[],
  injected: Provider | null = null,
  cwd: string = process.cwd(),
): Promise<number> => {
  const args = parseArgs(argv);
  const config = loadConfig(cwd);
  if (config === null) {
    process.stderr.write(`notify: notifications are disabled in ${CONFIG_FILE} — nothing sent.\n`);
    return 0;
  }

  const provider = injected ?? resolveProvider(config);
  const message = formatMessage(args);

  const ts = await provider.send(message);
  for (const file of args.artifacts) await provider.upload(file, message);

  if (ts !== null) process.stdout.write(`${ts}\n`);
  return 0;
};

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  const argv = process.argv.slice(2);
  let strict = true;
  try {
    strict = parseArgs(argv).event === "run-started";
    process.exitCode = await main(argv);
  } catch (err) {
    process.stderr.write(`notify: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = strict ? 1 : 0;
  }
}
