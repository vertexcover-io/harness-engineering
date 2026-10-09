#!/usr/bin/env node
// Nudges the agent to run the learn skill after a correction, since it rarely does so on its own.
//   node learn-hooks.mjs prompt          (UserPromptSubmit) notes the message and starts a check
//   node learn-hooks.mjs classify <file> (run by prompt, detached) asks a small model whether the
//                                        message corrected the agent; the regex decides if it can't
//   node learn-hooks.mjs stop            (Stop) once the agent's work is done, asks it to consider
//                                        the learn skill if a correction has not been handled yet
// Hook input arrives as JSON on stdin. Any failure lets the turn go on untouched.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { envName, PLUGIN } from "./plugin.mjs";
import { contentBlocks, readTranscript } from "./transcript.mjs";

// Set on the model call, so the check's own session never runs these hooks.
const INSIDE_CHECK = envName("LEARN_CHECK");
const CHECK_TIMEOUT_MS = 20_000;
const CHECK_MODEL = "haiku";
const STATE_DIR = join(tmpdir(), `${PLUGIN.name}-learn`);
// Sessions with nobody to answer the learn skill's question are never nudged: CI, and a plugin's
// own pipeline runs where it sets <NAME>_RUN_ID (yok run stages; their retro reviews the run).
const UNATTENDED = ["CI", envName("RUN_ID")];
// Set this to have failures written to debug.log in STATE_DIR instead of swallowed.
const DEBUG = envName("LEARN_DEBUG");
const STATE_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

// The fallback when the model can't answer. Loose on purpose: the agent and then the user decide
// whether a flagged message is worth a learning.
const CORRECTION = [
  /^\s*(no|nope|nah|wrong|wait|stop|actually|hmm+|ugh|hold on)\b/i,
  /\b(don'?t|do not|never|always|stop)\s+(use|do|put|add|write|hard-?code|call|import|create)\b/i,
  /\buse\s+\S+(\s+\S+)?\s+not\b/i,
  /\b(instead of|rather than)\b/i,
  /\bwe\s+(already|always|never|don'?t|do not|usually)\b/i,
  /\balready (have|has) (a|an|our) (place|way|helper|util|function|flag|setting)/i,
  /\b(in|for) this (repo|codebase|project)\b/i,
  /\bthat'?s not (how|what|where|right)\b/i,
  /\bI (told|asked) you\b/i,
  /\bsame (mistake|thing) again\b/i,
  /\bwhy (did|would|are) you\b/i,
  /\b(you|did you) (hard-?code[ds]?|forg[eo]t|miss(ed)?|br[oe]ke|should(n'?t)? have|didn'?t)\b/i,
  /\b(belongs?|lives?|should (go|live|be)) in\b|\bgo(es)? in \S*\//i,
  /\bremember (that|to)\b/i,
];

export const looksLikeCorrection = (text) => CORRECTION.some((pattern) => pattern.test(text));

const readState = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
};
// The state can hold the user's words, so the folder and file are private to the user.
const writeState = (file, state) => {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
};
const stateFile = (sessionId, dir) => join(dir, `${sessionId}.json`);

// Each session leaves one small state file (timestamps only once its correction is handled); files
// untouched for a week are removed.
const pruneOldStates = (dir, now) => {
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (name.endsWith(".json") && now - statSync(path).mtimeMs > STATE_KEPT_MS) rmSync(path, { force: true });
    }
  } catch {
    // No state folder yet.
  }
};

const replyText = (record) =>
  record.type === "assistant"
    ? contentBlocks(record).filter((block) => block.type === "text").map((block) => block.text).join("\n")
    : "";
const lastAgentReply = (records) => records.map(replyText).filter(Boolean).at(-1) ?? "";

// The learn skill ran after `since`: the user typed /learn, or the agent invoked it.
const learnRanSince = (records, since) =>
  records.some((record) => {
    if (!record.timestamp || record.timestamp < since) return false;
    const content = record.message?.content;
    if (typeof content === "string") return /<command-name>\/([\w-]+:)?learn<\/command-name>|^\/([\w-]+:)?learn\b/m.test(content);
    return contentBlocks(record).some((block) => block.type === "tool_use" && block.name === "Skill" && /(^|:)learn$/.test(block.input?.skill ?? ""));
  });

// --- deciding whether a message is a correction ----------------------------------------------

const checkPrompt = (message, previousReply) => `You read one message a user sent to an AI coding agent, and the agent's reply just before it. Answer "yes" if the user is telling the agent that its approach was wrong for this codebase or team (where code goes, a convention, a tool or library to use or avoid, how errors or data are handled), even if they say it politely or as a question. Answer "no" for new requests, follow-up instructions, answers to the agent's questions, thanks, and questions about the work.

Agent's previous reply (may be empty):
"""${previousReply.slice(-1500)}"""

User's message:
"""${message.slice(0, 1500)}"""

Answer with exactly one word: yes or no.`;

