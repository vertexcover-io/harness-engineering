import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  buildEvent,
  eventsDir,
  logEvent,
  parseTranscript,
  resolveEvidence,
  skillVersion,
  usableSessionId,
  validate,
} from "./log-event.mjs";

const valid = {
  trigger: "auto",
  why_triggered: "User said caught errors in jobs must go to Sentry",
  proposed_learning: "Report caught errors in background jobs to Sentry",
  outcome: "new",
  status: "accepted",
  options_shown: ["rethrow", "structured logger", "Sentry"],
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "learn-log-event-")));
after(() => rmSync(root, { recursive: true, force: true }));
const tempDir = (prefix) => mkdtempSync(join(root, prefix));

const line = (record) => JSON.stringify(record);
const transcript = [
  line({ type: "user", uuid: "u1", message: { role: "user", content: "add retry to the email job" } }),
  line({ type: "assistant", uuid: "a1", message: { content: [{ type: "thinking", thinking: "I'll use console.error" }] } }),
  line({ type: "assistant", uuid: "a2", message: { content: [{ type: "text", text: "I'll wrap it in try/catch with   console.error." }] } }),
  line({ type: "assistant", uuid: "a3", message: { content: [{ type: "tool_use", name: "Edit", input: { new_string: "console.error(err)" } }] } }),
  line({ type: "user", uuid: "r1", message: { content: [{ type: "tool_result", content: "console.error(err) applied" }] } }),
  line({ type: "user", uuid: "u2", message: { content: "No, I told you, errors go to Sentry. And fix log-event.mjs too." } }),
  line({ type: "user", uuid: "m1", isMeta: true, message: { content: "errors go to Sentry (skill text)" } }),
  line({ type: "assistant", uuid: "a4", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "node log-event.mjs <<EOF errors go to Sentry" } }] } }),
  "not json",
].join("\n");

// A session whose transcript is the one above, in a config dir of its own, and a fresh repo folder.
const session = (id, raw = transcript) => {
  const config = tempDir("learn-config-");
  mkdirSync(join(config, "projects", "-some-repo"), { recursive: true });
  writeFileSync(join(config, "projects", "-some-repo", `${id}.jsonl`), raw);
  return { env: { CLAUDE_CONFIG_DIR: config }, cwd: tempDir("learn-cwd-") };
};
const noTranscript = () => ({ env: { CLAUDE_CONFIG_DIR: "/nowhere" }, cwd: tempDir("learn-cwd-") });
const eventsFile = (cwd, id) => join(cwd, ".harness", "learning-events", `${id}.jsonl`);
const readEvents = (file) => readFileSync(file, "utf8").trim().split("\n").map((entry) => JSON.parse(entry));

test("accepts a complete event", () => {
  assert.deepEqual(validate(valid), []);
});

test("accepts a new learning that replaces an old one, and rejects the old replaced outcome", () => {
  assert.deepEqual(validate({ ...valid, replaces: "docs/learnings/use-npm.md" }), []);
  assert.deepEqual(validate({ ...valid, outcome: "replaced" }), ["outcome must be one of new, occurrence, lint, rejected"]);
  assert.deepEqual(validate({ ...valid, replaces: 1 }), ["replaces must be text"]);
});

test("final_learning goes with status edited and nothing else", () => {
  assert.deepEqual(validate({ ...valid, status: "edited", final_learning: "A1" }), []);
  assert.deepEqual(validate({ ...valid, status: "edited" }), ["final_learning is required when status is edited"]);
  assert.deepEqual(validate({ ...valid, status: "accepted", final_learning: "A1" }), ["final_learning is only for status edited"]);
});

test("reports every missing required field", () => {
  assert.deepEqual(validate({}), [
    "trigger is required",
    "why_triggered is required",
    "proposed_learning is required",
    "outcome is required",
    "status is required",
  ]);
});

test("rejects values outside the enums, wrong types, unknown fields and non-objects", () => {
  assert.deepEqual(validate({ ...valid, outcome: "maybe", status: "sure", options_shown: "a", evidence_from: 1, evidence_form: "x" }), [
    "evidence_form is not a known field",
    "evidence_from must be text",
    "options_shown must be a list",
    "outcome must be one of new, occurrence, lint, rejected",
  ]);
  assert.deepEqual(validate(null), ["the event must be a JSON object"]);
  assert.deepEqual(validate([]), ["the event must be a JSON object"]);
});

