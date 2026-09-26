import { describe, expect, test } from "bun:test";
import { DoctorJsonSchema, type DoctorReport, type DoctorRow, summarize } from "@harness/core";
import { exitCodeFor, renderJson, renderTable, renderText } from "./doctor.ts";

const row = (overrides: Partial<DoctorRow>): DoctorRow => ({
  name: "git",
  status: "ok",
  optional: false,
  detail: "git version 2.43.0",
  fix: [],
  ...overrides,
});

const report = (results: readonly DoctorRow[]): DoctorReport => summarize(results);

describe("renderText", () => {
  test("SC1: READY with every row OK ends the text at the verdict line, with no advice", () => {
    const text = renderText(report([row({})]));
    expect(text.endsWith("VERDICT\nREADY")).toBe(true);
  });

  test("SC2: BLOCKED with a failure and a warning prints the FAIL advice line", () => {
    const text = renderText(
      report([
        row({ name: "jq", status: "fail", detail: "not on PATH" }),
        row({ name: "gh", status: "warn", optional: true, detail: "not authenticated" }),
      ]),
    );
    expect(text).toContain("VERDICT\nBLOCKED jq");
    expect(text.endsWith("Fix the FAIL rows above, or run /setup-harness.")).toBe(true);
  });

  test("SC3: DEGRADED with only warnings names every warned row and prints the WARN advice line", () => {
    const text = renderText(
      report([
        row({ name: "gh", status: "warn", optional: true, detail: "not authenticated" }),
        row({ name: "samskara", status: "warn", optional: true, detail: "not paired" }),
      ]),
    );
    expect(text).toContain("VERDICT\nDEGRADED gh samskara");
    expect(text.endsWith("Each WARN costs the one stage it unblocks.")).toBe(true);
  });
});

describe("renderTable", () => {
  test("SC7: aligns STATUS across rows, truncates a long detail, and wraps extra fix steps", () => {
    const longDetail = "x".repeat(80);
    const table = renderTable([
      row({ name: "git", status: "ok" }),
      row({
        name: "jq",
        status: "fail",
        detail: longDetail,
        fix: ["brew install jq", "apt install jq", "dnf install jq"],
      }),
    ]);
    const lines = table.split("\n");
    const statusOffset = (line: string): number =>
      line.indexOf("OK") >= 0 ? line.indexOf("OK") : line.indexOf("FAIL");
    const headerStatusOffset = lines[0]?.indexOf("STATUS") ?? -1;
    expect(headerStatusOffset).toBeGreaterThan(-1);
    expect(statusOffset(lines[1] ?? "")).toBe(headerStatusOffset);
    expect(statusOffset(lines[2] ?? "")).toBe(headerStatusOffset);
    expect(table).toContain(`${"x".repeat(63)}…`);
    expect(lines[1]?.trimEnd().endsWith("-")).toBe(true);
    const fixColumn = lines[0]?.indexOf("FIX") ?? -1;
    for (const step of ["apt install jq", "dnf install jq"]) {
      expect(lines.find((line) => line.trim() === step)?.indexOf(step)).toBe(fixColumn);
    }
  });
});

describe("renderJson", () => {
  test("SC9: parses as JSON with results, failed, warned and a verdict matching the text-mode line", () => {
    const rep = report([
      row({ name: "gh", status: "warn", optional: true, detail: "not authenticated" }),
    ]);
    const parsed = DoctorJsonSchema.parse(JSON.parse(renderJson(rep)));
    expect(parsed).toEqual({ ...rep, verdict: "DEGRADED gh" });
  });
});

describe("exitCodeFor", () => {
  const cases: ReadonlyArray<readonly [string, readonly DoctorRow[], number]> = [
    ["READY", [row({})], 0],
    ["DEGRADED", [row({ name: "gh", status: "warn", optional: true })], 0],
    ["BLOCKED", [row({ name: "jq", status: "fail" })], 1],
  ];

  test.each(cases)("SC8: %s exits %i", (_label, results, expected) => {
    expect(exitCodeFor(report(results))).toBe(expected);
  });
});
