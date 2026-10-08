import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { EmitInput, Event, emitRunEvent, JsonValue, NodeRun, RunRef, State } from "@yok/sdk";
import {
  createSlackNotifier,
  describeEvent,
  findMissingNotifierKeys,
  formatSlackText,
  type INotifier,
  type Notice,
  notify,
  type OpenNotifier,
  openNotifier,
  UPLOAD_LIMIT_BYTES,
} from "./notifier.ts";

const state: State = {
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-demo",
  runName: "demo",
  runDir: "/work/.yok/demo",
  version: "2.0.0",
  workflow: { name: "task", path: "workflow.yaml" },
  input: { prompt: "fix it" },
  scope: null,
  startedAt: "2026-10-02T10:00:00Z",
  completedAt: null,
  status: "running",
  workspace: { type: "mono", path: "/work", repositories: {} },
  tiers: null,
  nodeRuns: {},
  activeSessions: [],
  eventHandlers: {},
  subscribers: {},
};

const nodeRun = (nodeRunId: string, extra: Partial<NodeRun> = {}): NodeRun => ({
  nodeRunId,
  nodeType: "agent",
  status: "completed",
  startedAt: "2026-10-02T10:00:00Z",
  completedAt: "2026-10-02T10:30:00Z",
  artifacts: [],
  notify: true,
  ...extra,
});

const PR = {
  type: "pull-request",
  name: "lydia",
  url: "https://github.com/refrens/lydia/pull/5442",
} as const;

// A run that took 2h 17m: design wrote a file, a loop ran qa twice, pr opened a PR.
const finished: State = {
  ...state,
  status: "completed",
  completedAt: "2026-10-02T12:17:00Z",
  nodeRuns: {
    "create-workspace": nodeRun("cw-1", { notify: false, summary: "Made the worktree." }),
    design: nodeRun("design-1", {
      summary: "Chose two buttons.",
      artifacts: [{ type: "design", name: "design", path: "artifacts/design.md" }],
    }),
    "qa-loop": nodeRun("loop-1", {
      nodeType: "loop",
      iteration: 2,
      notify: undefined,
      nodes: { qa: nodeRun("qa-2", { summary: "QA passed on round 2." }) },
    }),
    pr: nodeRun("pr-1", {
      completedAt: "2026-10-02T12:10:00Z",
      summary: "Opened a PR in lydia.",
      artifacts: [PR],
    }),
    retro: nodeRun("retro-1", { completedAt: "2026-10-02T12:16:00Z", notify: false }),
  },
};

const failedBuild: State = {
  ...state,
  status: "failed",
  completedAt: "2026-10-02T10:12:00Z",
  nodeRuns: {
    build: nodeRun("build-1", {
      nodeType: "exec",
      status: "failed",
      completedAt: "2026-10-02T10:01:00Z",
      output: { kind: "exit", message: "tsc exit 2\nsrc/a.ts(1,1): error" },
    }),
    retro: nodeRun("retro-1", {
      status: "failed",
      completedAt: "2026-10-02T10:11:00Z",
      output: { kind: "exception", message: "retro broke" },
    }),
  },
};

// design is the node the agent works on now.
const openDesign: State = {
  ...state,
  nodeRuns: { design: nodeRun("design-1", { status: "running", completedAt: null }) },
};

const openQa: State = {
  ...state,
  nodeRuns: {
    "qa-loop": nodeRun("loop-1", {
      nodeType: "loop",
      status: "running",
      iteration: 3,
      nodes: { qa: nodeRun("qa-3", { status: "running", completedAt: null }) },
    }),
  },
};

const event = (type: string, payload: JsonValue = {}, nodeId?: string): Event => ({
  schemaVersion: 1,
  seq: 1,
  id: "evt-1",
  ts: "2026-10-02T10:00:00Z",
  type,
  source: "test",
  runId: "r-demo",
  payload,
  ...(nodeId === undefined ? {} : { nodeId, nodeRunId: `${nodeId}-1` }),
});

const notice = (title: string, extra: Partial<Notice> = {}): Notice => ({
  title,
  body: "",
  mention: false,
  files: [],
  ...extra,
});