test("each outcome allows only its own statuses", () => {
  assert.deepEqual(validate({ ...valid, outcome: "new", status: "existing" }), ["status for outcome new must be one of accepted, edited"]);
  assert.deepEqual(validate({ ...valid, outcome: "lint", status: "rejected" }), []);
});

test("only what the user said and the agent wrote or ran is searchable, minus calls to this script", () => {
  assert.deepEqual(parseTranscript(transcript).map((message) => message.uuid), ["u1", "a2", "a3", "u2"]);
});

test("finds the messages that start and end the exchange, ignoring case and spacing", () => {
  const { ids, missing } = resolveEvidence(parseTranscript(transcript), "wrap it in try/catch with console.error", "ERRORS GO TO SENTRY");
  assert.deepEqual(ids, { evidence_from_message: "a2", evidence_to_message: "u2" });
  assert.deepEqual(missing, []);
});

test("a message that names this script can still be evidence", () => {
  const { ids } = resolveEvidence(parseTranscript(transcript), "", "fix log-event.mjs too");
  assert.equal(ids.evidence_to_message, "u2");
});

test("the start is the last mistake before the first correction, so an earlier mention cannot stretch it", () => {
  const messages = [
    { uuid: "early", text: "ran npm install for setup" },
    { uuid: "mistake", text: "running npm install" },
    { uuid: "fix", byUser: true, text: "use pnpm here" },
    { uuid: "again", text: "npm install once more" },
  ];
  assert.deepEqual(resolveEvidence(messages, "npm install", "use pnpm").ids, { evidence_from_message: "mistake", evidence_to_message: "fix" });
});

test("a correction that quotes the agent's words is not taken for the mistake", () => {
  const messages = [
    { uuid: "mistake", byUser: false, text: "i'll wrap it: catch (e) { console.log(e) }" },
    { uuid: "fix", byUser: true, text: "you wrote catch (e) { console.log(e) }, nobody reads those logs. send it to sentry" },
  ];
  assert.deepEqual(resolveEvidence(messages, "catch (e) { console.log(e) }", "send it to sentry").ids, {
    evidence_from_message: "mistake",
    evidence_to_message: "fix",
  });
});

test("the end of the exchange is only ever something the user said", () => {
  const messages = [
    { uuid: "agent", byUser: false, text: "i will use pnpm here from now on" },
    { uuid: "user", byUser: true, text: "yes, use pnpm here" },
  ];
  assert.equal(resolveEvidence(messages, "", "use pnpm here").ids.evidence_to_message, "user");
});

test("snippets that were given but not found, or a start only after the end, are reported missing", () => {
  const messages = parseTranscript(transcript);
  assert.deepEqual(resolveEvidence(messages, "never said", "errors go to Sentry").missing, ["evidence_from was not found in your own messages or tool calls before evidence_to (it must be your words or code, never the user's)"]);
  assert.deepEqual(resolveEvidence(messages, "errors go to Sentry", "add retry").missing, ["evidence_from was not found in your own messages or tool calls before evidence_to (it must be your words or code, never the user's)"]);
  assert.deepEqual(resolveEvidence(messages, "", "  ").missing, []);
  assert.deepEqual(resolveEvidence(messages, "", "never said").missing, ["evidence_to was not found"]);
});

test("fills id, timestamp, cwd and version, and swaps the snippets for message ids", () => {
  const event = buildEvent({ ...valid, evidence_from: "x", evidence_to: "y" }, "abc", {
    now: new Date("2026-10-06T10:00:00Z"),
    cwd: "/r",
    evidence: { evidence_from_message: "a2", evidence_to_message: "u2" },
    version: "harness@1.0.0",
  });
  assert.equal(event.session_id, "abc");
  assert.equal(event.timestamp, "2026-10-06T10:00:00.000Z");
  assert.equal(event.cwd, "/r");
  assert.equal(event.skill_version, "harness@1.0.0");
  assert.deepEqual([event.evidence_from_message, event.evidence_to_message], ["a2", "u2"]);
  assert.equal("evidence_from" in event, false);
  assert.match(event.event_id, /^[0-9a-f-]{36}$/);
});

