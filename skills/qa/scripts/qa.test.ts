import { describe, expect, test } from "bun:test";
import { QaOutputSchema } from "./qa.ts";

const bug = { scenario: "SC3", cause: "the total skips refunds", fix: "subtract refunds" };
const report = "verification/proof-report.html";

describe("QaOutputSchema", () => {
  test("SC1: a PASS verdict with no reason parses", () => {
    const result = QaOutputSchema.safeParse({ status: "PASS", report, gaps: [], bugs: [] });

    expect(result.success).toBe(true);
  });

  test.each([
    { status: "PARTIAL", report, bugs: [] },
    { status: "FAIL", report: null, bugs: [{ ...bug, needsDecision: false }] },
    { status: "BLOCKED", report: null, bugs: [] },
  ])("SC2: a $status verdict fails on reason without one and parses with one", (verdict) => {
    const missing = QaOutputSchema.safeParse({ ...verdict, gaps: [] });
    const given = QaOutputSchema.safeParse({
      ...verdict,
      gaps: [],
      reason: "no-infra: podman is down",
    });

    expect(missing.error?.issues.map((issue) => issue.path)).toEqual([["reason"]]);
    expect(given.success).toBe(true);
  });

  test("SC3: status BLOCKED:no-infra is rejected even with a reason", () => {
    const result = QaOutputSchema.safeParse({
      status: "BLOCKED:no-infra",
      reason: "podman is down",
      report: null,
      gaps: [],
      bugs: [],
    });

    expect(result.success).toBe(false);
  });

  test("SC4: a FAIL bug without needsDecision is rejected, and with it parses unchanged", () => {
    const verdict = { status: "FAIL", reason: "one bug", report: null, gaps: [] };

    const missing = QaOutputSchema.safeParse({ ...verdict, bugs: [bug] });
    const given = QaOutputSchema.safeParse({
      ...verdict,
      bugs: [{ ...bug, needsDecision: false }],
    });

    expect(missing.success).toBe(false);
    expect(given.data?.bugs[0]).toEqual({ ...bug, needsDecision: false });
  });

  test.each(["PASS", "PARTIAL"])(
    "SC11: a %s verdict with no report is rejected on report",
    (status) => {
      const result = QaOutputSchema.safeParse({
        status,
        reason: "two gaps",
        report: null,
        gaps: [],
        bugs: [],
      });

      expect(result.error?.issues.map((issue) => issue.path)).toEqual([["report"]]);
    },
  );

  test("SC12: a FAIL verdict with no bugs is rejected on bugs", () => {
    const result = QaOutputSchema.safeParse({
      status: "FAIL",
      reason: "SC3 failed",
      report: null,
      gaps: [],
      bugs: [],
    });

    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["bugs"]]);
  });
});