describe("describeEvent", () => {
  test.each([
    [
      "the run's start shows the prompt, not the run name",
      event("workflow.started"),
      state,
      notice("Yok run started", { mention: true, body: "fix it" }),
    ],
    [
      "a node that posts starts with one line",
      event("workflow.node.started", { nodeType: "agent", notify: true }, "design"),
      state,
      notice("▶ design · started"),
    ],
    [
      "a node inside a loop names the loop and its round",
      event(
        "workflow.node.started",
        { nodeType: "agent", notify: true, parents: ["qa-loop"] },
        "qa",
      ),
      openQa,
      notice("▶ qa-loop › qa · round 3 · started"),
    ],
    [
      "a node ends with its summary, its links and its files",
      event("workflow.node.completed", { nodeType: "agent", attempts: 1 }, "design"),
      finished,
      notice("✓ design · done", { body: "Chose two buttons.", files: ["artifacts/design.md"] }),
    ],
    [
      "a link artifact shows as name and url",
      event("workflow.node.completed", { nodeType: "agent", attempts: 1 }, "pr"),
      finished,
      notice("✓ pr · done", {
        body: "Opened a PR in lydia.\nlydia · https://github.com/refrens/lydia/pull/5442",
      }),
    ],
    [
      "a question names the open node and where to answer",
      event("agent.question.asked", {
        agent: "claude",
        sessionId: "s-1",
        toolUseId: "toolu_1",
        questions: [{ question: "Ship it?", options: ["Yes", "No"] }],
      }),
      openDesign,
      notice("❓ Waiting for you at design", {
        mention: true,
        body: "*Ship it?*\n• Yes\n• No\n\n_Answer in the session._",
      }),
    ],
    [
      "the run's end shows the duration, the last summary and every link",
      event("workflow.completed"),
      finished,
      notice("✅ Run complete · 2h 17m", {
        mention: true,
        body: "Opened a PR in lydia.\nlydia · https://github.com/refrens/lydia/pull/5442",
      }),
    ],
    [
      "a failed run names the first failed node and the first line of its error",
      event("workflow.failed"),
      failedBuild,
      notice("❌ Run failed at build · 12m", { mention: true, body: "tsc exit 2" }),
    ],
    [
      "a stuck agent names the open node and what to do",
      event("agent.stuck", { agent: "claude", sessionId: "s-1" }),
      openDesign,
      notice("⚠️ Agent stuck at design", {
        mention: true,
        body: "The agent stopped twice with the node still open. Open the session and tell it to go on.",
      }),
    ],
    [
      "an API stop names the node, the error and what to do",
      event("agent.stopped", {
        agent: "claude",
        sessionId: "s-1",
        error: "billing_error",
        message: "Credit balance too low",
      }),
      openDesign,
      notice("⛔ Agent stopped at design · billing_error", {
        mention: true,
        body: "Credit balance too low\nFix the cause, then resume the session.",
      }),
    ],
    [
      "a rate limit pings, with the node and when it resumes",
      event("agent.limit.waiting", {
        sessionId: "s-1",
        limitEventId: "e-1",
        resumeAt: "2026-10-02T15:00:00.000Z",
        from: "message",
      }),
      openQa,
      notice("⏸ Rate limit at qa-loop › qa · round 3 · resumes at 15:00 UTC", {
        mention: true,
        body: "The run goes on by itself. Nothing to do.",
      }),
    ],
    [
      "the end of a rate limit says which node resumes",
      event("agent.limit.resumed"),
      openDesign,
      notice("▶ Rate limit over · resuming design"),
    ],
    [
      "a blocked run names the stage and what it needs",
      event("workflow.blocked", { nodeId: "plan", stage: "planning", missing: ["design"] }),
      state,
      notice("Run blocked · planning needs design", { mention: true }),
    ],
    [
      "a failed subscriber names itself and the event",
      event("subscriber.called", {
        subscriber: "asana",
        eventType: "workflow.started",
        status: "failed",
        error: { kind: "threw", message: "401" },
      }),
      state,
      notice("Subscriber asana failed on workflow.started", { body: "401" }),
    ],
  ])("%s", (_label, stored, at, expected) => {
    expect(describeEvent(stored, at)).toEqual(expected);
  });

  test.each([
    [
      "a quiet node's start",
      event("workflow.node.started", { nodeType: "agent", notify: false }, "baseline"),
      state,
    ],
    [
      "a loop's start, which only holds other nodes",
      event("workflow.node.started", { nodeType: "loop" }, "qa-loop"),
      state,
    ],
    [
      "a quiet node's end",
      event("workflow.node.completed", { nodeType: "agent", attempts: 1 }, "create-workspace"),
      finished,
    ],
    [
      "a loop's end",
      event("workflow.node.completed", { nodeType: "loop", attempts: 1 }, "qa-loop"),
      finished,
    ],
    [
      "a skipped node",
      event("workflow.node.skipped", { nodeType: "agent", attempts: 0, skip: {} }, "qa"),
      state,
    ],
    [
      "an answer",
      event("agent.question.answered", {
        agent: "claude",
        sessionId: "s-1",
        answers: [{ question: "Ship it?", answer: "Yes" }],
      }),
      state,
    ],
    ["a loop's next round", event("workflow.node.iterated", { iteration: 2 }, "qa-loop"), state],
    [
      "a subscriber call that went fine",
      event("subscriber.called", {
        subscriber: "asana",
        eventType: "workflow.started",
        status: "ok",
      }),
      state,
    ],
    [
      "a failed call of the notifier itself",
      event("subscriber.called", {
        subscriber: "notifier",
        eventType: "workflow.started",
        status: "failed",
        error: { kind: "threw", message: "no token" },
      }),
      state,
    ],
  ])("%s posts nothing", (_label, stored, at) => {
    expect(describeEvent(stored, at)).toBeUndefined();
  });
});

