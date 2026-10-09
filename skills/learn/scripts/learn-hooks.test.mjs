import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { askModel, classify, looksLikeCorrection, onPrompt, onStop } from "./learn-hooks.mjs";

// Corrections the simulated users actually typed in the learn-sim runs, and messages that are not.
const corrections = [
  "Hmm, it looks like you hardcoded RESELLER/PAYMENT_MANUAL inside the two apps. We already have a place for per-type stuff like this in shared-config",
  "Hold on, did you hardcode RESELLER and PAYMENT_MANUAL in both apps? shared-config already has a place for per-type flags like this",
  "Thanks! One thing though: shared-config already has a place for this kind of per-type rule",
  "Ugh, this is exactly what we got burned on before, and there's a learning about it. Don't hard-code the list in the apps.",
  "no, use pnpm here, not npm",
  "services go in src/services",
  "I told you, errors go to Sentry",
  "that's not how we do auth, use the middleware",
];
const notCorrections = [
  "Can you add an invoice id field to the admin panel?",
  "Thanks, that's what I wanted.",
  "Option 1.",
  "Looks good, ship it",
  "Did the activationTypesWhere switch actually go in on both apps?",
];

const root = mkdtempSync(join(tmpdir(), "learn-hooks-"));
after(() => rmSync(root, { recursive: true, force: true }));
let made = 0;
const fresh = () => {
  made += 1;
  return join(root, String(made));
};
const tempDir = fresh;
const transcriptWith = (records) => {
  const path = `${fresh()}.jsonl`;
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n"));
  return path;
};
const agentSaid = (text, timestamp = "2026-10-09T10:05:00Z") => ({ type: "assistant", timestamp, message: { content: [{ type: "text", text }] } });
const learnRan = (timestamp) => ({ type: "assistant", timestamp, message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "harness:learn" } }] } });

// A session whose background check answers with `verdict` (true, false, or null for "no answer").
const session = (verdict) => {
  const asked = [];
  const ctx = { dir: tempDir(), asked, now: new Date("2026-10-09T10:00:00Z") };
  const ask = (text, previousReply) => {
    asked.push({ text, previousReply });
    return verdict;
  };
  ctx.startCheck = (file) => classify(file, { ask });
  return ctx;
};
const correct = (ctx, extra = {}) => onPrompt({ session_id: "s", prompt: "no, use pnpm here, not npm", ...extra }, ctx);

test("the regex fallback flags corrections and leaves requests, thanks, answers and questions alone", () => {
  for (const text of corrections) assert.equal(looksLikeCorrection(text), true, text);
  for (const text of notCorrections) assert.equal(looksLikeCorrection(text), false, text);
});

test("the model sees the message and the agent's previous reply, and its answer decides", () => {
  const ctx = session(true);
  const transcript_path = transcriptWith([agentSaid("I added the list to both apps.")]);
  onPrompt({ session_id: "s", prompt: "Option 1.", transcript_path }, ctx);
  assert.deepEqual(ctx.asked, [{ text: "Option 1.", previousReply: "I added the list to both apps." }]);
  assert.equal(onStop({ session_id: "s" }, ctx).decision, "block");
});

test("a model no is final, even when the regex would have flagged the message", () => {
  const ctx = session(false);
  correct(ctx);
  assert.equal(onStop({ session_id: "s" }, ctx), null);
});

test("without a model answer the regex decides", () => {
  const ctx = session(null);
  correct(ctx);
  assert.equal(onStop({ session_id: "s" }, ctx).decision, "block");
  const quiet = session(null);
  onPrompt({ session_id: "s", prompt: "Thanks, that's what I wanted." }, quiet);
  assert.equal(onStop({ session_id: "s" }, quiet), null);
});

test("a model that fails, times out or answers something else gives no answer", () => {
  const reply = (status, stdout) => () => ({ status, stdout });
  assert.equal(askModel("m", "", { run: reply(0, "yes\n") }), true);
  assert.equal(askModel("m", "", { run: reply(0, "No.") }), false);
  assert.equal(askModel("m", "", { run: reply(null, "") }), null);
  assert.equal(askModel("m", "", { run: reply(0, "I think so") }), null);
});

