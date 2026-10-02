import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommentDraft, CommentDraftSchema } from "@harness/sdk/internal";
import {
  addComments,
  addUserReply,
  type Comment,
  commentsPath,
  deliveryMessage,
  isOpen,
  markDelivered,
  readComments,
  replyToComment,
} from "./comments.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const runDir = (): string => realpathSync(mkdtempSync(join(tmpdir(), "harness-comments-")));

const anchor = { quote: "After saving a batch", before: "b", after: "a" };
const comment = (text: string): CommentDraft => ({
  file: "artifacts/design.md",
  kind: "comment",
  text,
  anchor: { ...anchor, lines: [14, 16], heading: "Approach" },
});
const global = (text: string): CommentDraft => ({
  file: "artifacts/review.md",
  kind: "global",
  text,
});

describe("deliveryMessage", () => {
  test("SC16: each comment is one block in batch order, long quotes are cut, and the reply command closes it", () => {
    const long = "x".repeat(100);
    const base = { status: "sent", createdAt: NOW.toISOString() } as const;
    const user = (text: string) => ({ by: "user" as const, text, at: NOW.toISOString() });
    const comments: readonly Comment[] = [
      { ...base, ...comment("Why one file per run?"), id: "c4", thread: [user("Why?")] },
      {
        ...base,
        id: "c5",
        file: "artifacts/design.md",
        kind: "delete",
        text: "",
        anchor: { quote: "retry 3 times", before: "", after: "", lines: [30, 30] },
        thread: [user("Delete this.")],
      },
      {
        ...base,
        id: "c7",
        file: "artifacts/design.md",
        kind: "replace",
        text: "twice",
        anchor: { quote: long, before: "", after: "" },
        thread: [user("Replace")],
      },
      { ...base, ...global("Ship it after finding 2."), id: "c6", thread: [user("Ship")] },
      {
        ...base,
        ...comment("old"),
        id: "c3",
        thread: [
          user("old"),
          { by: "agent", text: "done", at: NOW.toISOString() },
          user("Can we bundle it later?"),
        ],
      },
    ];

    expect(deliveryMessage(comments, "feat-x").split("\n")).toEqual([
      "[review] 5 new comments from the viewer:",
      'c4 · artifacts/design.md:14-16 (Approach) on "After saving a batch"',
      "  Why one file per run?",
      'c5 · artifacts/design.md:30 · delete "retry 3 times"',
      `c7 · artifacts/design.md · replace "${"x".repeat(80)}…" with "twice"`,
      "c6 · artifacts/review.md · whole file",
      "  Ship it after finding 2.",
      "c3 · reply on its thread: Can we bundle it later?",
      "Reply to each: bun run orchestrate comments reply --run feat-x --id ID --status answered|changed|declined --text -",
    ]);
  });
});

describe("deliveryMessage follow-ups", () => {
  test("a follow-up on a comment the agent never saw goes out with the comment, not instead of it", () => {
    const at = NOW.toISOString();
    const notYetDelivered: Comment = {
      ...comment("Why one file per run?"),
      id: "c1",
      status: "sent",
      createdAt: at,
      thread: [
        { by: "user", text: "Why one file per run?", at },
        { by: "user", text: "and not one per artifact?", at },
      ],
    };
    expect(deliveryMessage([notYetDelivered], "feat-x").split("\n").slice(1, 4)).toEqual([
      'c1 · artifacts/design.md:14-16 (Approach) on "After saving a batch"',
      "  Why one file per run?",
      "  then: and not one per artifact?",
    ]);
    const delivered = { ...notYetDelivered, deliveredAt: at };
    expect(deliveryMessage([delivered], "feat-x").split("\n")[1]).toBe(
      "c1 · reply on its thread: and not one per artifact?",
    );
  });
});

