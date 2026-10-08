import { readFile, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AgentStoppedEvent,
  type ArtifactRef,
  type AskedQuestion,
  type Event,
  emitRunEvent,
  LimitWaitingEvent,
  type LinkArtifact,
  NOTIFIER_SUBSCRIBER,
  type NodeRun,
  type Notifier,
  QuestionAskedEvent,
  type Result,
  type State,
  type Subscriber,
  type SubscriberInput,
  WorkflowBlockedEvent,
} from "@yok/sdk";
import * as z from "zod";
import { isInsideDir } from "./workflow/done.ts";

export type Notice = Readonly<{
  title: string;
  body: string;
  // Mention the person; set for moments they must act on.
  mention: boolean;
  // artifact files, relative to the run folder, to upload into the thread
  files: readonly string[];
}>;

export interface INotifier {
  // posts into the thread when one is given, or starts one; resolves to the thread's id
  post(notice: Notice, threadId: string | undefined): Promise<string>;
  upload(file: string, threadId: string): Promise<void>;
}

const makeNotice = (title: string, extra: Partial<Omit<Notice, "title">> = {}): Notice => ({
  title,
  body: "",
  mention: false,
  files: [],
  ...extra,
});

const parsePayload = <T extends z.ZodType>(event: Event, schema: T): z.infer<T> | undefined =>
  schema.safeParse(event.payload).data;

const MessageSchema = z.looseObject({ message: z.string() });
const PlacementPayload = z.looseObject({ parents: z.array(z.string()).optional() });
const StartedPayload = z.looseObject({ notify: z.boolean().optional() });
const FailedCallPayload = z.looseObject({
  subscriber: z.string(),
  eventType: z.string(),
  status: z.literal("failed"),
  error: MessageSchema,
});

// Loops, switches and includes only hold other nodes, so they never post.
const CONTAINERS: ReadonlySet<NodeRun["nodeType"]> = new Set(["loop", "switch", "include"]);

type PlacedRun = Readonly<{ path: readonly string[]; run: NodeRun }>;

// Every node run in the tree, parents before children, each with the ids that lead to it.
const flattenRuns = (
  runs: Readonly<Record<string, NodeRun>>,
  parents: readonly string[] = [],
): readonly PlacedRun[] =>
  Object.entries(runs).flatMap(([id, run]) => [
    { path: [...parents, id], run },
    ...flattenRuns(run.nodes ?? {}, [...parents, id]),
  ]);

const runAt = (state: State, path: readonly string[]): NodeRun | undefined =>
  flattenRuns(state.nodeRuns).find((placed) => placed.path.join("/") === path.join("/"))?.run;

const eventPath = (event: Event): readonly string[] => [
  ...(parsePayload(event, PlacementPayload)?.parents ?? []),
  event.nodeId ?? "",
];

// "qa-loop › qa · round 2" inside a loop, else the node id. The loop is the closest one around
// the node; an include or a switch adds nothing.
const labelOf = (state: State, path: readonly string[]): string => {
  const id = path.at(-1) ?? "a node";
  const loops = path
    .slice(0, -1)
    .map((_, index) => ({ id: path[index] ?? "", run: runAt(state, path.slice(0, index + 1)) }))
    .filter(({ run }) => run?.nodeType === "loop");
  const loop = loops.at(-1);
  if (loop === undefined) return id;
  return `${loop.id} › ${id} · round ${loop.run?.iteration ?? 1}`;
};

// The leaf node the agent is working on, if any.
const openNodePath = (state: State): readonly string[] | undefined =>
  flattenRuns(state.nodeRuns).find(
    ({ run }) => run.status === "running" && !CONTAINERS.has(run.nodeType),
  )?.path;

const atOpenNode = (state: State): string => {
  const path = openNodePath(state);
  return path === undefined ? "" : ` at ${labelOf(state, path)}`;
};

