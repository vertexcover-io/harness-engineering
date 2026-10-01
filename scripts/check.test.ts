import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { summarizeLint, summarizeTests, summarizeTypecheck } from "./check.ts"

describe("summarizeTypecheck", () => {
  test("counts the lines tsc reports as errors", () => {
    const output = [
      "@harness/core typecheck: src/runs.ts(698,7): error TS2322: Type 'x' is not assignable.",
      "@harness/cli typecheck: ../core/src/runs.ts(698,7): error TS2322: Type 'x' is not assignable.",
      "@harness/sdk typecheck: Exited with code 0",
    ].join("\n")
    assert.deepEqual(summarizeTypecheck(output), { errors: 2 })
  })

  test("a clean run has no errors", () => {
    assert.deepEqual(summarizeTypecheck("@harness/core typecheck: Exited with code 0"), { errors: 0 })
  })
})

describe("summarizeLint", () => {
  test("reads Biome's error and warning counts", () => {
    const output = "Checked 124 files in 82ms. No fixes applied.\nFound 1 error.\nFound 3 warnings."
    assert.deepEqual(summarizeLint(output), { errors: 1, warnings: 3 })
  })

  test("a clean run has no errors or warnings", () => {
    assert.deepEqual(summarizeLint("Checked 124 files in 64ms. No fixes applied."), {
      errors: 0,
      warnings: 0,
    })
  })
})

describe("summarizeTests", () => {
  test("reads bun test's pass and fail counts, ignoring its colour codes", () => {
    const output = "\x1b[0m\x1b[32m 644 pass\x1b[0m\n\x1b[0m\x1b[2m 2 fail\x1b[0m\n 1552 expect() calls"
    assert.deepEqual(summarizeTests(output), { passed: 644, failed: 2 })
  })

  test("a run that never reached the summary reports nothing passed", () => {
    assert.deepEqual(summarizeTests("error: script not found"), { passed: 0, failed: 0 })
  })
})