describe("comment store", () => {
  test("SC17: a batch reads back, and replies move its status", async () => {
    const dir = runDir();
    const added = await addComments(dir, [comment("one"), global("two")], NOW);
    expect(added.ok && added.value.map((c) => [c.id, c.status, c.thread.length])).toEqual([
      ["c1", "sent", 1],
      ["c2", "sent", 1],
    ]);
    const read = await readComments(dir);
    expect(read.ok && read.value.comments).toEqual(added.ok ? [...added.value] : []);

    await replyToComment(dir, "c1", { status: "changed", text: "fixed" }, NOW);
    await addUserReply(dir, "c2", "and also", NOW);
    const after = await readComments(dir);
    const [c1, c2] = after.ok ? after.value.comments : [];
    expect([c1?.status, c1?.thread.at(-1)?.by]).toEqual(["changed", "agent"]);
    expect([c2?.status, c2?.thread.map((t) => t.by)]).toEqual(["sent", ["user", "user"]]);

    const before = readFileSync(commentsPath(dir), "utf8");
    const missing = await replyToComment(dir, "c9", { status: "answered", text: "x" }, NOW);
    expect(!missing.ok && missing.error).toBe("no comment c9");
    expect(readFileSync(commentsPath(dir), "utf8")).toBe(before);
  });

  test("SC17b: marking delivered stamps only the comments still sent", async () => {
    const dir = runDir();
    await addComments(dir, [comment("one"), comment("two")], NOW);
    await replyToComment(dir, "c2", { status: "answered", text: "ok" }, NOW);
    const typed = await readComments(dir);
    await markDelivered(dir, typed.ok ? typed.value.comments : [], NOW);
    const read = await readComments(dir);
    const [c1, c2] = read.ok ? read.value.comments : [];
    expect([c1?.status, c1?.deliveredAt, c2?.status, c2?.deliveredAt]).toEqual([
      "delivered",
      NOW.toISOString(),
      "answered",
      undefined,
    ]);
  });

  test("a reply posted while a batch was being typed keeps the comment sent", async () => {
    const dir = runDir();
    await addComments(dir, [comment("one"), comment("two")], NOW);
    const typed = await readComments(dir);
    await addUserReply(dir, "c2", "one more thing", NOW);
    await markDelivered(dir, typed.ok ? typed.value.comments : [], NOW);
    const read = await readComments(dir);
    expect(read.ok && read.value.comments.map((c) => c.status)).toEqual(["delivered", "sent"]);
  });

  test("an empty agent reply is refused and leaves the file unchanged", async () => {
    const dir = runDir();
    await addComments(dir, [comment("one")], NOW);
    const before = readFileSync(commentsPath(dir), "utf8");
    const replied = await replyToComment(dir, "c1", { status: "answered", text: "  " }, NOW);
    expect(!replied.ok && replied.error).toBe("the reply has no text");
    expect(readFileSync(commentsPath(dir), "utf8")).toBe(before);
  });

  test("SC18: a comments file that does not parse is reported and never overwritten", async () => {
    const dir = runDir();
    writeFileSync(commentsPath(dir), "{ not json");
    const read = await readComments(dir);
    expect(!read.ok && read.error).toContain(commentsPath(dir));
    const results = [
      await addComments(dir, [comment("x")], NOW),
      await replyToComment(dir, "c1", { status: "answered", text: "x" }, NOW),
      await addUserReply(dir, "c1", "x", NOW),
      await markDelivered(dir, [], NOW),
    ];
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(readFileSync(commentsPath(dir), "utf8")).toBe("{ not json");
  });

  test("SC19: twenty batches added at once all keep their comments with unique ids", async () => {
    const dir = runDir();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        addComments(dir, [comment(`a${i}`), global(`b${i}`)], NOW),
      ),
    );
    const read = await readComments(dir);
    const ids = read.ok ? read.value.comments.map((c) => c.id) : [];
    expect(ids).toHaveLength(40);
    expect(new Set(ids)).toEqual(new Set(Array.from({ length: 40 }, (_, i) => `c${i + 1}`)));
  });
});

describe("CommentDraftSchema", () => {
  test("SC20: a part-of-file comment needs an anchor and words, a global one keeps a stray anchor", () => {
    const noAnchor = CommentDraftSchema.safeParse({
      file: "artifacts/a.md",
      kind: "comment",
      text: "x",
    });
    const noText = CommentDraftSchema.safeParse({
      file: "artifacts/a.md",
      kind: "replace",
      text: "",
      anchor,
    });
    const globalWithAnchor = CommentDraftSchema.safeParse({ ...global("x"), anchor });
    expect([noAnchor.success, noText.success, globalWithAnchor.success]).toEqual([
      false,
      false,
      true,
    ]);
    expect(globalWithAnchor.data?.anchor).toEqual(anchor);
  });
});

describe("isOpen", () => {
  test("a comment stays open until the agent answers it", () => {
    const at = NOW.toISOString();
    const withStatus = (status: Comment["status"]): Comment => ({
      ...global("x"),
      id: "c1",
      status,
      createdAt: at,
      thread: [{ by: "user", text: "x", at }],
    });
    const open = (["sent", "delivered", "answered", "changed", "declined"] as const).filter((s) =>
      isOpen(withStatus(s)),
    );
    expect(open).toEqual(["sent", "delivered"]);
  });
});

describe("addComments first words", () => {
  test("a delete or replace comment opens its thread with what the user asked for", async () => {
    const dir = runDir();
    const place = { ...anchor, lines: [3, 3] as [number, number] };
    const added = await addComments(
      dir,
      [
        { file: "artifacts/a.md", kind: "delete", text: "", anchor: place },
        { file: "artifacts/a.md", kind: "delete", text: "It is stale.", anchor: place },
        { file: "artifacts/a.md", kind: "replace", text: "twice", anchor: place },
      ],
      NOW,
    );
    expect(added.ok && added.value.map((c) => c.thread[0]?.text)).toEqual([
      "Delete this.",
      "Delete this. It is stale.",
      "Replace with “twice”",
    ]);
  });
});