const titled = (extra: Partial<Notice> = {}): Notice => ({
  title: "Title",
  body: "",
  mention: false,
  files: [],
  ...extra,
});

describe("formatSlackText", () => {
  test.each([
    ["a mention with member U1", titled({ mention: true }), "U1", "<@U1> *Title*"],
    ["a mention without a member", titled({ mention: true }), undefined, "*Title*"],
    ["no mention with member U1", titled(), "U1", "*Title*"],
    ["a body", titled({ body: "fix it" }), undefined, "*Title*\nfix it"],
  ])(
    "SC205: %s puts the member's mention only where the notice asks for it",
    (_label, given, memberId, expected) => {
      expect(formatSlackText(given, memberId)).toBe(expected);
    },
  );

  test("a title and body holding <!channel>, a disguised link and & are escaped, and the member's mention is kept", () => {
    const notice = titled({
      title: "Waiting <!channel>",
      body: "Ping <!channel> & see <https://x|y>",
      mention: true,
    });

    expect(formatSlackText(notice, "U1")).toBe(
      "<@U1> *Waiting &lt;!channel&gt;*\nPing &lt;!channel&gt; &amp; see &lt;https://x|y&gt;",
    );
  });
});

type Sent = Readonly<{ url: string; body: RequestInit["body"] }>;

// Answers each Slack method with the reply given for it, and records every request.
const fakeSlack = (replies: Readonly<Record<string, object>>) => {
  const sent: Sent[] = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({ url, body: init.body });
    const method = url.split("/").pop() ?? "";
    return Response.json(replies[method] ?? { ok: true });
  };
  const notifier = createSlackNotifier({
    token: "xoxb-test",
    channel: "C1",
    memberId: undefined,
    fetch,
  });
  return { sent, notifier };
};

const formOf = (request: Sent | undefined): Readonly<Record<string, string>> =>
  Object.fromEntries(new URLSearchParams(String(request?.body ?? "")));

