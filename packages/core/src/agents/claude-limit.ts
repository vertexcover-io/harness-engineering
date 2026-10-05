// Adapted from claude-auto-retry src/time-parser.js and the limit-menu part of src/patterns.js
// (https://github.com/cheapestinference/claude-auto-retry, commit cb99967f07931cf7a3b376f5b2c8c1537f283c33).
//
// MIT License
//
// Copyright (c) 2026 CheapestInference
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

import type { ResetWait } from "@yok/sdk";

const MINUTE_MS = 60_000;
const DAY_MINUTES = 24 * 60;
// A minute past the reset, so the wait never ends just before it.
const MARGIN_MS = MINUTE_MS;

// "resets 3pm (Asia/Kolkata)", "resets at 15:30", "resets Aug 21 at 3pm (UTC)", "resets Jan 2,
// 2027, 9am (UTC)". A weekly limit's date is skipped: the wait ends at the next such clock time and the retry loop waits again.
const CLOCK =
  /resets?\s+(?:at\s+)?(?:[a-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:\d{4},?\s+)?(?:at\s+)?)?(\d{1,2})(?!\d)(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i;
const RELATIVE =
  /(?:try again|wait|resets?\s+in)[:\s]\s*(?:for\s+)?(?:in\s+)?(\d+)\s*(hours?|minutes?|mins?|h|m)\b/i;

const relativeWait = (text: string): number | null => {
  const [, amount, unit] = RELATIVE.exec(text) ?? [];
  if (amount === undefined || unit === undefined) return null;
  return Number(amount) * (unit.toLowerCase().startsWith("m") ? MINUTE_MS : 60 * MINUTE_MS);
};

// The hours "3" can mean: 3am or 3pm without am/pm, one hour with it; none when out of range.
const candidateHours = (hour: number, ampm: string | undefined): readonly number[] => {
  if (ampm === undefined)
    return hour > 23 ? [] : hour > 12 ? [hour] : [hour % 12, (hour % 12) + 12];
  if (hour < 1 || hour > 12) return [];
  return [(hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0)];
};

const minutesIntoDay = (timeZone: string, now: Date): number | null => {
  try {
    const format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    const part = (type: string) =>
      Number(format.formatToParts(now).find((p) => p.type === type)?.value);
    return part("hour") * 60 + part("minute");
  } catch {
    return null;
  }
};

// Time until the clock next shows that time, in the banner's zone or else the host's.
const clockWait = (text: string, now: Date): number | null => {
  const [, hour, minute = "0", ampm, zone] = CLOCK.exec(text) ?? [];
  if (hour === undefined || Number(minute) > 59) return null;
  const nowMinutes = minutesIntoDay(zone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, now);
  const hours = candidateHours(Number(hour), ampm);
  if (nowMinutes === null || hours.length === 0) return null;
  const until = (h: number) =>
    (((h * 60 + Number(minute) - nowMinutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return Math.min(...hours.map(until)) * MINUTE_MS;
};

const waitIn = (text: string, now: Date): number | null => {
  const wait = relativeWait(text) ?? clockWait(text, now);
  return wait === null ? null : wait + MARGIN_MS;
};

// The screen keeps old banners above the new one, and a statusline can show its own "resets in"
// meter, so only limit lines count, newest first.
const waitOnScreen = (screen: string, now: Date): number | null =>
  screen
    .split("\n")
    .filter((line) => /limit/i.test(line))
    .reverse()
    .map((line) => waitIn(line, now))
    .find((ms) => ms !== null) ?? null;

// How long until the limit Claude reported resets: from its error message, else its screen.
export const readResetWait = ({
  message,
  screen,
  now,
}: Readonly<{ message: string; screen: string; now: Date }>): ResetWait | null => {
  const fromMessage = waitIn(message, now);
  if (fromMessage !== null) return { ms: fromMessage, from: "message" };
  const fromScreen = waitOnScreen(screen, now);
  return fromScreen === null ? null : { ms: fromScreen, from: "screen" };
};

const OPTION = /^\s*❯?\s*\d+\.\s/;
const CURSOR_OPTION = /^\s*❯\s*\d+\.\s/;
// The cursor on any option, numbered or not; Claude's empty input is a bare ❯.
const CURSOR_ON_TEXT = /^\s*❯\s*\S/;
const WAIT_OPTION = /stop and wait for limit to reset/i;

// The keys that move Claude's usage-limit menu to "Stop and wait for limit to reset" and confirm
// it: an empty array when no live menu is open, null when one is open but cannot be answered
// safely. The cursor is found, never assumed, since the option order varies by version. Only the
// options just under the last "What do you want to do?" count, so a menu quoted earlier in the
// conversation never steers the keys, and a live dialog below them, such as a permission prompt,
// gives null.
export const limitMenuKeys = (screen: string): readonly string[] | null => {
  const lines = screen.split("\n");
  const heading = lines.findLastIndex((line) => /what do you want to do\?/i.test(line));
  if (heading === -1) return [];
  const rest = lines.slice(heading + 1).filter((line) => line.trim() !== "");
  const end = rest.findIndex((line) => !OPTION.test(line));
  const options = end === -1 ? rest : rest.slice(0, end);
  const cursor = options.findIndex((line) => CURSOR_OPTION.test(line));
  if (cursor === -1) return [];
  const wait = options.findIndex((line) => WAIT_OPTION.test(line));
  const below = rest.slice(options.length);
  if (wait === -1 || below.some((line) => CURSOR_ON_TEXT.test(line))) return null;
  const steps = wait - cursor;
  return [...Array<string>(Math.abs(steps)).fill(steps > 0 ? "Down" : "Up"), "Enter"];
};
