import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Runs typecheck, lint and test over the whole repo, every one even when an earlier one fails,
 * and prints one JSON summary. The orchestrate baseline stores that JSON as the repo's baseline.
 */

type Summary = Readonly<Record<string, number>>

const ANSI = /\x1b\[[0-9;]*m/g

const countOf = (output: string, pattern: RegExp): number => {
  const match = output.replace(ANSI, "").match(pattern)
  return match?.[1] === undefined ? 0 : Number(match[1])
}

export const summarizeTypecheck = (output: string): Summary => ({
  errors: output.split("\n").filter((line) => /error TS\d+/.test(line)).length,
})

export const summarizeLint = (output: string): Summary => ({
  errors: countOf(output, /Found (\d+) errors?\./),
  warnings: countOf(output, /Found (\d+) warnings?\./),
})

export const summarizeTests = (output: string): Summary => ({
  passed: countOf(output, /^\s*(\d+) pass\b/m),
  failed: countOf(output, /^\s*(\d+) fail\b/m),
})

const CHECKS = [
  { name: "typecheck", script: "typecheck", summarize: summarizeTypecheck },
  { name: "lint", script: "lint", summarize: summarizeLint },
  { name: "test", script: "test", summarize: summarizeTests },
] as const

// The test suite's output runs to megabytes; spawnSync's 1 MB default would cut it off.
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

// FORCE_COLOR reaches the CLIs the tests spawn and colours their errors, so tests comparing that
// text fail only in a shell that sets it. Dropping it keeps the baseline the same in every shell.
const { FORCE_COLOR: _forceColor, ...checkEnv } = process.env

const runCheck = (check: (typeof CHECKS)[number]) => {
  const run = spawnSync("bun", ["run", check.script], {
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    env: { ...checkEnv, CI: "1" },
  })
  const exitCode = run.status ?? 1
  return [check.name, { exitCode, ...check.summarize(`${run.stdout}\n${run.stderr}`) }] as const
}

const main = (): void => {
  const results = CHECKS.map(runCheck)
  console.log(JSON.stringify(Object.fromEntries(results), null, 2))
  process.exitCode = results.some(([, result]) => result.exitCode !== 0) ? 1 : 0
}

/** Compared by real path, as in version.ts, so the test can import this file without running it. */
const isEntrypoint = (): boolean => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) main()