describe("createSlackNotifier", () => {
  test("SC206: a post with no thread sends chat.postMessage without thread_ts and resolves to the reply's ts", async () => {
    const slack = fakeSlack({ "chat.postMessage": { ok: true, ts: "171.1" } });

    const threadId = await slack.notifier.post(titled(), undefined);

    expect(threadId).toBe("171.1");
    expect(slack.sent[0]?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(formOf(slack.sent[0])).toEqual({ channel: "C1", text: "*Title*" });
  });

  test("SC206: a post into thread 171.1 sends thread_ts=171.1 and resolves to 171.1", async () => {
    const slack = fakeSlack({ "chat.postMessage": { ok: true, ts: "172.2" } });

    const threadId = await slack.notifier.post(titled(), "171.1");

    expect(threadId).toBe("171.1");
    expect(formOf(slack.sent[0])).toEqual({ channel: "C1", text: "*Title*", thread_ts: "171.1" });
  });

  test("SC206: a reply of ok false rejects with Slack's error", async () => {
    const slack = fakeSlack({ "chat.postMessage": { ok: false, error: "channel_not_found" } });

    await expect(slack.notifier.post(titled(), undefined)).rejects.toThrow(
      "slack chat.postMessage failed: channel_not_found",
    );
  });

  test("SC206: an upload asks for a URL, posts the bytes to it, then completes into thread 171.1", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "notifier-")), "design.md");
    await writeFile(file, "# Design");
    const slack = fakeSlack({
      "files.getUploadURLExternal": {
        ok: true,
        upload_url: "https://files.test/up",
        file_id: "F1",
      },
    });

    await slack.notifier.upload(file, "171.1");

    expect(slack.sent.map((request) => request.url)).toEqual([
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.test/up",
      "https://slack.com/api/files.completeUploadExternal",
    ]);
    expect(formOf(slack.sent[0])).toEqual({ filename: "design.md", length: "8" });
    expect(await new Response(slack.sent[1]?.body).text()).toBe("# Design");
    expect(formOf(slack.sent[2])).toEqual({
      files: JSON.stringify([{ id: "F1", title: "design.md" }]),
      channel_id: "C1",
      thread_ts: "171.1",
    });
  });
});

describe("the notifier's Slack variables", () => {
  test("SC207: an env holding only SLACK_CHANNEL_ID fails to open the notifier, naming SLACK_BOT_TOKEN", () => {
    const env = { SLACK_CHANNEL_ID: "C1" };

    const opened = openNotifier("slack", env);

    expect(opened.ok ? "" : opened.error).toContain("SLACK_BOT_TOKEN");
    expect(opened.ok ? "" : opened.error).not.toContain("SLACK_CHANNEL_ID");
    expect(findMissingNotifierKeys(env)).toEqual(["SLACK_BOT_TOKEN"]);
  });

  test("an env holding SLACK_BOT_TOKEN and SLACK_CHANNEL_ID opens the notifier with nothing missing", () => {
    const env = { SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL_ID: "C1" };

    expect(openNotifier("slack", env).ok).toBe(true);
    expect(findMissingNotifierKeys(env)).toEqual([]);
  });
});

// An opener whose notifier records what it was asked to do and starts thread 171.1.
const fakeOpener = () => {
  const opened: string[] = [];
  const posts: (string | undefined)[] = [];
  const notices: Notice[] = [];
  const uploads: (readonly [string, string])[] = [];
  const notifier: INotifier = {
    post: async (posted, threadId) => {
      posts.push(threadId);
      notices.push(posted);
      return threadId ?? "171.1";
    },
    upload: async (file, threadId) => {
      uploads.push([file, threadId]);
    },
  };
  const open: OpenNotifier = (type) => {
    opened.push(type);
    return { ok: true, value: notifier };
  };
  return { calls: { opened, posts, notices, uploads }, open };
};

const inThread171: State = { ...state, notification: { provider: "slack", threadId: "171.1" } };

const run: RunRef = { id: "r-demo", cwd: "/work", name: "demo" };

// Collects the events notify stores instead of writing a run folder.
const fakeRecorder = () => {
  const recorded: EmitInput[] = [];
  const record: typeof emitRunEvent = async (_run, input) => {
    recorded.push(input);
    return { ok: true, value: event(input.type, input.payload) };
  };
  return { recorded, record };
};

