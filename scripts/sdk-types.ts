import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** Builds packages/cli/src/sdk-types.json: the SDK public entry's .d.ts files, which yok writes into a project's .yok/types. */

export type SdkTypes = Readonly<{ zodVersion: string; files: Readonly<Record<string, string>> }>

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const SDK_TYPES_FILE = join(ROOT, "packages/cli/src/sdk-types.json")
const TSC = join(ROOT, "node_modules/.bin/tsc")
const TSCONFIG = join(ROOT, "packages/sdk/tsconfig.types.json")
const ZOD_PACKAGES = [
  join(ROOT, "packages/sdk/node_modules/zod/package.json"),
  join(ROOT, "node_modules/zod/package.json"),
]
// In a project, ./x.js resolves to x.d.ts under every module-resolution mode; ./x.ts does not.
const TS_SPECIFIER = /((?:from|import\()\s*["'])(\.{1,2}\/[^"']+)\.ts(["'])/g

const zodVersion = (): string => {
  const file = ZOD_PACKAGES.find((path) => existsSync(path))
  if (file === undefined) throw new Error("zod is not installed; run bun install")
  return String(JSON.parse(readFileSync(file, "utf8")).version)
}

const emitDeclarations = (out: string): void => {
  const result = spawnSync(TSC, ["-p", TSCONFIG, "--outDir", out], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`tsc failed:\n${result.stdout}${result.stderr}`)
}

const readDeclarations = (out: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(out)
      .filter((name) => name.endsWith(".d.ts"))
      .sort()
      .map((name) => [name, readFileSync(join(out, name), "utf8").replace(TS_SPECIFIER, "$1$2.js$3")]),
  )

export const buildSdkTypes = (): SdkTypes => {
  const out = mkdtempSync(join(tmpdir(), "sdk-types-"))
  try {
    emitDeclarations(out)
    return { zodVersion: zodVersion(), files: readDeclarations(out) }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

const main = (): void => {
  writeFileSync(SDK_TYPES_FILE, `${JSON.stringify(buildSdkTypes(), null, 2)}\n`)
}

/** Compared by real path, as in check.ts, so the test can import this file without running it. */
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
