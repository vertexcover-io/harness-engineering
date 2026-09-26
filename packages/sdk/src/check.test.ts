import { describe, expect, test } from "bun:test";
import type { CheckContext, ExecResult } from "./check.ts";
import { checkBinary, fail, ok, warn } from "./check.ts";

const context = (result: ExecResult): CheckContext => ({
  root: "/repo",
  exec: () => Promise.resolve(result),
});

describe("ok/warn/fail", () => {
  test("ok returns status ok with the given detail and no fix", () => {
    expect(ok("v1.0.0")).toEqual({ status: "ok", detail: "v1.0.0" });
  });

  test("warn returns status warn with detail and an optional fix", () => {
    expect(warn("not authenticated", ["gh auth login"])).toEqual({
      status: "warn",
      detail: "not authenticated",
      fix: ["gh auth login"],
    });
  });

  test("fail returns status fail with detail and an optional fix", () => {
    expect(fail("not on PATH", ["brew install git"])).toEqual({
      status: "fail",
      detail: "not on PATH",
      fix: ["brew install git"],
    });
  });
});

describe("checkBinary", () => {
  test("a binary that exits 0 is ok with the first line of its version output", async () => {
    const run = checkBinary("git");
    const outcome = await run(
      context({ code: 0, stdout: "git version 2.43.0\nextra line\n", stderr: "" }),
    );
    expect(outcome).toEqual({ status: "ok", detail: "git version 2.43.0" });
  });

  test("a binary that exits non-zero fails with 'not on PATH'", async () => {
    const run = checkBinary("ffmpeg", ["-version"]);
    const outcome = await run(context({ code: 127, stdout: "", stderr: "" }));
    expect(outcome).toEqual({ status: "fail", detail: "not on PATH" });
  });
});
