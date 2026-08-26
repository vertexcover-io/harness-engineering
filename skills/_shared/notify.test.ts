import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  formatMessage,
  loadConfig,
  main,
  parseArgs,
  resolveProvider,
  type Args,
  type Config,
  type Message,
} from "./notify.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

const scratch = (): string => mkdtempSync(join(tmpdir(), "notify-test-"));

const gitRepo = (): string => {
  const dir = scratch();
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

const configured = (enabled = true): string => {
  const dir = gitRepo();
  writeFileSync(
    join(dir, "orchestrate.config.json"),
    JSON.stringify({ notifier: { enabled, provider: "slack" } }),
  );
  return dir;
};

const withEnv = async (key: string, value: string | null, fn: () => Promise<void> | void): Promise<void> => {
  const prev = process.env[key];
  if (value === null) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};

const args = (over: Partial<Args> = {}): Args => ({
  event: "stage-completed",
  stage: "coder",
  title: null,
  body: null,
  thread: null,
  artifacts: [],
  ...over,
});

const cfg = (secrets: Record<string, string>, provider = "slack"): Config => ({ provider, secrets });

// ── parseArgs ────────────────────────────────────────────────────────────────

test("parseArgs reads every flag and accumulates --artifact", () => {
  const parsed = parseArgs([
    "--event", "stage-completed",
    "--stage", "planning",
    "--title", "my-spec",
    "--body", "B",
    "--thread", "1.5",
    "--artifact", "a.html",
    "--artifact", "b.md",
  ]);
  assert.equal(parsed.event, "stage-completed");
  assert.equal(parsed.stage, "planning");
  assert.equal(parsed.title, "my-spec");
  assert.equal(parsed.body, "B");
  assert.equal(parsed.thread, "1.5");
  assert.deepEqual(parsed.artifacts, ["a.html", "b.md"]);
});

test("parseArgs defaults every optional flag", () => {
  const parsed = parseArgs(["--event", "run-started"]);
  assert.equal(parsed.stage, null);
  assert.equal(parsed.title, null);
  assert.equal(parsed.body, null);
  assert.equal(parsed.thread, null);
  assert.deepEqual(parsed.artifacts, []);
});

test("parseArgs rejects a missing --event", () => {
  assert.throws(() => parseArgs(["--stage", "coder"]), /--event is required/);
});

test("parseArgs rejects an unknown event", () => {
  assert.throws(() => parseArgs(["--event", "stage-exploded"]), /Unknown --event "stage-exploded"/);
});

test("parseArgs rejects an unknown flag", () => {
  assert.throws(() => parseArgs(["--event", "run-started", "--channel", "x"]), /Unknown flag "--channel"/);
});

test("parseArgs rejects a flag with no value", () => {
  assert.throws(() => parseArgs(["--event"]), /Flag "--event" is missing its value/);
});

// ── loadConfig ───────────────────────────────────────────────────────────────

test("loadConfig finds the config at the repo root from a nested directory", () => {
  const dir = configured();
  const nested = join(dir, "a", "b");
  mkdirSync(nested, { recursive: true });
  assert.equal(loadConfig(nested)!.provider, "slack");
});

test("loadConfig throws outside a git repository", () => {
  assert.throws(() => loadConfig(scratch()), /Not a git repository/);
});

test("loadConfig throws when the config file is missing", () => {
  assert.throws(() => loadConfig(gitRepo()), /orchestrate.config.json not found at .*Run setup-harness/s);
});

test("loadConfig treats an absent notifier block as disabled", () => {
  const dir = gitRepo();
  writeFileSync(join(dir, "orchestrate.config.json"), JSON.stringify({ commands: {} }));
  assert.equal(loadConfig(dir), null);
});

test("loadConfig returns null when the notifier is disabled", () => {
  assert.equal(loadConfig(configured(false)), null);
});

test("loadConfig prefers a shell export over .env", async () => {
  const dir = configured();
  writeFileSync(join(dir, ".env"), "SLACK_BOT_TOKEN=from-dotenv\n");
  await withEnv("SLACK_BOT_TOKEN", "from-shell", () => {
    assert.equal(loadConfig(dir)!.secrets["SLACK_BOT_TOKEN"], "from-shell");
  });
});

test("loadConfig reads .env at the main checkout, from inside a worktree", async () => {
  const repo = configured();
  writeFileSync(join(repo, "f.txt"), "x");
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  writeFileSync(join(repo, ".env"), '# a comment\n\nexport SLACK_CHANNEL_ID = "C123"\nMALFORMED\n');
  const wt = join(scratch(), "wt");
  execFileSync("git", ["worktree", "add", "-q", "-b", "feat/x", wt], { cwd: repo });

  await withEnv("SLACK_CHANNEL_ID", null, () => {
    assert.equal(loadConfig(wt)!.secrets["SLACK_CHANNEL_ID"], "C123");
  });
});

test("loadConfig leaves a key absent when it is nowhere", async () => {
  const dir = configured();
  await withEnv("SLACK_BOT_TOKEN", null, () => {
    assert.equal(loadConfig(dir)!.secrets["SLACK_BOT_TOKEN"], undefined);
  });
});

// ── resolveProvider ──────────────────────────────────────────────────────────

test("resolveProvider names the supported providers on an unknown name", () => {
  assert.throws(
    () => resolveProvider(cfg({ SLACK_BOT_TOKEN: "x" }, "teams")),
    /Unknown notifier provider "teams". Supported: slack./,
  );
});

test("resolveProvider names the missing token", () => {
  assert.throws(() => resolveProvider(cfg({ SLACK_CHANNEL_ID: "C1" })), /needs SLACK_BOT_TOKEN/);
});

test("resolveProvider names a missing channel id", () => {
  assert.throws(() => resolveProvider(cfg({ SLACK_BOT_TOKEN: "x" })), /needs SLACK_CHANNEL_ID/);
});

test("resolveProvider names a missing member id", () => {
  assert.throws(
    () => resolveProvider(cfg({ SLACK_BOT_TOKEN: "x", SLACK_CHANNEL_ID: "C1" })),
    /needs SLACK_MEMBER_ID/,
  );
});

// ── formatMessage ────────────────────────────────────────────────────────────

test("every event derives its title from the flags alone", () => {
  const titles = (["run-started", "stage-started", "stage-completed", "question-pending", "run-interrupted", "run-completed"] as const)
    .map((event) => formatMessage(args({ event, stage: "coder", title: "my-spec" })).title);
  assert.deepEqual(titles, [
    "Harness run started: my-spec",
    "Stage coder · started",
    "Stage coder · done",
    "Waiting for you · stage coder",
    "Run interrupted · stage coder",
    "Run complete: my-spec",
  ]);
});

test("the body is exactly what --body carries", () => {
  assert.equal(formatMessage(args({ body: "4 phases green" })).body, "4 phases green");
  assert.equal(formatMessage(args({ body: null })).body, "");
});

test("only the events a person must answer for carry a mention", () => {
  const mentioned = (["run-started", "stage-started", "stage-completed", "question-pending", "run-interrupted", "run-completed"] as const)
    .map((event) => formatMessage(args({ event })).mention);
  assert.deepEqual(mentioned, [true, false, false, true, true, true]);
});

test("--thread becomes the message's thread ref", () => {
  assert.equal(formatMessage(args({ thread: "1.5" })).threadRef, "1.5");
  assert.equal(formatMessage(args()).threadRef, null);
});

test("missing --stage and --title fall back to placeholders", () => {
  assert.equal(formatMessage(args({ event: "stage-started", stage: null })).title, "Stage unknown · started");
  assert.equal(formatMessage(args({ event: "run-completed", title: null })).title, "Run complete: harness");
});

// ── Slack provider ───────────────────────────────────────────────────────────

type Call = { readonly url: string; readonly body: string };

const withFetch = async (
  responses: readonly unknown[],
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> => {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (async (url: string, init: { body?: unknown }) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    const payload = responses[i++];
    return { ok: true, status: 200, json: async () => payload };
  }) as unknown as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
};

const slack = () =>
  resolveProvider(cfg({ SLACK_BOT_TOKEN: "xoxb-test", SLACK_CHANNEL_ID: "C0TEST", SLACK_MEMBER_ID: "U0TEST" }));

const message = (over: Partial<Message> = {}): Message => ({
  title: "T",
  body: "B",
  threadRef: null,
  mention: false,
  ...over,
});

test("slack send posts to chat.postMessage and returns the ts", () =>
  withFetch([{ ok: true, ts: "1756112531.000300" }], async (calls) => {
    const ts = await slack().send(message());
    assert.equal(ts, "1756112531.000300");
    assert.match(calls[0]!.url, /chat\.postMessage$/);
    assert.match(calls[0]!.body, /channel=C0TEST/);
    assert.doesNotMatch(calls[0]!.body, /thread_ts/);
  }));

const text = (call: Call): string => new URLSearchParams(call.body).get("text") ?? "";

test("slack tags the member ahead of the title when the message mentions", () =>
  withFetch([{ ok: true, ts: "1" }], async (calls) => {
    await slack().send(message({ mention: true }));
    assert.equal(text(calls[0]!), "<@U0TEST> *T*\nB");
  }));

test("slack leaves the title alone when the message does not mention", () =>
  withFetch([{ ok: true, ts: "1" }], async (calls) => {
    await slack().send(message());
    assert.equal(text(calls[0]!), "*T*\nB");
  }));

test("slack send threads under an existing ref", () =>
  withFetch([{ ok: true, ts: "2" }], async (calls) => {
    await slack().send(message({ threadRef: "1756112531.000300" }));
    assert.match(calls[0]!.body, /thread_ts=1756112531\.000300/);
  }));

test("slack surfaces the error string when ok is false", () =>
  withFetch([{ ok: false, error: "channel_not_found" }], async () => {
    await assert.rejects(
      () => slack().send(message()),
      /slack chat.postMessage failed: channel_not_found/,
    );
  }));

test("slack upload runs the three-call sequence and threads the file", async () => {
  const file = join(scratch(), "plan.html");
  writeFileSync(file, "<h1>plan</h1>");

  await withFetch(
    [{ ok: true, upload_url: "https://files.slack.com/upload/abc", file_id: "F1" }, null, { ok: true }],
    async (calls) => {
      await slack().upload(file, message({ threadRef: "1.5" }));
      assert.equal(calls.length, 3);
      assert.match(calls[0]!.url, /files\.getUploadURLExternal$/);
      assert.match(calls[0]!.body, /filename=plan\.html/);
      assert.match(calls[0]!.body, /length=13/);
      assert.equal(calls[1]!.url, "https://files.slack.com/upload/abc");
      assert.match(calls[2]!.url, /files\.completeUploadExternal$/);
      assert.match(calls[2]!.body, /thread_ts=1\.5/);
      assert.match(calls[2]!.body, /F1/);
    },
  );
});

// ── main ─────────────────────────────────────────────────────────────────────

type Recorded = { sent: Message[]; uploaded: string[] };

const fakeProvider = (rec: Recorded, ts: string | null = "1756112531.000300") => ({
  send: async (msg: Message) => { rec.sent.push(msg); return ts; },
  upload: async (file: string) => { rec.uploaded.push(file); },
});

test("main says so and sends nothing when the notifier is disabled", async () => {
  const rec: Recorded = { sent: [], uploaded: [] };
  const written: string[] = [];
  const real = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => { written.push(s); return true; }) as typeof process.stderr.write;
  try {
    assert.equal(await main(["--event", "run-started"], fakeProvider(rec), configured(false)), 0);
  } finally {
    process.stderr.write = real;
  }
  assert.deepEqual(rec.sent, []);
  assert.match(written.join(""), /notifications are disabled/);
});

