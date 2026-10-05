import { readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  AgentStoppedEvent,
  AgentStuckEvent,
  type AskedQuestion,
  type Event,
  emitRunEvent,
  type HookInput,
  NOTIFIER_HOOK,
  type Notifier,
  QuestionAnsweredEvent,
  QuestionAskedEvent,
  type Result,
  type RunHook,
  type State,
  WorkflowBlockedEvent,
} from "@yok/sdk";
import * as z from "zod";
import { isInsideDir } from "./workflow/done.ts";

export type Notice = Readonly<{
  title: string;
  body: string;
  // address it to the person: the moments they must act on
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
const FailedPayload = z.looseObject({ error: MessageSchema });
const CompletedPayload = z.looseObject({
  artifacts: z.array(z.looseObject({ path: z.string() })),
});
const SkippedPayload = z.looseObject({ skip: z.looseObject({ reason: z.string() }) });
const WaitingPayload = z.looseObject({ resumeAt: z.string() });
const FailedCallPayload = z.looseObject({
  hook: z.string(),
  eventType: z.string(),
  status: z.literal("failed"),
  error: MessageSchema,
});

const readNodeId = (event: Event): string => event.nodeId ?? "a node";

const listFailedNodes = (state: State): string =>
  Object.entries(state.nodeRuns)
    .filter(([, run]) => run.status === "failed")
    .map(([id, run]) => `${id}: ${MessageSchema.safeParse(run.output).data?.message ?? "failed"}`)
    .join("\n");

// The notifier's own failures are not posted: posting them would fail the same way.
const describeHookFailure = (event: Event): Notice | undefined => {
  const call = parsePayload(event, FailedCallPayload);
  if (call === undefined || call.hook === NOTIFIER_HOOK) return undefined;
  return makeNotice(`Hook ${call.hook} failed on ${call.eventType}`, { body: call.error.message });
};

const formatQuestion = (question: AskedQuestion): string =>
  [`*${question.question}*`, ...question.options.map((option) => `• ${option}`)].join("\n");

const describeQuestion = (event: Event, state: State): Notice => {
  const questions = parsePayload(event, QuestionAskedEvent.shape.payload)?.questions ?? [];
  return makeNotice(`Waiting for you · ${state.runName}`, {
    mention: true,
    body: questions.map(formatQuestion).join("\n\n"),
  });
};

const describeAnswer = (event: Event): Notice => {
  const answers = parsePayload(event, QuestionAnsweredEvent.shape.payload)?.answers ?? [];
  return makeNotice("Answered", {
    body: answers
      .map(({ question, answer, notes }) =>
        [`*${question}*`, `→ ${answer}`, ...(notes === undefined ? [] : [`_note: ${notes}_`])].join(
          "\n",
        ),
      )
      .join("\n\n"),
  });
};

type BuildNotice = (event: Event, state: State) => Notice | undefined;

const NOTICE_BY_EVENT: Readonly<Record<string, BuildNotice>> = {
  "workflow.started": (_, state) => {
    const prompt = state.input.prompt;
    return makeNotice(`Yok run started: ${state.runName}`, {
      mention: true,
      body: typeof prompt === "string" ? prompt.slice(0, 500) : "",
    });
  },
  "workflow.completed": (_, state) =>
    makeNotice(`Run complete: ${state.runName}`, { mention: true }),
  "workflow.failed": (_, state) =>
    makeNotice(`Run failed: ${state.runName}`, { mention: true, body: listFailedNodes(state) }),
  "workflow.node.started": (event) => makeNotice(`Node ${readNodeId(event)} · started`),
  "workflow.node.completed": (event) =>
    makeNotice(`Node ${readNodeId(event)} · done`, {
      files:
        parsePayload(event, CompletedPayload)?.artifacts.map((artifact) => artifact.path) ?? [],
    }),
  "workflow.node.failed": (event) =>
    makeNotice(`Node ${readNodeId(event)} · failed`, {
      mention: true,
      body: parsePayload(event, FailedPayload)?.error.message ?? "",
    }),
  "workflow.node.skipped": (event) =>
    makeNotice(`Node ${readNodeId(event)} · skipped`, {
      body: parsePayload(event, SkippedPayload)?.skip.reason ?? "",
    }),
  // resumeAt is ISO 8601 UTC, so characters 11-16 are its HH:MM.
  "agent.limit.waiting": (event) => {
    const wait = parsePayload(event, WaitingPayload);
    if (wait === undefined) return makeNotice("Rate limit · waiting");
    return makeNotice(`Rate limit · waiting until ${wait.resumeAt.slice(11, 16)} UTC`);
  },
  "agent.limit.resumed": () => makeNotice("Rate limit over · resuming"),
  "agent.question.asked": describeQuestion,
  "agent.question.answered": describeAnswer,
  "agent.stopped": (event) => {
    const stop = parsePayload(event, AgentStoppedEvent.shape.payload);
    return makeNotice(`Agent stopped · ${stop?.error ?? "error"}`, {
      mention: true,
      body: stop?.message ?? "",
    });
  },
  "agent.stuck": (event) =>
    makeNotice("Agent stuck · the Stop hook gave up", {
      mention: true,
      body: parsePayload(event, AgentStuckEvent.shape.payload)?.message ?? "",
    }),
  "workflow.blocked": (event) => {
    const block = parsePayload(event, WorkflowBlockedEvent.shape.payload);
    if (block === undefined) return undefined;
    return makeNotice(`Run blocked · ${block.stage} needs ${block.missing.join(", ")}`, {
      mention: true,
    });
  },
  "hooks.hook.called": describeHookFailure,
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

// Secrets come from the run's env, which its agent session starts with and every hook process
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

// This file, which init freezes as the notifier hook's module.
export const NOTIFIER_MODULE = import.meta.path;

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

// Posts the event's message into the run's thread and uploads its files. The first post opens the
// thread, recorded as notification.thread.started so later posts reply in it. A failure throws,
// so the SDK records a failed call.
export const notify = async (
  type: Notifier["type"],
  { event, state, run }: HookInput,
  open: OpenNotifier,
  record: typeof emitRunEvent,
): Promise<{ threadId: string } | undefined> => {
  const notice = describeEvent(event, state);
  if (notice === undefined) return undefined;
  const opened = open(type);
  if (!opened.ok) throw new Error(opened.error);
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
  for (const file of await keepArtifactFiles(state.runDir, notice.files)) {
    await opened.value.upload(file, threadId);
  }
  return { threadId };
};

// The hook init freezes for `notifier: { type: slack }`.
export const slack: RunHook = (input) => notify("slack", input, openNotifier, emitRunEvent);