test("the model call keeps no session and loads no MCP servers or skills", () => {
  let args = [];
  const run = (_command, given) => {
    args = given;
    return { status: 0, stdout: "no" };
  };
  askModel("m", "", { run });
  for (const flag of ["--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(args.includes(flag), flag);
});

test("slash commands are never checked", () => {
  const ctx = session(true);
  onPrompt({ session_id: "s", prompt: "/harness:learn" }, ctx);
  assert.deepEqual(ctx.asked, []);
});

test("an answer to the learn skill's own question is not taken for a new correction", () => {
  const ctx = session(true);
  onPrompt({ session_id: "s", prompt: "Option 1." }, { ...ctx, now: new Date("2026-10-09T09:00:00Z"), startCheck: () => {} });
  correct(ctx, { transcript_path: transcriptWith([learnRan("2026-10-09T09:30:00Z")]) });
  assert.deepEqual(ctx.asked, []);
  assert.equal(onStop({ session_id: "s" }, ctx), null);
});

test("the nudge fires once, and tells the agent to stay silent when it does not apply", () => {
  const ctx = session(true);
  correct(ctx);
  const nudge = onStop({ session_id: "s" }, ctx);
  assert.match(nudge.reason, /use pnpm here/);
  assert.match(nudge.reason, /do not mention, answer or acknowledge this check/);
  assert.equal(onStop({ session_id: "s" }, ctx), null);
});

test("no nudge while the agent's last paragraph asks the user something; it waits for the reply that finishes", () => {
  const ctx = session(true);
  correct(ctx);
  for (const asking of ["Should I also update the CI config?", "Which do you prefer?\n\n1. pnpm\n2. npm?", "Want me to do that?**"]) {
    assert.equal(onStop({ session_id: "s", last_assistant_message: asking }, ctx), null, asking);
  }
  assert.equal(onStop({ session_id: "s", last_assistant_message: "Switched everything to pnpm." }, ctx).decision, "block");
});

test("never nudges while the agent is already continuing for a stop hook", () => {
  const ctx = session(true);
  correct(ctx);
  assert.equal(onStop({ session_id: "s", stop_hook_active: true }, ctx), null);
  assert.equal(onStop({ session_id: "s" }, ctx).decision, "block");
});

test("no nudge when the learn skill already ran after the correction, but an earlier run does not count", () => {
  const ran = session(true);
  correct(ran);
  assert.equal(onStop({ session_id: "s", transcript_path: transcriptWith([learnRan("2026-10-09T10:01:00Z")]) }, ran), null);

  const before = session(true);
  correct(before);
  const earlier = transcriptWith([{ type: "user", timestamp: "2026-10-09T09:00:00Z", message: { content: "<command-name>/harness:learn</command-name>" } }]);
  assert.equal(onStop({ session_id: "s", transcript_path: earlier }, before).decision, "block");
});

test("a check that finishes after a newer message started its own still records its correction", () => {
  const ctx = { ...session(null), startCheck: () => {} };
  correct(ctx);
  const newer = { ...ctx, now: new Date("2026-10-09T10:01:00Z") };
  // The user sends "Thanks." while the correction is still being checked.
  const askWhileUserTypes = () => {
    onPrompt({ session_id: "s", prompt: "Thanks." }, newer);
    return true;
  };
  classify(join(ctx.dir, "s.json"), { ask: askWhileUserTypes });
  assert.match(onStop({ session_id: "s" }, ctx).reason, /use pnpm here/);
});

test("state files untouched for a week are removed when a new message comes in", () => {
  const ctx = session(false);
  mkdirSync(ctx.dir, { recursive: true });
  const old = join(ctx.dir, "old-session.json");
  writeFileSync(old, "{}");
  const weekAgo = new Date("2026-10-01T00:00:00Z");
  utimesSync(old, weekAgo, weekAgo);
  correct(ctx);
  assert.equal(existsSync(old), false);
});

test("sessions do not see each other's corrections, and a handled one leaves no user text behind", () => {
  const ctx = session(true);
  correct(ctx);
  assert.equal(onStop({ session_id: "b" }, ctx), null);
  onStop({ session_id: "s" }, ctx);
  assert.doesNotMatch(readFileSync(join(ctx.dir, "s.json"), "utf8"), /pnpm/);
});
