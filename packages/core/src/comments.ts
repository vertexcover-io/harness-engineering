import { randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type EmitInput, type JsonValue, type Result, readIfExists, withLock } from "@yok/sdk";
import {
  type AgentStatusSchema,
  type CommentDraft,
  CommentFieldsSchema,
  CommentStatusSchema,
  runLockPath,
} from "@yok/sdk/internal";
import * as z from "zod";

const CommentSchema = CommentFieldsSchema.extend({
  id: z.string().min(1),
  status: CommentStatusSchema,
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().optional(),
  thread: z.array(
    z.strictObject({ by: z.enum(["user", "agent"]), text: z.string(), at: z.iso.datetime() }),
  ),
});
export type Comment = z.infer<typeof CommentSchema>;

const CommentsFileSchema = z.strictObject({
  version: z.literal(1),
  comments: z.array(CommentSchema),
});
type CommentsFile = z.infer<typeof CommentsFileSchema>;

type AgentReply = Readonly<{ status: z.infer<typeof AgentStatusSchema>; text: string }>;

export const isOpen = (comment: Comment): boolean =>
  comment.status === "sent" || comment.status === "delivered";

export const commentsPath = (runDir: string): string => join(runDir, "comments.json");

export const readComments = async (runDir: string): Promise<Result<CommentsFile>> => {
  const path = commentsPath(runDir);
  try {
    const text = await readIfExists(path);
    if (text === null) return { ok: true, value: { version: 1, comments: [] } };
    const parsed = CommentsFileSchema.safeParse(JSON.parse(text));
    return parsed.success
      ? { ok: true, value: parsed.data }
      : unreadable(path, parsed.error.message);
  } catch (error) {
    return unreadable(path, error instanceof Error ? error.message : String(error));
  }
};

const unreadable = (path: string, reason: string): Result<never> => ({
  ok: false,
  error: `comments.json at ${path} is unreadable: ${reason}`,
});

type Change<T> = Readonly<{ comments: readonly Comment[]; value: T }>;

// The server and the orchestrate script both write this file, so each change re-reads it inside
// the lock; an unreadable file fails the change rather than starting over from empty.
const mutate = <T>(
  runDir: string,
  change: (comments: readonly Comment[]) => Result<Change<T>>,
): Promise<Result<T>> =>
  withLock(runLockPath(runDir, "comments"), async () => {
    const read = await readComments(runDir);
    if (!read.ok) return read;
    const changed = change(read.value.comments);
    if (!changed.ok) return changed;
    const path = commentsPath(runDir);
    const temp = `${path}.tmp-${randomUUID()}`;
    const file: CommentsFile = { version: 1, comments: [...changed.value.comments] };
    await writeFile(temp, `${JSON.stringify(file, null, 2)}\n`);
    await rename(temp, path);
    return { ok: true, value: changed.value.value };
  });

const userWords = (draft: CommentDraft): string => {
  if (draft.kind === "delete")
    return `Delete this.${draft.text.trim() === "" ? "" : ` ${draft.text}`}`;
  if (draft.kind === "replace") return `Replace with “${draft.text}”`;
  return draft.text;
};

const nextIndex = (comments: readonly Comment[]): number =>
  Math.max(0, ...comments.map((c) => Number.parseInt(c.id.slice(1), 10) || 0)) + 1;

export const addComments = (
  runDir: string,
  drafts: readonly CommentDraft[],
  now: Date,
): Promise<Result<readonly Comment[]>> =>
  mutate(runDir, (comments) => {
    const at = now.toISOString();
    const first = nextIndex(comments);
    const added = drafts.map(
      (draft, i): Comment => ({
        ...draft,
        id: `c${first + i}`,
        status: "sent",
        createdAt: at,
        thread: [{ by: "user", text: userWords(draft), at }],
      }),
    );
    return { ok: true, value: { comments: [...comments, ...added], value: added } };
  });

const updateOne = (
  runDir: string,
  id: string,
  update: (comment: Comment) => Comment,
): Promise<Result<Comment>> =>
  mutate(runDir, (comments) => {
    const found = comments.find((c) => c.id === id);
    if (found === undefined) return { ok: false, error: `no comment ${id}` };
    const updated = update(found);
    return {
      ok: true,
      value: { comments: comments.map((c) => (c.id === id ? updated : c)), value: updated },
    };
  });

