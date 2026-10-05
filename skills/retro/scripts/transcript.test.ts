import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diedOnLimit,
  failures,
  familyOf,
  formatTime,
  gaps,
  humanMessages,
  maskSecrets,
  type Rec,
  readAgent,
  readsLikeError,
} from "./transcript.ts";

const recs = (rows: readonly Record<string, unknown>[]): readonly Rec[] =>
  rows.map((data, i) => ({ line: i + 1, data }));

const at = (minute: number): string => `2026-10-03T10:${String(minute).padStart(2, "0")}:00Z`;

const user = (ts: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  timestamp: ts,
  message: { role: "user", content },
  ...extra,
});

const queued = (ts: string, prompt: string) => ({
  type: "attachment",
  timestamp: ts,
  attachment: { type: "queued_command", origin: { kind: "human" }, prompt },
});

const enqueue = (ts: string, content: string) => ({
  type: "queue-operation",
  timestamp: ts,
  operation: "enqueue",
  content,
});

describe("humanMessages", () => {
  test("SC8: the user text, the queued attachment and a typed slash command are the messages in time order, a text found in both places is kept once as QUEUED, and notifications, sub-agent hand-backs and meta records are not messages", () => {
    const slashCommand =
      "<command-message>retro</command-message>\n<command-name>/retro</command-name>\n<command-args>--run demo</command-args>";
    const rows = humanMessages(
      recs([
        user(at(1), "fix the header"),
        enqueue(at(0), "fix the header"),
        queued(at(3), "use the blue token"),
        enqueue(at(2), "<task-notification>agent-1 finished</task-notification>"),
        enqueue(at(5), '<agent-message from="a1">phase 1 COMPLETED</agent-message>'),
        user(at(6), slashCommand),
        user(at(4), "injected context", { isMeta: true }),
      ]),
    );

    expect(rows.map((m) => [m.kind, m.text])).toEqual([
      ["QUEUED", "fix the header"],
      ["QUEUED", "use the blue token"],
      ["TYPED", slashCommand],
    ]);
    expect(rows.map((m) => m.line)).toEqual([2, 3, 6]);
  });
});

const bashCall = (ts: string, id: string, command: string) => ({
  type: "assistant",
  timestamp: ts,
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
  },
});

const result = (ts: string, id: string, text: string, isError = false) =>
  user(ts, [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }]);

describe("failures", () => {
  test("SC9: a flagged error and a result that reads like one are failures pointing at their calls, with the command's first two words as the family; a clean result is not", () => {
    const rows = failures(
      recs([
        bashCall(at(0), "t1", "bun run typecheck --filter core"),
        result(at(1), "t1", "error TS2322: type mismatch", true),
        bashCall(at(2), "t2", "git push origin main"),
        result(at(3), "t2", "zsh: command not found: gh"),
        bashCall(at(4), "t3", "ls -la"),
        result(at(5), "t3", "total 8"),
      ]),
      readsLikeError,
    );

    expect(rows.map((f) => [f.line, f.call?.line])).toEqual([
      [2, 1],
      [4, 3],
    ]);
    expect(rows.map((f) => (f.call ? familyOf(f.call) : "?"))).toEqual(["bun run", "git push"]);
  });
});

describe("gaps", () => {
  test("SC10: records 1 then 7 minutes apart give one 7-minute gap naming the lines and types on each side", () => {
    const rows = gaps(
      recs([
        user(at(0), "start"),
        { type: "assistant", timestamp: at(1), message: { role: "assistant", content: "ok" } },
        user(at(8), "back"),
      ]),
    );

    expect(rows).toEqual([
      {
        beforeLine: 2,
        afterLine: 3,
        minutes: 7,
        beforeType: "assistant",
        beforeText: "ok",
        afterType: "user",
        afterText: "back",
      },
    ]);
  });
});

const assistantText = (ts: string, text: string) => ({
  type: "assistant",
  timestamp: ts,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const handback = (ts: string, message: string) => ({
  type: "assistant",
  timestamp: ts,
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "hb", name: "SubagentHandback", input: { message } }],
  },
});

const writeAgent = (
  dir: string,
  id: string,
  description: string,
  rows: readonly Record<string, unknown>[],
): string => {
  const path = join(dir, `agent-${id}.jsonl`);
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n"));
  writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ description }));
  return path;
};

