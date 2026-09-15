import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * An install reports plugin.json's version and the doctor compares it against
 * release tags, so it and package.json must never drift.
 */
const MANIFESTS = ["package.json", ".claude-plugin/plugin.json"]

/**
 * Users install the tag these marketplaces pin. Stable moves only on a stable release; pre-release
 * moves on every release, so a shipped version replaces its candidates there too.
 */
const STABLE_MARKETPLACE = ".claude-plugin/marketplace.json"
const PRE_RELEASE_MARKETPLACE = ".claude-plugin/pre-release/marketplace.json"

const EXPLICIT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SEGMENTS = /^(\d+)\.(\d+)\.(\d+)/
const CANDIDATE = /^(\d+\.\d+\.\d+)-rc\.(\d+)$/
const VERSION_FIELD = /("version":\s*")[^"]*(")/
const NAME_LINE = /("name":\s*"[^"]*",\n)/
const USAGE = "usage: bun run release:version <major|minor|patch|x.y.z> [--pre-release] [--no-git]"

type Options = { readonly preRelease?: boolean }

/**
 * Follows npm's semver.inc: a pre-release is a candidate for its own core, so a bump
 * that core already satisfies ships it instead of skipping past it.
 */
const bumpCore = (current: string, bump: string): string => {
  const segments = current.match(SEGMENTS)
  if (segments === null) throw new Error(`cannot bump "${current}": it is not a semver version`)
  const [major, minor, patch] = segments.slice(1, 4).map(Number) as [number, number, number]
  const candidate = current.length > segments[0].length
  if (bump === "major") return candidate && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`
  if (bump === "minor") return candidate && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`
  if (bump === "patch") return candidate ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`
  throw new Error(`unknown bump "${bump}": use major, minor, patch or an explicit x.y.z`)
}

const nextCandidate = (current: string): string => {
  const candidate = current.match(CANDIDATE)
  if (candidate === null) {
    throw new Error(`${current} is not a pre-release to count up: pass major, minor or patch with --pre-release`)
  }
  return `${candidate[1]}-rc.${Number(candidate[2]) + 1}`
}

export const nextVersion = (current: string, bump: string | undefined, { preRelease = false }: Options = {}): string => {
  if (bump !== undefined && EXPLICIT.test(bump)) {
    if (preRelease) throw new Error("pass either an explicit version or --pre-release, not both")
    return bump
  }
  if (!preRelease) {
    if (bump === undefined) throw new Error(USAGE)
    return bumpCore(current, bump)
  }
  if (bump === undefined) return nextCandidate(current)
  const core = bumpCore(current, bump)
  return current.startsWith(`${core}-`) ? nextCandidate(current) : `${core}-rc.1`
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

const REF_FIELD = /("ref":\s*")[^"]*(")/

export const setRef = (source: string, tag: string): string => {
  if (!REF_FIELD.test(source)) throw new Error('marketplace has no "ref" to pin')
  return source.replace(REF_FIELD, `$1${tag}$2`)
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()

/**
 * Bumping from whichever manifest happened to be read first would renumber a
 * drifted tree down to the lower version and tag it — the failure this script
 * exists to prevent. A manifest with no version field yet is not drift; it gets
 * filled in from the ones that agree.
 */
export const agreedVersion = (sources: readonly string[]): string => {
  const found = sources.map(readVersion).filter((version) => version !== null)
  const distinct = [...new Set(found)]
  if (distinct.length > 1) {
    throw new Error(`manifests have drifted: ${distinct.join(" vs ")} — reconcile them first`)
  }
  return distinct[0] ?? "0.0.0"
}

const currentVersion = (): string =>
  agreedVersion(MANIFESTS.map((manifest) => readFileSync(join(repoRoot, manifest), "utf8")))

const main = (): void => {
  const args = process.argv.slice(2)
  const bump = args.find((arg) => !arg.startsWith("--"))
  const preRelease = args.includes("--pre-release")
  const version = nextVersion(currentVersion(), bump, { preRelease })

  const commit = !args.includes("--no-git")
  /** -uno: untracked files are none of a release's business, only MANIFESTS get committed. */
  const dirty = commit ? git("status", "--porcelain", "-uno") : ""
  if (dirty !== "") {
    throw new Error(`working tree is dirty: commit or stash before cutting a release\n${dirty}`)
  }

  const rewrite = (file: string, update: (source: string) => string): void => {
    const path = join(repoRoot, file)
    writeFileSync(path, update(readFileSync(path, "utf8")))
  }
  const pinned = version.includes("-") ? [PRE_RELEASE_MARKETPLACE] : [STABLE_MARKETPLACE, PRE_RELEASE_MARKETPLACE]
  MANIFESTS.forEach((manifest) => rewrite(manifest, (source) => setVersion(source, version)))
  pinned.forEach((marketplace) => rewrite(marketplace, (source) => setRef(source, `v${version}`)))
  console.log(`version ${version} written to ${MANIFESTS.length} manifests and pinned in ${pinned.join(", ")}`)
  if (!commit) return

  git("add", ...MANIFESTS, ...pinned)
  git("commit", "-m", `chore(release): v${version}`)
  git("tag", "-a", `v${version}`, "-m", `v${version}`)
  console.log(
    `committed and tagged v${version}\n\npush to release:\n  git push origin ${git("rev-parse", "--abbrev-ref", "HEAD")} --follow-tags`,
  )
}

/**
 * `import.meta.main` would be shorter, but Node only grew it in 24.2 — on an
 * older Node it reads undefined and the release silently does nothing at all.
 * Comparing real paths says the same thing on every runtime, and the test file
 * imports this module without tripping it.
 */
const isEntrypoint = (): boolean => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