export const addUserReply = (
  runDir: string,
  id: string,
  text: string,
  now: Date,
): Promise<Result<Comment>> =>
  updateOne(runDir, id, (c) => ({
    ...c,
    status: "sent",
    thread: [...c.thread, { by: "user", text, at: now.toISOString() }],
  }));

export const replyToComment = async (
  runDir: string,
  id: string,
  reply: AgentReply,
  now: Date,
): Promise<Result<Comment>> => {
  if (reply.text.trim() === "") return { ok: false, error: "the reply has no text" };
  return updateOne(runDir, id, (c) => ({
    ...c,
    status: reply.status,
    thread: [...c.thread, { by: "agent", text: reply.text, at: now.toISOString() }],
  }));
};

// `typed` is the comments as they were when typed into the session. One that gained a thread
// entry since (a user reply posted mid-delivery) stays sent, so its new words go out next time.
export const markDelivered = (
  runDir: string,
  typed: readonly Comment[],
  now: Date,
): Promise<Result<void>> =>
  mutate(runDir, (comments) => ({
    ok: true,
    value: {
      comments: comments.map((c) =>
        c.status === "sent" &&
        typed.some((t) => t.id === c.id && t.thread.length === c.thread.length)
          ? { ...c, status: "delivered", deliveredAt: now.toISOString() }
          : c,
      ),
      value: undefined,
    },
  }));

const QUOTE_LIMIT = 80;
const cut = (quote: string): string =>
  quote.length > QUOTE_LIMIT ? `${quote.slice(0, QUOTE_LIMIT)}…` : quote;

const placeOf = (c: Comment): string => {
  const [from, to] = c.anchor?.lines ?? [];
  const lines = from === undefined ? "" : `:${from === to ? from : `${from}-${to}`}`;
  return `${c.id} · ${c.file}${lines}`;
};

// The user's words the agent has not answered: everything after its last reply, or after the
// first entry (the comment itself) when it has not replied yet.
const unansweredWords = (c: Comment): readonly string[] => {
  const lastAgent = c.thread.findLastIndex((entry) => entry.by === "agent");
  return c.thread.slice(Math.max(lastAgent, 0) + 1).map((entry) => entry.text);
};

const blockOf = (c: Comment): string => {
  const words = unansweredWords(c);
  const seenBefore = c.deliveredAt !== undefined || c.thread.some((e) => e.by === "agent");
  if (seenBefore && words.length > 0) return `${c.id} · reply on its thread: ${words.join(" / ")}`;
  return firstBlock(c) + words.map((text) => `\n  then: ${text}`).join("");
};

const firstBlock = (c: Comment): string => {
  const quote = cut(c.anchor?.quote ?? "");
  const words = `\n  ${c.text}`;
  if (c.kind === "global") return `${c.id} · ${c.file} · whole file${words}`;
  if (c.kind === "delete") {
    return `${placeOf(c)} · delete "${quote}"${c.text.trim() === "" ? "" : words}`;
  }
  if (c.kind === "replace") return `${placeOf(c)} · replace "${quote}" with "${c.text}"`;
  const heading = c.anchor?.heading === undefined ? "" : ` (${c.anchor.heading})`;
  return `${placeOf(c)}${heading} on "${quote}"${words}`;
};

export const deliveryMessage = (comments: readonly Comment[], runName: string): string =>
  [
    `[review] ${comments.length} new comment${comments.length === 1 ? "" : "s"} from the viewer:`,
    ...comments.map(blockOf),
    `Reply to each: bun run orchestrate comments reply --run ${runName} --id ID --status answered|changed|declined --text -`,
  ].join("\n");

// JSON.stringify drops the optional fields a comment leaves undefined, which a payload may not hold.
const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));

export const commentsAddedEvent = (comments: readonly Comment[]): EmitInput => ({
  type: "artifact.comment.added",
  source: "viewer",
  payload: toJson({
    comments: comments.map(({ id, file, kind, text, anchor }) => ({
      id,
      file,
      kind,
      text,
      anchor,
    })),
  }),
});

export const commentRepliedEvent = (
  source: "viewer" | "orchestrate",
  comment: Comment,
): EmitInput => {
  const { id, file, anchor, status, thread } = comment;
  const reply = thread.at(-1);
  return {
    type: "artifact.comment.replied",
    source,
    payload: toJson({ id, by: reply?.by, status, text: reply?.text, file, anchor }),
  };
};