describe("notify", () => {
  test("SC210: the first post opens thread 171.1 and records it; the next post replies in it and records nothing", async () => {
    const { calls, open } = fakeOpener();
    const { recorded, record } = fakeRecorder();

    const first = await notify(
      "slack",
      { event: event("workflow.started"), state, run },
      open,
      record,
    );
    const second = await notify(
      "slack",
      {
        event: event("workflow.node.started", { nodeType: "agent", notify: true }, "design"),
        state: inThread171,
        run,
      },
      open,
      record,
    );

    expect(first).toEqual({ threadId: "171.1" });
    expect(second).toEqual({ threadId: "171.1" });
    expect(calls.posts).toEqual([undefined, "171.1"]);
    expect(calls.opened).toEqual(["slack", "slack"]);
    expect(recorded).toEqual([
      {
        type: "notification.thread.started",
        source: "notifier",
        payload: { provider: "slack", threadId: "171.1" },
      },
    ]);
  });

  // A run folder holding artifacts/design.md, artifacts/big.html over the upload limit, and
  // artifacts/env.md linking to the checkout's .env; design ended listing PATHS.
  const runFolder = async (...paths: readonly string[]) => {
    const checkout = await realpath(await mkdtemp(join(tmpdir(), "notifier-run-")));
    const runDir = join(checkout, ".yok", "demo");
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    await writeFile(join(runDir, "artifacts", "design.md"), "# design\n");
    await writeFile(join(runDir, "artifacts", "big.html"), "x".repeat(UPLOAD_LIMIT_BYTES + 1));
    await writeFile(join(checkout, ".env"), "SLACK_BOT_TOKEN=xoxb-secret\n");
    await symlink(join(checkout, ".env"), join(runDir, "artifacts", "env.md"));
    const artifacts = paths.map((path) => ({
      type: basename(path).split(".")[0] ?? "x",
      name: path,
      path,
    }));
    const nodeRuns = { design: nodeRun("design-1", { summary: "Chose two buttons.", artifacts }) };
    return { state: { ...inThread171, runDir, nodeRuns }, run: { ...run, cwd: checkout } };
  };

  const designDone = event("workflow.node.completed", { nodeType: "agent", attempts: 1 }, "design");

  test("SC212: a completed node's artifact is uploaded from the run folder into thread 171.1", async () => {
    const { calls, open } = fakeOpener();
    const inRun = await runFolder("artifacts/design.md");

    await notify("slack", { event: designDone, ...inRun }, open, fakeRecorder().record);

    expect(calls.posts).toEqual(["171.1"]);
    expect(calls.uploads).toEqual([[join(inRun.state.runDir, "artifacts", "design.md"), "171.1"]]);
  });

  test("an artifact that is now a symlink to the checkout's .env is not uploaded", async () => {
    const { calls, open } = fakeOpener();
    const inRun = await runFolder("artifacts/env.md", "artifacts/design.md");

    await notify("slack", { event: designDone, ...inRun }, open, fakeRecorder().record);

    expect(calls.uploads).toEqual([[join(inRun.state.runDir, "artifacts", "design.md"), "171.1"]]);
  });

  test("a file over the upload limit is named in the message instead of uploaded", async () => {
    const { calls, open } = fakeOpener();
    const inRun = await runFolder("artifacts/big.html", "artifacts/design.md");

    await notify("slack", { event: designDone, ...inRun }, open, fakeRecorder().record);

    expect(calls.notices.map((posted) => posted.body)).toEqual([
      "Chose two buttons.\nbig.html is too big to attach; open it in the run viewer.",
    ]);
    expect(calls.uploads).toEqual([[join(inRun.state.runDir, "artifacts", "design.md"), "171.1"]]);
  });

  test("SC217: an orchestrate.next with a stage reply returns nothing and never opens the notifier", async () => {
    const { calls, open } = fakeOpener();
    const next = event("orchestrate.next", {
      input: {},
      output: { kind: "stage", nodeId: "plan" },
    });

    const result = await notify("slack", { event: next, state, run }, open, fakeRecorder().record);

    expect(result).toBeUndefined();
    expect(calls.opened).toEqual([]);
  });
});
