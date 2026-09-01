#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The plugin manifest is what version-gate.sh fetches from main to tell an
 * installed harness it is stale, so it and package.json must never drift.
 */
const MANIFESTS = ["package.json", ".claude-plugin/plugin.json"]

const EXPLICIT = /^\d+\.\d+\.\d+(?:[-+].+)?$/
const SEGMENTS = /^(\d+)\.(\d+)\.(\d+)/
const VERSION_FIELD = /("version":\s*")[^"]*(")/
const NAME_LINE = /("name":\s*"[^"]*",\n)/

export const nextVersion = (current: string, bump: string): string => {
  if (EXPLICIT.test(bump)) return bump
  const segments = current.match(SEGMENTS)
  if (segments === null) throw new Error(`cannot bump "${current}": it is not a semver version`)
  const [major, minor, patch] = segments.slice(1, 4).map(Number) as [number, number, number]
  if (bump === "major") return `${major + 1}.0.0`
  if (bump === "minor") return `${major}.${minor + 1}.0`
  if (bump === "patch") return `${major}.${minor}.${patch + 1}`
  throw new Error(`unknown bump "${bump}": use major, minor, patch or an explicit x.y.z`)
}

export const readVersion = (source: string): string | null =>
  source.match(/"version":\s*"([^"]*)"/)?.[1] ?? null

/** Rewrites the field in place rather than reserialising, so no manifest is reformatted. */
export const setVersion = (source: string, version: string): string => {
  if (readVersion(source) !== null) return source.replace(VERSION_FIELD, `$1${version}$2`)
  const inserted = source.replace(NAME_LINE, `$1  "version": "${version}",\n`)
  if (inserted === source) throw new Error('manifest has neither a "version" nor a "name" field')
  return inserted
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()

const currentVersion = (): string => {
  for (const manifest of MANIFESTS) {
    const found = readVersion(readFileSync(join(repoRoot, manifest), "utf8"))
    if (found !== null) return found
  }
  return "0.0.0"
}

const main = (): void => {
  const args = process.argv.slice(2)
  const bump = args.find((arg) => !arg.startsWith("--"))
  if (bump === undefined) {
    throw new Error("usage: bun run release:version <major|minor|patch|x.y.z> [--no-git]")
  }

  const commit = !args.includes("--no-git")
  /** -uno: untracked files are none of a release's business, only MANIFESTS get committed. */
  const dirty = commit ? git("status", "--porcelain", "-uno") : ""
  if (dirty !== "") {
    throw new Error(`working tree is dirty: commit or stash before cutting a release\n${dirty}`)
  }

  const version = nextVersion(currentVersion(), bump)
  for (const manifest of MANIFESTS) {
    const path = join(repoRoot, manifest)
    writeFileSync(path, setVersion(readFileSync(path, "utf8"), version))
  }
  console.log(`version ${version} written to ${MANIFESTS.length} manifests`)
  if (!commit) return

  git("add", ...MANIFESTS)
  git("commit", "-m", `chore(release): v${version}`)
  git("tag", "-a", `v${version}`, "-m", `v${version}`)
  console.log(
    `committed and tagged v${version}\n\npush to release:\n  git push origin ${git("rev-parse", "--abbrev-ref", "HEAD")} --follow-tags`,
  )
}

if (import.meta.main) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