test("the session id falls back to the environment, then to a dated name", () => {
  assert.equal(usableSessionId("abc", {}), "abc");
  assert.match(usableSessionId("${CLAUDE_SESSION_ID}", {}), /^unknown-\d{4}-\d{2}-\d{2}$/);
  assert.match(usableSessionId("", {}), /^unknown-/);
  assert.equal(usableSessionId("", { CLAUDE_CODE_SESSION_ID: "from-env" }), "from-env");
});

test("generated fields win over the same keys in the input", () => {
  const input = { ...valid, event_id: "dup", session_id: "x", timestamp: "yesterday", cwd: "/x", skill_version: "fake" };
  const event = buildEvent(input, "real", { now: new Date("2026-10-06T10:00:00Z"), cwd: "/r", version: "harness@1.0.0" });
  assert.notEqual(event.event_id, "dup");
  assert.equal(event.session_id, "real");
  assert.equal(event.timestamp, "2026-10-06T10:00:00.000Z");
  assert.equal(event.cwd, "/r");
  assert.equal(event.skill_version, "harness@1.0.0");
});

test("the version is the plugin's name and version, or empty when the manifest is missing", () => {
  assert.match(skillVersion(), /^harness@\d+\.\d+\.\d+/);
  assert.equal(skillVersion("/nowhere/plugin.json"), "");
});

test("events go to .harness/learning-events at the git top level, even from a subfolder", () => {
  const repo = tempDir("learn-repo-");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, "packages", "web"), { recursive: true });
  assert.equal(eventsDir(join(repo, "packages", "web")), join(repo, ".harness", "learning-events"));
});

test("outside a git repo, events go to .harness/learning-events in the current folder", () => {
  const dir = tempDir("learn-plain-");
  assert.equal(eventsDir(dir), join(dir, ".harness", "learning-events"));
});

test("appends one JSON line per event to the session's file, with ids from its transcript", () => {
  const { env, cwd } = session("s1");
  const withEvidence = { ...valid, evidence_from: "try/catch", evidence_to: "errors go to Sentry" };
  const file = logEvent(JSON.stringify(withEvidence), "s1", { env, cwd });
  logEvent(JSON.stringify({ ...valid, outcome: "rejected", status: "rejected" }), "s1", { env, cwd });
  assert.equal(file, eventsFile(cwd, "s1"));
  const events = readEvents(file);
  assert.deepEqual(events.map((entry) => entry.outcome), ["new", "rejected"]);
  assert.deepEqual([events[0].evidence_from_message, events[0].evidence_to_message], ["a2", "u2"]);
  assert.deepEqual([events[1].evidence_from_message, events[1].evidence_to_message], ["", ""]);
});

test("refuses a snippet that matches no message, and writes nothing", () => {
  const { env, cwd } = session("s4");
  const input = { ...valid, evidence_from: "never said this", evidence_to: "errors go to Sentry" };
  assert.throws(() => logEvent(JSON.stringify(input), "s4", { env, cwd }), /evidence_from was not found/);
  assert.throws(() => readFileSync(eventsFile(cwd, "s4")));
});

test("bad field types are refused with a message, before the transcript is read", () => {
  const { env, cwd } = session("s5");
  assert.throws(() => logEvent(JSON.stringify({ ...valid, evidence_from: 1 }), "s5", { env, cwd }), /evidence_from must be text/);
  assert.throws(() => logEvent("null", "s5", { env, cwd }), /must be a JSON object/);
});

test("without a transcript, logs with empty message ids", () => {
  const { env, cwd } = noTranscript();
  const file = logEvent(JSON.stringify({ ...valid, evidence_to: "x" }), "s9", { env, cwd });
  assert.equal(readEvents(file)[0].evidence_to_message, "");
});

test("keeps quotes and newlines in the text intact", () => {
  const { env, cwd } = noTranscript();
  const text = `Don't use "console.log"\nin jobs`;
  const file = logEvent(JSON.stringify({ ...valid, proposed_learning: text }), "s2", { env, cwd });
  assert.equal(readEvents(file)[0].proposed_learning, text);
});

test("refuses an invalid event and writes nothing", () => {
  const { env, cwd } = noTranscript();
  assert.throws(() => logEvent(JSON.stringify({ outcome: "new" }), "s3", { env, cwd }), /trigger is required/);
  assert.throws(() => readFileSync(eventsFile(cwd, "s3")));
});
