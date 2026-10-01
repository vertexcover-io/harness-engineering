// Banner and menu cases adapted from claude-auto-retry test/time-parser.test.js and
// test/patterns.test.js (https://github.com/cheapestinference/claude-auto-retry, commit cb99967f, MIT).
import { describe, expect, test } from "bun:test";
import type { ResetWait } from "@harness/sdk";
import { limitMenuKeys, readResetWait } from "./claude-limit.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MARGIN = MINUTE;
const RULE = "─".repeat(40);
// Claude 2.1.286's empty input box, with its status line below.
const PROMPT = `${RULE}\n❯\n${RULE}\n  Model: Opus | Ctx Used: 8.0%`;

describe("reset times in Claude's limit message", () => {
  // 13:00 UTC is 09:00 in New York (EDT) and 18:30 in Kolkata.
  const now = new Date("2026-10-01T13:00:00Z");
  test.each<[string, number | null]>([
    ["You've hit your limit · resets 3pm (UTC)", 2 * HOUR],
    ["Usage limit. Resets at 2pm (America/New_York)", 5 * HOUR],
    ["resets 15:30 (Asia/Kolkata)", 21 * HOUR],
    ["resets 12am (UTC)", 11 * HOUR],
    // noon passed an hour ago, so the next noon is tomorrow
    ["resets 12pm (UTC)", 23 * HOUR],
    // no am/pm: the sooner of 3am and 3pm
    ["resets 3 (UTC)", 2 * HOUR],
    // a weekly limit's date is not read: the wait ends at the next 3pm and retries from there
    ["You've hit your weekly limit · resets Aug 21 at 3pm (UTC)", 2 * HOUR],
    ["try again in 5 minutes", 5 * MINUTE],
    ["wait 30 mins", 30 * MINUTE],
    ["usage limit · resets in 2 hours", 2 * HOUR],
    // a year in the date must not be read as the hour
    ["Usage limit · resets Jan 2, 2027, 9am (UTC)", 20 * HOUR],
    ["resets 3pm (Not/AZone)", null],
    ["resets 30", null],
    ["some random text", null],
  ])('"%s" waits %p ms, plus a minute', (message, wait) => {
    const expected: ResetWait | null =
      wait === null ? null : { ms: wait + MARGIN, from: "message" };
    expect(readResetWait({ message, screen: "", now })).toEqual(expected);
  });
});

describe("readResetWait", () => {
  const now = new Date("2026-10-01T13:00:00Z");
  const IDLE = "❯ ";
  test.each<[string, string, string, ResetWait | null]>([
    [
      "the message, before the screen",
      "resets 3pm (UTC)",
      "● You've hit your limit · resets 5pm (UTC)",
      { ms: 2 * HOUR + MARGIN, from: "message" },
    ],
    [
      "the newest limit banner on screen, not an older one above it",
      "",
      "● You've hit your limit · resets 1pm (UTC)\n● You've hit your limit · resets 4pm (UTC)\n❯ ",
      { ms: 3 * HOUR + MARGIN, from: "screen" },
    ],
    [
      "a limit banner, not the statusline's own reset meter",
      "",
      "● You've hit your limit · resets 4pm (UTC)\n❯ \n⟳ resets in 1 hr",
      { ms: 3 * HOUR + MARGIN, from: "screen" },
    ],
    ["nothing when neither names a reset time", "API Error: Rate limit reached", IDLE, null],
  ])("reads the wait from %s", (_, message, screen, expected) => {
    expect(readResetWait({ message, screen, now })).toEqual(expected);
  });
});

describe("limitMenuKeys", () => {
  const FOOTER = "Enter to confirm · Esc to cancel";
  const menu = (lines: readonly string[]) =>
    ["What do you want to do?", ...lines, FOOTER].join("\n");
  const UPGRADE = "  1. Upgrade your plan";
  const WAIT = "  2. Stop and wait for limit to reset";

  test.each([
    [
      "the cursor on Upgrade, above Stop and wait",
      [`❯${UPGRADE.slice(1)}`, WAIT],
      ["Down", "Enter"],
    ],
    ["the cursor already on Stop and wait", [UPGRADE, `❯${WAIT.slice(1)}`], ["Enter"]],
    [
      "Stop and wait above the cursor",
      ["  1. Stop and wait for limit to reset", "❯ 2. Upgrade your plan"],
      ["Up", "Enter"],
    ],
  ])("with %s, the keys pick Stop and wait, never the default", (_, lines, keys) => {
    expect(limitMenuKeys(menu(lines))).toEqual(keys);
  });

  test("a live menu without Stop and wait in its options gets null, so Enter never confirms a guess", () => {
    expect(limitMenuKeys(menu(["❯ 1. Upgrade your plan", "  2. Ask your admin"]))).toBeNull();
  });

  test("with an old menu quoted above the live one, the keys follow the live menu at the bottom", () => {
    const old = menu([UPGRADE, `❯${WAIT.slice(1)}`]);
    const live = menu([`❯${UPGRADE.slice(1)}`, WAIT]);
    expect(limitMenuKeys(`${old}\n● Later output\n${live}`)).toEqual(["Down", "Enter"]);
  });

  test("a menu quoted with its cursor, above a live permission dialog, gets null", () => {
    const quoted = menu([UPGRADE, `❯${WAIT.slice(1)}`]);
    const dialog = "Do you want to run this command?\n❯ 1. Yes\n  2. No";
    expect(limitMenuKeys(`${quoted}\n● Bash(ls)\n${dialog}`)).toBeNull();
  });

  test.each([
    ["no menu", `● Done.\n${PROMPT}`],
    [
      "the menu quoted in a reply, with no cursor",
      `What do you want to do?\n${UPGRADE}\n${WAIT}\n${PROMPT}`,
    ],
    [
      "an old quoted menu above a live permission dialog",
      `What do you want to do?\n  1. Stop and wait for limit to reset\n  2. Upgrade your plan\n● Bash(ls)\nDo you want to run this command?\n❯ 1. Yes\n  2. No`,
    ],
  ])("%s gets no keys", (_, screen) => {
    expect(limitMenuKeys(screen)).toEqual([]);
  });
});