// The model's answer, or null when it can't give one in time. The call saves no session, loads no
// MCP servers or skills, and its own hooks stay off through INSIDE_CHECK.
export const askModel = (message, previousReply, { run = spawnSync, timeoutMs = CHECK_TIMEOUT_MS } = {}) => {
  const args = [
    "-p", "--model", CHECK_MODEL, "--tools", "", "--setting-sources", "project",
    "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
  ];
  const result = run("claude", args, {
    input: checkPrompt(message, previousReply),
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...process.env, [INSIDE_CHECK]: "1" },
  });
  const answer = (result.stdout ?? "").trim().toLowerCase();
  if (result.status !== 0 || !/^(yes|no)\b/.test(answer)) return null;
  return answer.startsWith("yes");
};

export const classify = (file, { ask = askModel } = {}) => {
  const { checking } = readState(file);
  if (!checking) return;
  const records = readTranscript(checking.transcriptPath);
  // An answer to the learn skill's own question ("2, but…") is not a new correction.
  const answeringLearn = checking.previousPromptAt !== undefined && learnRanSince(records, checking.previousPromptAt);
  const verdict = !answeringLearn && (ask(checking.text, lastAgentReply(records)) ?? looksLikeCorrection(checking.text));
  // A newer message may have started its own check meanwhile: this verdict is kept either way, and
  // only this check's own `checking` is cleared.
  const latest = readState(file);
  const done = latest.checking?.at === checking.at ? { checking: null } : {};
  const found = verdict && !(latest.pending?.at > checking.at) ? { pending: { at: checking.at, text: checking.text } } : {};
  writeState(file, { ...latest, ...done, ...found });
};

// --- hook entry points -------------------------------------------------------------------------

const startCheckInBackground = (file) =>
  spawn(process.execPath, [fileURLToPath(import.meta.url), "classify", file], { detached: true, stdio: "ignore" }).unref();

// Reads no transcript: this runs before the user's message is submitted.
export const onPrompt = (input, { dir = STATE_DIR, now = new Date(), startCheck = startCheckInBackground } = {}) => {
  if (!input.session_id || typeof input.prompt !== "string" || input.prompt.trimStart().startsWith("/")) return null;
  pruneOldStates(dir, now.getTime());
  const file = stateFile(input.session_id, dir);
  const state = readState(file);
  const at = now.toISOString();
  const checking = { at, text: input.prompt.slice(0, 1500), transcriptPath: input.transcript_path, previousPromptAt: state.lastPromptAt };
  writeState(file, { ...state, lastPromptAt: at, checking });
  startCheck(file);
  return null;
};

// A reply whose last paragraph asks the user something leaves the turn open.
const asksTheUser = (reply) => /\?\s*[*_`)"']*\s*$/.test(reply.trim().split(/\n\s*\n/).at(-1) ?? "");

const nudgeFor = (text) =>
  "Automatic check from the learn hook, not a message from the user. " +
  `Earlier the user said: "${text.slice(0, 300)}". If that corrected how you work in this repo and it ` +
  "applies beyond this task, run the learn skill (trigger auto), but first finish any work the user " +
  "asked for that is still open. Otherwise end your turn with no further output: do not mention, " +
  "answer or acknowledge this check.";

// One nudge per correction, only once the agent's reply hands the turn back (not while it is asking
// the user something), and never while it is already continuing for a stop hook.
export const onStop = (input, { dir = STATE_DIR } = {}) => {
  if (!input.session_id || input.stop_hook_active) return null;
  const file = stateFile(input.session_id, dir);
  const { pending } = readState(file);
  if (!pending) return null;
  const records = readTranscript(input.transcript_path);
  const handled = learnRanSince(records, pending.at);
  if (!handled && asksTheUser(input.last_assistant_message ?? lastAgentReply(records))) return null;
  // Re-read: a check may have finished while the transcript was being read.
  const latest = readState(file);
  if (latest.pending?.at === pending.at) writeState(file, { ...latest, pending: null });
  return handled ? null : { decision: "block", reason: nudgeFor(pending.text) };
};

const isEntryPoint = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isEntryPoint && !process.env[INSIDE_CHECK] && !UNATTENDED.some((name) => process.env[name])) {
  try {
    const [mode, file] = process.argv.slice(2);
    const hook = { prompt: onPrompt, stop: onStop }[mode];
    if (mode === "classify") classify(file);
    const reply = hook?.(JSON.parse(readFileSync(0, "utf8")));
    if (reply) process.stdout.write(JSON.stringify(reply));
  } catch (error) {
    // A broken nudge must never trap or break the session; with DEBUG set it leaves a trace.
    if (process.env[DEBUG]) {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      appendFileSync(join(STATE_DIR, "debug.log"), `${new Date().toISOString()} ${process.argv[2]}: ${error?.stack ?? error}\n`);
    }
  }
}
