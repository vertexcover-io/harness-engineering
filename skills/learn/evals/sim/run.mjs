#!/usr/bin/env node
// One simulated session: a real agent (claude -p, resumed each turn) in a fresh dummy repo, a
// simulated user (another model) that reacts to what the agent actually says, then checks.
// It tests the plugin this file sits in. See README.md for cost and setup.
// Usage: node run.mjs <scenario> <outDir>
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRepo } from "./fixture.mjs";
import { SCENARIOS } from "./scenarios.mjs";

// skills/learn/evals/sim/ → the plugin's root, whose manifest names it (harness, yok, …).
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const pluginName = JSON.parse(readFileSync(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8")).name;
const plugin = { dir: PLUGIN_ROOT, events: join(`.${pluginName}`, "learning-events") };
const MAX_TURNS = 12;
// The simulated user and the grader stay on SIM_MODEL; SIM_AGENT_MODEL varies only the agent under test.
const MODEL = process.env.SIM_MODEL || "sonnet";
const AGENT_MODEL = process.env.SIM_AGENT_MODEL || MODEL;

const [scenarioName, outDir] = process.argv.slice(2);
const scenario = SCENARIOS[scenarioName];
if (!scenario || !outDir) {
  console.error(`usage: node run.mjs <scenario> <outDir>\nscenarios: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

// The prompt goes on stdin: --tools takes a list and would swallow a trailing argument.
const claude = (args, prompt, cwd, timeoutMs, env = process.env) => {
  const result = spawnSync("claude", ["-p", "--output-format", "json", "--setting-sources", "project", ...args], {
    cwd,
    input: prompt,
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { is_error: true, result: `claude failed (status ${result.status}): ${(result.stderr || result.stdout || "").slice(0, 2000)}` };
  }
};

// RECHECK=1 re-runs only the checks on a finished session in outDir.
const previous = process.env.RECHECK ? JSON.parse(readFileSync(join(outDir, "result.json"), "utf8")) : null;
const repo = previous?.repo ?? realpathSync(mkdtempSync(join(tmpdir(), "learn-sim-repo-")));
const simCwd = realpathSync(mkdtempSync(join(tmpdir(), "learn-sim-user-")));
if (!previous) createRepo(repo, scenario.files);

// --- the simulated user ------------------------------------------------------------------------
const clip = (text, max = 6000) => (text.length > max ? `…${text.slice(-max)}` : text);

const simulatedUserPrompt = (conversation) => `You are playing the user in a conversation with an AI coding agent working in your repo. Stay in character as a busy, friendly developer. Write only the next message you would type: no quotes, no labels, no narration.

The task you want done: ${scenario.task}

What you know about this repo (the agent does not know this unless you tell it): ${scenario.knowledge}

How you behave, in order:
${scenario.behaviour.map((line, index) => `${index + 1}. ${line}`).join("\n")}

React to what the agent actually said. If it asks you something, answer it from what you know above. Never invent facts: no paths, repo names, URLs, versions or access details you were not given. If the agent needs something you don't know (another repo, credentials, a release), say you'll handle that part yourself and ask it to finish the rest. Keep messages short, like a real person typing. If nothing is left to do per the steps above, reply exactly DONE.

Conversation so far:
${conversation.length === 0 ? "(nothing yet; write your first message)" : conversation.map((turn) => `${turn.role === "user" ? "YOU" : "AGENT"}: ${clip(turn.text)}`).join("\n\n")}

Your next message:`;

const nextUserMessage = (conversation) => {
  const reply = claude(["--model", MODEL, "--tools", ""], simulatedUserPrompt(conversation), simCwd, 5 * 60_000);
  return (reply.result ?? "").trim().replace(/^["']|["']$/g, "");
};

// --- the agent ---------------------------------------------------------------------------------
const agentTurn = (message, sessionId) =>
  claude(
    [
      "--plugin-dir", plugin.dir,
      "--permission-mode", "bypassPermissions",
      "--model", AGENT_MODEL,
      ...(sessionId ? ["--resume", sessionId] : []),
    ],
    message,
    repo,
    20 * 60_000,
    // The hooks' own guard switches the nudge off, for scenarios that must reach /learn by hand.
    scenario.noNudge ? { ...process.env, [`${pluginName.toUpperCase()}_LEARN_CHECK`]: "1" } : process.env,
  );

const conversation = previous?.conversation ?? [];
let sessionId = previous?.sessionId ?? null;
for (let turn = 0; !previous && turn < MAX_TURNS; turn += 1) {
  const said = nextUserMessage(conversation);
  if (!said || said === "DONE" || said.endsWith("\nDONE")) break;
  const sent = said.replace(/^\/learn\b/, `/${pluginName}:learn`);
  conversation.push({ role: "user", text: sent });
  const reply = agentTurn(sent, sessionId);
  sessionId = reply.session_id ?? sessionId;
  conversation.push({ role: "agent", text: reply.result ?? "(no reply)", error: reply.is_error === true });
  if (reply.is_error && !reply.session_id) break;
}

// --- what happened -----------------------------------------------------------------------------
const transcriptPath = () => {
  const projects = join(homedir(), ".claude", "projects");
  return readdirSync(projects).map((dir) => join(projects, dir, `${sessionId}.jsonl`)).find(existsSync) ?? null;
};
const transcript = sessionId && transcriptPath()
  ? readFileSync(transcriptPath(), "utf8").split("\n").flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    })
  : [];
const recordText = (record) => {
  const content = record?.message?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((block) => block.text ?? JSON.stringify(block.input ?? "")).join("\n") : "";
};

const eventsDir = join(repo, plugin.events);
const events = existsSync(eventsDir)
  ? readdirSync(eventsDir).flatMap((file) =>
      readFileSync(join(eventsDir, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    )
  : [];
const learningsDir = join(repo, "docs", "learnings");
const learnings = existsSync(learningsDir)
  ? Object.fromEntries(readdirSync(learningsDir).map((file) => [file, readFileSync(join(learningsDir, file), "utf8")]))
  : {};
const changedFiles = spawnSync("git", ["status", "--porcelain", "-uall"], { cwd: repo, encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);

// What the agent wrote to files during the session: Edit/Write calls, and shell commands that
// name a file (agents often write with heredocs or scripts).
const writeOf = (block) => {
  if (block.type !== "tool_use") return [];
  const { file_path: filePath, content, new_string: newString, command } = block.input ?? {};
  if (filePath) return [{ file: filePath, text: [content, newString].filter(Boolean).join("\n") }];
  // Only shell commands that write, and only to their target: a redirect or tee target, an in-place
  // sed, or a path a script opens for writing. A path merely mentioned in the written text is not one.
  if (typeof command !== "string") return [];
  const targets = [
    ...command.matchAll(/(?:^|[^2&<])>{1,2}\s*["']?([\w./-]+)/g),
    ...command.matchAll(/\btee\s+(?:-a\s+)?["']?([\w./-]+)/g),
    ...command.matchAll(/sed -i(?:\s+''|\s+"")?\s+(?:-e\s+)?(?:'[^']*'|"[^"]*")\s+["']?([\w./-]+)/g),
    ...command.matchAll(/(?:writeFileSync|open)\(\s*["']([\w./-]+)["']/g),
    ...command.matchAll(/^p\s*=\s*["']([\w./-]+)["']/gm),
  ].map((match) => match[1]);
  return [...new Set(targets)].map((file) => ({ file, text: command }));
};
const writes = transcript.flatMap((record) => (Array.isArray(record.message?.content) ? record.message.content : []).flatMap(writeOf));

// Every shell command the agent ran, for mistakes that are commands rather than writes (npm install).
const commands = transcript.flatMap((record) =>
  (Array.isArray(record.message?.content) ? record.message.content : [])
    .filter((block) => block.type === "tool_use" && typeof block.input?.command === "string")
    .map((block) => block.input.command),
);
const mistakeFiles = scenario.mistake(writes, commands);
const expected = scenario.expect(mistakeFiles.length > 0);
const userMessages = conversation.filter((turn) => turn.role === "user").map((turn) => turn.text.trim());
const addedLearningFiles = () => changedFiles.filter((line) => line.startsWith("??") && /docs\/learnings\/(?!index\.md)/.test(line));

// --- checks ------------------------------------------------------------------------------------
const checks = [];
const check = (name, pass, detail = "") => checks.push({ name, pass: Boolean(pass), detail });

check("session ran", sessionId !== null && transcript.length > 0, sessionId ?? "no session");
// Where in the transcript the skill started: the user's /learn, or the agent's own Skill call.
const skillStart = transcript.findIndex((record) =>
  (record.type === "user" && recordText(record).trim().startsWith(`/${pluginName}:learn`)) ||
  (Array.isArray(record.message?.content) &&
    record.message.content.some((block) => block.type === "tool_use" && block.name === "Skill" && /(^|:)learn$/.test(block.input?.skill ?? ""))),
);
const typedLearn = userMessages.some((text) => text.startsWith(`/${pluginName}:learn`));
if (scenario.auto) {
  check("user never typed /learn", !typedLearn);
  if (!expected.none) check("learn started on its own", skillStart !== -1);
} else if (!expected.none) {
  // The nudge hook may start it before the user gets to type /learn; either way it ran.
  check("learn ran", typedLearn || skillStart !== -1);
}

const eventChecks = (event, label) => {
  const statuses = [expected.status].flat();
  check(`${label}status is ${statuses.join(" or ")}`, statuses.includes(event.status), event.status);
  const triggers = scenario.auto ? ["auto"] : ["manual", "auto"];
  check(`${label}trigger is ${triggers.join(" or ")}`, triggers.includes(event.trigger), event.trigger);
  if (event.trigger === "auto") {
    // The proposal must wait for the corrected work: no app edits between logging the learning and
    // the user's next message (work the user asks for afterwards is fine).
    const isAppWrite = (record) =>
      (Array.isArray(record.message?.content) ? record.message.content : []).flatMap(writeOf).some((write) => /(^|\/)apps\//.test(write.file));
    const logged = transcript.findIndex((record) =>
      (Array.isArray(record.message?.content) ? record.message.content : []).some((block) => block.type === "tool_use" && /log-event\.mjs/.test(block.input?.command ?? "")),
    );
    const nextUser = transcript.findIndex((record, index) => index > logged && record.type === "user" && typeof record.message?.content === "string");
    const lateWrite = transcript.slice(logged + 1, nextUser === -1 ? undefined : nextUser).findIndex(isAppWrite);
    check(`${label}proposed only after the corrected work was done`, logged !== -1 && lateWrite === -1, `logged at record ${logged}${lateWrite === -1 ? "" : `, app edited ${lateWrite + 1} records later in the same turn`}`);
  }
  check(`${label}skill_version is ${pluginName}@…`, event.skill_version?.startsWith(`${pluginName}@`), event.skill_version);
  if (event.status === "edited") check(`${label}final_learning filled`, Boolean(event.final_learning));
  if (expected.picked) check(`${label}option_user_picked is ${expected.picked}`, event.option_user_picked === expected.picked, event.option_user_picked);

  const toRecord = transcript.find((record) => record.uuid === event.evidence_to_message);
  const fromRecord = transcript.find((record) => record.uuid === event.evidence_from_message);
  check(`${label}evidence_to is a message in the transcript`, toRecord, event.evidence_to_message);
  // A rule the user stated with nothing corrected has no mistake to point at.
  const fromOptional = scenario.ruleInLearn && !event.evidence_from_message;
  check(`${label}evidence_from is a message in the transcript`, fromOptional || fromRecord, event.evidence_from_message);
  const toText = recordText(toRecord).trim();
  // When the user typed the rule with /learn, that message is the evidence.
  // A /learn that carries the rule is the user's own words too; a bare /learn is not evidence.
  const learnWithRule = /<command-args>\s*\S/.test(toText);
  check(
    `${label}evidence_to is something the user typed (a bare /learn does not count)`,
    toRecord?.type === "user" && (userMessages.some((text) => text === toText) || learnWithRule),
    toText.slice(0, 200),
  );
  const fromIndex = transcript.indexOf(fromRecord);
  const toIndex = transcript.indexOf(toRecord);
  check(`${label}evidence_from comes before evidence_to`, fromOptional || (fromIndex !== -1 && toIndex !== -1 && fromIndex <= toIndex));
  if (expected.options) {
    const count = event.options_shown?.length ?? 0;
    check(`${label}offered ${expected.options.label}`, expected.options.test(count), `${count} option(s): ${JSON.stringify(event.options_shown)}`);
  }

  if (event.outcome === "rejected") {
    check(`${label}rejection reason logged`, Boolean(event.rejection_reason?.trim()), event.rejection_reason);
    check(`${label}no learning file written`, addedLearningFiles().length === 0, addedLearningFiles().join(", "));
    return;
  }
  if (event.outcome === "lint") {
    check(`${label}learning_file is the lint config`, event.learning_file === expected.learningFile, event.learning_file);
    check(`${label}lint config changed`, changedFiles.some((line) => line.endsWith(expected.learningFile)), changedFiles.join(", "));
    check(`${label}no learning file written`, addedLearningFiles().length === 0, addedLearningFiles().join(", "));
    return;
  }
  const file = event.learning_file?.split("/").pop();
  const learning = learnings[file];
  check(`${label}learning file exists`, Boolean(learning), event.learning_file);
  if (learning) {
    check(`${label}learning has frontmatter, Occurrences and Stale when`, /^---\n[\s\S]*signal:[\s\S]*paths:[\s\S]*strength:[\s\S]*\n---/.test(learning) && learning.includes("**Occurrences:**") && learning.includes("**Stale when:**"));
    check(`${label}index.md links it`, (learnings["index.md"] ?? "").includes(`(${file})`));
  }
  if (expected.learningFile) {
    check(`${label}points at the existing learning`, event.learning_file === expected.learningFile, event.learning_file);
    check(`${label}existing learning got a second occurrence`, (learning?.match(/^- \d{4}-\d{2}-\d{2} ·/gm) ?? []).length >= 2);
    check(`${label}no duplicate learning file`, addedLearningFiles().length === 0, addedLearningFiles().join(", "));
  }
  if (expected.replaces) {
    const old = expected.replaces.split("/").pop();
    check(`${label}replaces names the old learning`, event.replaces === expected.replaces, event.replaces);
    check(`${label}old learning file deleted`, !(old in learnings));
    check(`${label}old learning's index line removed`, !(learnings["index.md"] ?? "").includes(`(${old})`));
  }
};

// A proposal the user rejected, where none was expected, is a false positive the skill recorded,
// not a broken pipeline; it is reported apart from passes and failures.
const falsePositive = expected.none && events.length > 0 && events.every((event) => event.status === "rejected" && event.rejection_reason);
if (expected.notExercised) {
  // Reported apart from passes and failures: the scenario's setup did not happen.
} else if (expected.none) {
  check(falsePositive ? "no event logged (false positive: proposed, user rejected, reason logged)" : "no event logged", events.length === 0 || falsePositive, `${events.length} event(s)`);
  check("no learning written", addedLearningFiles().length === 0, addedLearningFiles().join(", "));
} else {
  const count = typeof expected.count === "function" ? expected.count(mistakeFiles) : (expected.count ?? 1);
  const matching = events.filter((event) => event.outcome === expected.outcome);
  check(`${count} event(s), outcome ${expected.outcome}`, events.length === count && matching.length === count, `${events.length} event(s): ${events.map((e) => `${e.outcome}/${e.status}`).join(", ")}`);
  matching.forEach((event, index) => eventChecks(event, count > 1 ? `#${index + 1} ` : ""));
  if (count > 1) {
    const ends = new Set(matching.map((event) => event.evidence_to_message));
    check("each event points at a different correction", ends.size === matching.length);
  }
}

// The lesson itself is judged by a model: wording varies, the meaning must not.
if (expected.lesson) {
  const event = events.find((candidate) => candidate.outcome === expected.outcome);
  const learning = event ? learnings[event.learning_file?.split("/").pop()] : null;
  const verdict = claude(
    ["--model", MODEL, "--tools", ""],
    `You grade whether a written learning says the intended lesson. Reply with JSON only: {"pass": true|false, "reason": "<one sentence>"}.

Intended lesson: ${expected.lesson}

Options the agent offered: ${JSON.stringify(event?.options_shown ?? [])}
Saved learning file:
${learning ?? "(none)"}

Pass if the saved learning tells a future agent the same thing as the intended lesson. Wording, examples and how broadly it is phrased may differ; fail only if the meaning differs or the lesson is missing.`,
    simCwd,
    5 * 60_000,
  );
  try {
    const parsed = JSON.parse((verdict.result ?? "").replace(/^```json\s*|```$/g, "").trim());
    check("learning says the intended lesson (graded)", parsed.pass, parsed.reason);
  } catch {
    check("learning says the intended lesson (graded)", false, `grader reply unreadable: ${verdict.result}`);
  }
}

const result = {
  plugin: pluginName,
  scenario: scenarioName,
  source: scenario.source,
  repo,
  sessionId,
  transcript: sessionId ? transcriptPath() : null,
  conversation,
  mistakeMade: mistakeFiles.length > 0,
  mistakeFiles,
  expected,
  passed: checks.every((entry) => entry.pass),
  falsePositive,
  notExercised: expected.notExercised ?? null,
  checks,
  events,
  learnings,
  changedFiles,
};
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(
  join(outDir, "conversation.md"),
  conversation.map((turn) => `### ${turn.role === "user" ? "User (simulated)" : "Agent"}${turn.error ? " (error)" : ""}\n\n${turn.text}\n`).join("\n"),
);
const verdict = expected.notExercised ? "NOT EXERCISED" : result.passed ? (falsePositive ? "FALSE POSITIVE" : "PASS") : "FAIL";
console.log(`${pluginName} ${scenarioName}: ${verdict} (mistake made: ${result.mistakeMade})`);
for (const entry of checks) console.log(`  ${entry.pass ? "✓" : "✗"} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}`);