const formatDuration = (state: State): string => {
  const end = state.completedAt === null ? Date.now() : Date.parse(state.completedAt);
  const minutes = Math.max(0, Math.round((end - Date.parse(state.startedAt)) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

const byCompletion = (a: PlacedRun, b: PlacedRun): number =>
  (a.run.completedAt ?? "").localeCompare(b.run.completedAt ?? "");

// The summary of the last node that posted to the thread: the run's result in one line.
const lastSummary = (state: State): readonly string[] => {
  const posted = flattenRuns(state.nodeRuns)
    .filter(({ run }) => run.notify === true && run.summary !== undefined)
    .toSorted(byCompletion);
  const summary = posted.at(-1)?.run.summary;
  return summary === undefined ? [] : [summary];
};

const formatLink = (link: LinkArtifact): string => `${link.name} · ${link.url}`;

const linksOf = (artifacts: readonly ArtifactRef[]): readonly LinkArtifact[] =>
  artifacts.flatMap((artifact) => ("url" in artifact ? [artifact] : []));

// Every link the run's nodes handed over; a type and name given twice shows its latest url.
const listLinks = (state: State): readonly string[] => {
  const links = flattenRuns(state.nodeRuns).flatMap(({ run }) => linksOf(run.artifacts));
  const latest = new Map(links.map((link) => [`${link.type}/${link.name}`, link]));
  return [...latest.values()].map(formatLink);
};

// The leaf that failed first: the failure that ended the run, not the cleanup after it.
const firstFailure = (state: State): PlacedRun | undefined =>
  flattenRuns(state.nodeRuns)
    .filter(({ run }) => run.status === "failed" && !CONTAINERS.has(run.nodeType))
    .toSorted(byCompletion)[0];

const firstLine = (text: string | undefined): readonly string[] => {
  const line = text?.split("\n")[0]?.trim();
  return line ? [line] : [];
};

// The notifier's own failures are not posted: posting them would fail the same way.
const describeSubscriberFailure = (event: Event): Notice | undefined => {
  const call = parsePayload(event, FailedCallPayload);
  if (call === undefined || call.subscriber === NOTIFIER_SUBSCRIBER) return undefined;
  return makeNotice(`Subscriber ${call.subscriber} failed on ${call.eventType}`, {
    body: call.error.message,
  });
};

const formatQuestion = (question: AskedQuestion): string =>
  [`*${question.question}*`, ...question.options.map((option) => `• ${option}`)].join("\n");

const describeQuestion = (event: Event, state: State): Notice => {
  const questions = parsePayload(event, QuestionAskedEvent.shape.payload)?.questions ?? [];
  return makeNotice(`❓ Waiting for you${atOpenNode(state)}`, {
    mention: true,
    body: [...questions.map(formatQuestion), "_Answer in the session._"].join("\n\n"),
  });
};

const describeNodeStart = (event: Event, state: State): Notice | undefined =>
  parsePayload(event, StartedPayload)?.notify === true
    ? makeNotice(`▶ ${labelOf(state, eventPath(event))} · started`)
    : undefined;

// A node's own words: the summary it ended with, its links, and its files to upload.
const describeNodeEnd = (event: Event, state: State): Notice | undefined => {
  const path = eventPath(event);
  const run = runAt(state, path);
  if (run?.notify !== true) return undefined;
  return makeNotice(`✓ ${labelOf(state, path)} · done`, {
    body: [
      ...(run.summary === undefined ? [] : [run.summary]),
      ...linksOf(run.artifacts).map(formatLink),
    ].join("\n"),
    files: run.artifacts.flatMap((artifact) => ("path" in artifact ? [artifact.path] : [])),
  });
};

const describeCompleted = (_: Event, state: State): Notice =>
  makeNotice(`✅ Run complete · ${formatDuration(state)}`, {
    mention: true,
    body: [...lastSummary(state), ...listLinks(state)].join("\n"),
  });

const describeFailed = (_: Event, state: State): Notice => {
  const failed = firstFailure(state);
  const where = failed === undefined ? "" : ` at ${labelOf(state, failed.path)}`;
  const error = MessageSchema.safeParse(failed?.run.output).data?.message;
  return makeNotice(`❌ Run failed${where} · ${formatDuration(state)}`, {
    mention: true,
    body: [...firstLine(error), ...listLinks(state)].join("\n"),
  });
};

type BuildNotice = (event: Event, state: State) => Notice | undefined;

// Every message the thread can hold. Node lines carry the node's own summary from state.json;
// the rest are fixed templates.
const NOTICE_BY_EVENT: Readonly<Record<string, BuildNotice>> = {
  "workflow.started": (_, state) => {
    const prompt = state.input.prompt;
    return makeNotice("Yok run started", {
      mention: true,
      body: typeof prompt === "string" ? prompt.slice(0, 500) : "",
    });
  },
  "workflow.node.started": describeNodeStart,
  "workflow.node.completed": describeNodeEnd,
  "agent.question.asked": describeQuestion,
  "workflow.completed": describeCompleted,
  "workflow.failed": describeFailed,
  "agent.stuck": (_, state) =>
    makeNotice(`⚠️ Agent stuck${atOpenNode(state)}`, {
      mention: true,
      body: "The agent stopped twice with the node still open. Open the session and tell it to go on.",
    }),
  "agent.stopped": (event, state) => {
    const stop = parsePayload(event, AgentStoppedEvent.shape.payload);
    return makeNotice(`⛔ Agent stopped${atOpenNode(state)} · ${stop?.error ?? "error"}`, {
      mention: true,
      body: [...firstLine(stop?.message), "Fix the cause, then resume the session."].join("\n"),
    });
  },
  // resumeAt is ISO 8601 UTC, so characters 11-16 are its HH:MM.
  "agent.limit.waiting": (event, state) => {
    const resumeAt = parsePayload(event, LimitWaitingEvent.shape.payload)?.resumeAt;
    const when = resumeAt === undefined ? "" : ` · resumes at ${resumeAt.slice(11, 16)} UTC`;
    return makeNotice(`⏸ Rate limit${atOpenNode(state)}${when}`, {
      mention: true,
      body: "The run goes on by itself. Nothing to do.",
    });
  },
  "agent.limit.resumed": (_, state) => {
    const path = openNodePath(state);
    const node = path === undefined ? "" : ` ${labelOf(state, path)}`;
    return makeNotice(`▶ Rate limit over · resuming${node}`);
  },
  "workflow.blocked": (event) => {
    const block = parsePayload(event, WorkflowBlockedEvent.shape.payload);
    if (block === undefined) return undefined;
    return makeNotice(`Run blocked · ${block.stage} needs ${block.missing.join(", ")}`, {
      mention: true,
    });
  },
  "subscriber.called": describeSubscriberFailure,
};

// The event types init freezes the notifier under.
export const NOTIFIER_EVENTS: readonly string[] = Object.keys(NOTICE_BY_EVENT);

// What the notifier posts for an event, or undefined when the event is not worth a message.
export const describeEvent = (event: Event, state: State): Notice | undefined =>
  NOTICE_BY_EVENT[event.type]?.(event, state);

// Slack reads <…> as a mention or a link, so text from a prompt or an agent could ping the
// channel or disguise a link.
const escapeSlack = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Outside the bold marker: Slack renders <@ID> as a name, and bold-wrapping it reads as shouting.
export const formatSlackText = (notice: Notice, memberId: string | undefined): string => {
  const title = `*${escapeSlack(notice.title)}*`;
  const heading = notice.mention && memberId ? `<@${memberId}> ${title}` : title;
  return notice.body === "" ? heading : `${heading}\n${escapeSlack(notice.body)}`;
};

const SLACK_API = "https://slack.com/api";

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type SlackConfig = Readonly<{
  token: string;
  channel: string;
  memberId: string | undefined;
  fetch: Fetch;
}>;

const SlackReplySchema = z.looseObject({ ok: z.boolean(), error: z.string().optional() });

const callSlack = async (
  config: SlackConfig,
  method: string,
  form: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, unknown>>> => {
  const res = await config.fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    },
    body: new URLSearchParams(form).toString(),
  });
  const reply = SlackReplySchema.safeParse(await res.json()).data;
  if (reply?.ok !== true) {
    throw new Error(`slack ${method} failed: ${reply?.error ?? String(res.status)}`);
  }
  return reply;
};

const toThreadParams = (threadId: string | undefined): Readonly<Record<string, string>> =>
  threadId === undefined ? {} : { thread_ts: threadId };

export const createSlackNotifier = (config: SlackConfig): INotifier => ({
  post: async (notice, threadId) => {
    const text = formatSlackText(notice, config.memberId);
    const res = await callSlack(config, "chat.postMessage", {
      channel: config.channel,
      text,
      ...toThreadParams(threadId),
    });
    if (threadId !== undefined) return threadId;
    if (typeof res.ts !== "string") throw new Error("slack chat.postMessage returned no ts");
    return res.ts;
  },
  upload: async (file, threadId) => {
    const bytes = await readFile(file);
    const name = basename(file);
    const ticket = await callSlack(config, "files.getUploadURLExternal", {
      filename: name,
      length: String(bytes.byteLength),
    });
    const uploadUrl = ticket.upload_url;
    const fileId = ticket.file_id;
    if (typeof uploadUrl !== "string" || typeof fileId !== "string") {
      throw new Error("slack files.getUploadURLExternal returned no upload url");
    }
    const put = await config.fetch(uploadUrl, { method: "POST", body: bytes });
    if (!put.ok) throw new Error(`slack file upload failed: ${put.status}`);
    await callSlack(config, "files.completeUploadExternal", {
      files: JSON.stringify([{ id: fileId, title: name }]),
      channel_id: config.channel,
      ...toThreadParams(threadId),
    });
  },
});

export const SLACK_REQUIRED_KEYS = ["SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID"] as const;

type Env = Readonly<Record<string, string | undefined>>;

export const findMissingNotifierKeys = (env: Env): readonly string[] =>
  SLACK_REQUIRED_KEYS.filter((key) => !env[key]);

// Secrets come from the run's env, which its agent session starts with and every subscriber process
// inherits. That env is built from .env and the config's and workflow's env and envFile, so keep a
// token in .env or an envFile, not inline in a committed file.
export const openNotifier = (type: Notifier["type"], env: Env = process.env): Result<INotifier> => {
  const { SLACK_BOT_TOKEN: token, SLACK_CHANNEL_ID: channel, SLACK_MEMBER_ID: memberId } = env;
  if (!token || !channel) {
    const missing = findMissingNotifierKeys(env).join(" and ");
    return { ok: false, error: `the ${type} notifier needs ${missing} in the run's env` };
  }
  return { ok: true, value: createSlackNotifier({ token, channel, memberId, fetch }) };
};

export type OpenNotifier = typeof openNotifier;

// What init freezes as the notifier subscriber's module: the CLI serves this file under that name, so
// it loads in a compiled binary, where this file has no path on disk.
export const NOTIFIER_MODULE = "yok:notifier";

// The files, as real paths, that still sit inside the run's artifacts/. Checked where each points
// now, not when done accepted it, so one swapped for a symlink to .env, say, is never sent.
const keepArtifactFiles = async (
  runDir: string,
  files: readonly string[],
): Promise<readonly string[]> => {
  if (files.length === 0) return [];
  const artifacts = await realpath(join(runDir, "artifacts"));
  const actual = await Promise.all(files.map((file) => realpath(join(runDir, file))));
  return actual.filter((path) => isInsideDir(artifacts, path));
};

// A file larger than this is named in the message instead of uploaded, so a 4 MB proof report
// does not land in the channel.
export const UPLOAD_LIMIT_BYTES = 1_000_000;

const splitBySize = async (
  files: readonly string[],
): Promise<Readonly<{ small: readonly string[]; large: readonly string[] }>> => {
  const sized = await Promise.all(
    files.map(async (file) => ({ file, size: (await stat(file)).size })),
  );
  return {
    small: sized.filter(({ size }) => size <= UPLOAD_LIMIT_BYTES).map(({ file }) => file),
    large: sized.filter(({ size }) => size > UPLOAD_LIMIT_BYTES).map(({ file }) => file),
  };
};

const withLargeFiles = (notice: Notice, large: readonly string[]): Notice => {
  if (large.length === 0) return notice;
  const lines = large.map(
    (file) => `${basename(file)} is too big to attach; open it in the run viewer.`,
  );
  return { ...notice, body: [notice.body, ...lines].filter((line) => line !== "").join("\n") };
};

// Posts the event's message into the run's thread and uploads its files. The first post opens the
// thread, recorded as notification.thread.started so later posts reply in it. A failure throws,
// so the SDK records a failed call.
export const notify = async (
  type: Notifier["type"],
  { event, state, run }: SubscriberInput,
  open: OpenNotifier,
  record: typeof emitRunEvent,
): Promise<{ threadId: string } | undefined> => {
  const described = describeEvent(event, state);
  if (described === undefined) return undefined;
  const opened = open(type);
  if (!opened.ok) throw new Error(opened.error);
  const files = await keepArtifactFiles(state.runDir, described.files);
  const { small, large } = await splitBySize(files);
  const notice = withLargeFiles(described, large);
  const known = state.notification?.threadId;
  const thread = typeof known === "string" ? known : undefined;
  const threadId = await opened.value.post(notice, thread);
  if (thread === undefined) {
    const stored = await record(run, {
      type: "notification.thread.started",
      source: "notifier",
      payload: { provider: type, threadId },
    });
    if (!stored.ok) throw new Error(`thread ${threadId} not recorded: ${stored.error}`);
  }
  for (const file of small) await opened.value.upload(file, threadId);
  return { threadId };
};

// The subscriber init freezes for `notifier: { type: slack }`.
export const slack: Subscriber = (input) => notify("slack", input, openNotifier, emitRunEvent);