test("main surfaces a missing config file", async () => {
  const rec: Recorded = { sent: [], uploaded: [] };
  await assert.rejects(
    () => main(["--event", "run-started"], fakeProvider(rec), gitRepo()),
    /orchestrate.config.json not found/,
  );
});

test("main sends one message built from the flags", async () => {
  const rec: Recorded = { sent: [], uploaded: [] };
  await main(
    ["--event", "stage-completed", "--stage", "planning", "--body", "4 phases", "--thread", "1.5"],
    fakeProvider(rec),
    configured(),
  );
  assert.equal(rec.sent.length, 1);
  assert.equal(rec.sent[0]!.title, "Stage planning · done");
  assert.equal(rec.sent[0]!.body, "4 phases");
  assert.equal(rec.sent[0]!.threadRef, "1.5");
});

test("main uploads every artifact into the same thread", async () => {
  const rec: Recorded = { sent: [], uploaded: [] };
  await main(
    ["--event", "stage-completed", "--stage", "planning", "--thread", "1.5", "--artifact", "plan.html", "--artifact", "notes.md"],
    fakeProvider(rec),
    configured(),
  );
  assert.deepEqual(rec.uploaded, ["plan.html", "notes.md"]);
});

test("main writes nothing to disk", async () => {
  const rec: Recorded = { sent: [], uploaded: [] };
  const dir = configured();
  await main(["--event", "run-started", "--title", "my-spec"], fakeProvider(rec), dir);
  assert.deepEqual(execFileSync("ls", [dir], { encoding: "utf8" }).trim(), "orchestrate.config.json");
});