describe("readAgent", () => {
  test("SC11: an agent whose short final message leads with the limit banner died; one whose long report mentions a rate limit near its end did not; each carries its meta description", () => {
    const dir = mkdtempSync(join(tmpdir(), "retro-agents-"));
    const died = writeAgent(dir, "a1", "build phase 1", [
      user(at(0), "build it"),
      assistantText(at(1), "Session limit reached. Try again at 3pm."),
    ]);
    const report = `${"Phase 1 is built. ".repeat(40)}The only hiccup was a rate limit on the API, which cleared.`;
    const lived = writeAgent(dir, "a2", "build phase 2", [
      user(at(0), "build it"),
      assistantText(at(2), report),
    ]);

    const dead = readAgent(died);
    const alive = readAgent(lived);
    expect([dead.died, alive.died]).toEqual([true, false]);
    expect([dead.description, alive.description]).toEqual(["build phase 1", "build phase 2"]);
    expect(dead).toMatchObject({ name: "agent-a1.jsonl", first: at(0), last: at(1), finalLine: 2 });
  });

  test("an agent that hands its report back through SubagentHandback has that message as its final text, at the call's line, not the narration before it; a hand-back leading with the limit banner is a death", () => {
    const dir = mkdtempSync(join(tmpdir(), "retro-agents-"));
    const reported = writeAgent(dir, "a3", "build phase 3", [
      user(at(0), "build it"),
      assistantText(at(1), "Running the suite now."),
      handback(at(2), "COMPLETED: phase 3 is built, 12 tests pass."),
    ]);
    const dead = writeAgent(dir, "a4", "build phase 4", [
      user(at(0), "build it"),
      handback(at(1), "Session limit reached. Try again at 3pm."),
    ]);

    expect(readAgent(reported)).toMatchObject({
      finalLine: 3,
      finalText: "COMPLETED: phase 3 is built, 12 tests pass.",
      died: false,
    });
    expect(readAgent(dead)).toMatchObject({ finalLine: 2, died: true });
  });

  test.each([
    [
      "a long message that leads with the banner",
      `Session limit reached. ${"x".repeat(600)}`,
      false,
    ],
    ["a short message with the banner past character 200", `${"x".repeat(210)} rate limit`, false],
    ["a short message that leads with the banner", "Usage limit reached.", true],
  ])("SC11: %s", (_, text, died) => {
    expect(diedOnLimit(text)).toBe(died);
  });
});

describe("formatTime", () => {
  test("SC12: 2026-10-03T11:39:21Z prints as 10-03 17:09:21 in Asia/Kolkata, and a missing timestamp prints ?", () => {
    expect(formatTime("2026-10-03T11:39:21Z", "Asia/Kolkata")).toBe("10-03 17:09:21");
    expect(formatTime(undefined, "Asia/Kolkata")).toBe("?");
    expect(formatTime("yesterday", "Asia/Kolkata")).toBe("?");
  });
});

describe("maskSecrets", () => {
  test("common key shapes, bearer tokens and KEY=value pairs are masked; ordinary text is not", () => {
    expect(maskSecrets("token ghp_0123456789abcdefghijABCDEF done")).toBe("token REDACTED done");
    expect(maskSecrets("Authorization: Bearer abcdef0123456789abcdef")).toBe(
      "Authorization: Bearer REDACTED",
    );
    expect(maskSecrets('export ASANA_API_KEY="1/2345:abcdef"')).toBe(
      "export ASANA_API_KEY=REDACTED",
    );
    expect(maskSecrets("bun run typecheck --filter core")).toBe("bun run typecheck --filter core");
  });

  test("a JSON pair with a key-like name keeps the name and loses the value, escaped quotes included", () => {
    expect(maskSecrets('{"apiKey":"abcd1234efgh5678ijkl","password":"hunter2hunter2"}')).toBe(
      '{"apiKey":"REDACTED","password":"REDACTED"}',
    );
    expect(maskSecrets('{\\"client_secret\\": \\"abcd1234efgh5678\\"}')).toBe(
      '{\\"client_secret\\": \\"REDACTED\\"}',
    );
  });

  test("a lowercase name=value pair and a NAME: value pair are masked", () => {
    expect(maskSecrets("curl -d api_key=abcd1234efgh5678 host")).toBe(
      "curl -d api_key=REDACTED host",
    );
    expect(maskSecrets("LINEAR_API_KEY: abcd1234efgh5678")).toBe("LINEAR_API_KEY: REDACTED");
    expect(maskSecrets("https://x.test/cb?token=abcd1234efgh&next=/home")).toBe(
      "https://x.test/cb?token=REDACTED&next=/home",
    );
  });

  test("a key-like word with no value, or a value under 8 characters, is left alone", () => {
    const plain = 'token count: 5, password reset flow, key: "value", secret: none';
    expect(maskSecrets(plain)).toBe(plain);
  });

  test.each([
    ["a word that only ends in key", "monkey: abcdefgh12 and MONKEY=abcdefgh12"],
    ["a bare key name, as in any JSON map", '{"key": "description12", "primaryKey": "user_id_12"}'],
    [
      "a code value with no digit",
      "password: undefined, token: nextPageToken, secret = process.env",
    ],
    ["a quoted phrase", '{"token": "the next token is 42"}'],
  ])("%s is not masked", (_, text) => {
    expect(maskSecrets(text)).toBe(text);
  });

  test("a quoted secret with no digit is still masked", () => {
    expect(maskSecrets('{"password":"correcthorsebattery"}')).toBe('{"password":"REDACTED"}');
  });
});
