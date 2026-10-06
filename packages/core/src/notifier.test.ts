import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { EmitInput, Event, emitRunEvent, JsonValue, RunRef, State } from "@harness/sdk";
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
} from "./notifier.ts";

const state: State = {
  schemaVersion: 1,
  lastEventSeq: 0,
  runId: "r-demo",
  runName: "demo",
  runDir: "/work/.harness/demo",
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
  hooks: {},
};

const failedBuild: State = {
  ...state,
  nodeRuns: {
    build: {
      nodeRunId: "build-1",
      nodeType: "exec",
      status: "failed",
      startedAt: "2026-10-02T10:00:00Z",
      completedAt: "2026-10-02T10:01:00Z",
      artifacts: [],
      output: { kind: "exit", message: "tsc exit 2" },
    },
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

describe("describeEvent", () => {
  test.each([
    [
      "workflow.started",
      event("workflow.started"),
      state,
      { title: "Harness run started: demo", mention: true, body: "fix it", files: [] },
    ],
    [
      "workflow.completed",
      event("workflow.completed"),
      state,
      { title: "Run complete: demo", mention: true, body: "", files: [] },
    ],
    [
      "workflow.failed",
      event("workflow.failed"),
      failedBuild,
      { title: "Run failed: demo", mention: true, body: "build: tsc exit 2", files: [] },
    ],
    [
      "workflow.node.started",
      event("workflow.node.started", { nodeType: "agent" }, "design"),
      state,
      { title: "Node design · started", mention: false, body: "", files: [] },
    ],
    [
      "workflow.node.completed",
      event(
        "workflow.node.completed",
        {
          nodeType: "agent",
          attempts: 1,
          artifacts: [{ name: "design", path: "artifacts/design.md" }],
        },
        "design",
      ),
      state,
      { title: "Node design · done", mention: false, body: "", files: ["artifacts/design.md"] },
    ],
    [
      "workflow.node.failed",
      event(
        "workflow.node.failed",
        { nodeType: "exec", attempts: 1, error: { kind: "exit", message: "tsc exit 2" } },
        "build",
      ),
      state,
      { title: "Node build · failed", mention: true, body: "tsc exit 2", files: [] },
    ],
    [
      "workflow.node.skipped",
      event(
        "workflow.node.skipped",
        { nodeType: "agent", attempts: 0, skip: { reason: "no UI change" } },
        "qa",
      ),
      state,
      { title: "Node qa · skipped", mention: false, body: "no UI change", files: [] },
    ],
    [
      "agent.limit.waiting",
      event("agent.limit.waiting", { resumeAt: "2026-10-02T15:00:00Z" }),
      state,
      { title: "Rate limit · waiting until 15:00 UTC", mention: false, body: "", files: [] },
    ],
    [
      "agent.limit.resumed",
      event("agent.limit.resumed"),
      state,
      { title: "Rate limit over · resuming", mention: false, body: "", files: [] },
    ],
    [
      "agent.stuck",
      event("agent.stuck", { agent: "claude", sessionId: "s-1", message: "finish the node" }),
      state,
      {
        title: "Agent stuck · the Stop hook gave up",
        mention: true,
        body: "finish the node",
        files: [],
      },
    ],
    [
      "workflow.blocked",
      event("workflow.blocked", { nodeId: "plan", stage: "planning", missing: ["design"] }),
      state,
      { title: "Run blocked · planning needs design", mention: true, body: "", files: [] },
    ],
    [
      "hooks.hook.called",
      event("hooks.hook.called", {
        hook: "asana",
        eventType: "workflow.started",
        status: "failed",
        error: { kind: "threw", message: "401" },
      }),
      state,
      { title: "Hook asana failed on workflow.started", mention: false, body: "401", files: [] },
    ],
  ])("SC203: %s maps to its title, mention and body", (_type, stored, at, expected) => {
    expect(describeEvent(stored, at)).toEqual(expected);
  });

  const asker = { agent: "claude", sessionId: "s-1", toolUseId: "toolu_1" };
  test.each([
    [
      "agent.question.asked",
      event("agent.question.asked", {
        ...asker,
        questions: [{ question: "Ship it?", options: ["Yes", "No"] }],
      }),
      {
        title: "Waiting for you · demo",
        mention: true,
        body: "*Ship it?*\n• Yes\n• No",
        files: [],
      },
    ],
    [
      "agent.question.answered",
      event("agent.question.answered", {
        ...asker,
        answers: [{ question: "Ship it?", answer: "Yes" }],
      }),
      { title: "Answered", mention: false, body: "*Ship it?*\n→ Yes", files: [] },
    ],
    [
      "agent.question.answered with notes",
      event("agent.question.answered", {
        ...asker,
        answers: [{ question: "Ship it?", answer: "Yes", notes: "after the demo" }],
      }),
      {
        title: "Answered",
        mention: false,
        body: "*Ship it?*\n→ Yes\n_note: after the demo_",
        files: [],
      },
    ],
    [
      "agent.stopped",
      event("agent.stopped", {
        agent: "claude",
        sessionId: "s-1",
        error: "billing_error",
        message: "Credit balance too low",
      }),
      {
        title: "Agent stopped · billing_error",
        mention: true,
        body: "Credit balance too low",
        files: [],
      },
    ],
  ])("SC302: %s maps to its title, mention and body", (_type, stored, expected) => {
    expect(describeEvent(stored, state)).toEqual(expected);
  });

  test.each([
    [
      "orchestrate.next with a blocked reply, which workflow.blocked reports",
      event("orchestrate.next", {
        input: {},
        output: { kind: "blocked", nodeId: "plan", stage: "planning", missing: ["design"] },
      }),
    ],
    [
      "hooks.stop.called with reason max-blocks-reached, which agent.stuck reports",
      event("hooks.stop.called", { reason: "max-blocks-reached" }),
    ],
    [
      "hooks.hook.called with status ok",
      event("hooks.hook.called", { hook: "asana", eventType: "workflow.started", status: "ok" }),
    ],
    [
      "hooks.hook.called failed for the notifier itself",
      event("hooks.hook.called", {
        hook: "notifier",
        eventType: "workflow.started",
        status: "failed",
        error: { kind: "threw", message: "no token" },
      }),
    ],
    ["workflow.node.iterated", event("workflow.node.iterated", { iteration: 2 }, "loop")],
  ])("SC204: %s produces no notice", (_label, stored) => {
    expect(describeEvent(stored, state)).toBeUndefined();
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
  const uploads: (readonly [string, string])[] = [];
  const notifier: INotifier = {
    post: async (_notice, threadId) => {
      posts.push(threadId);
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
  return { calls: { opened, posts, uploads }, open };
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
        event: event("workflow.node.started", { nodeType: "agent" }, "design"),
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

  // A run folder holding artifacts/design.md, and artifacts/env.md linking to the checkout's .env.
  const runFolder = async () => {
    const checkout = await realpath(await mkdtemp(join(tmpdir(), "notifier-run-")));
    const runDir = join(checkout, ".harness", "demo");
    await mkdir(join(runDir, "artifacts"), { recursive: true });
    await writeFile(join(runDir, "artifacts", "design.md"), "# design\n");
    await writeFile(join(checkout, ".env"), "SLACK_BOT_TOKEN=xoxb-secret\n");
    await symlink(join(checkout, ".env"), join(runDir, "artifacts", "env.md"));
    return { state: { ...inThread171, runDir }, run: { ...run, cwd: checkout } };
  };

  const completedWith = (...paths: readonly string[]) =>
    event(
      "workflow.node.completed",
      {
        nodeType: "agent",
        attempts: 1,
        artifacts: paths.map((path) => ({ name: basename(path, ".md"), path })),
      },
      "design",
    );

  test("SC212: a completed node's artifact is uploaded from the run folder into thread 171.1", async () => {
    const { calls, open } = fakeOpener();
    const inRun = await runFolder();

    await notify(
      "slack",
      { event: completedWith("artifacts/design.md"), ...inRun },
      open,
      fakeRecorder().record,
    );

    expect(calls.posts).toEqual(["171.1"]);
    expect(calls.uploads).toEqual([[join(inRun.state.runDir, "artifacts", "design.md"), "171.1"]]);
  });

  test("an artifact that is now a symlink to the checkout's .env is not uploaded", async () => {
    const { calls, open } = fakeOpener();
    const inRun = await runFolder();
    const completed = completedWith("artifacts/env.md", "artifacts/design.md");

    await notify("slack", { event: completed, ...inRun }, open, fakeRecorder().record);

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
