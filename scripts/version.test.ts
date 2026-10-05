import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import { agreedVersion, nextVersion, readVersion, setRef, setVersion } from "./version.ts"

describe("SC123: nextVersion", () => {
  test("bumps a segment and zeroes the ones below it", () => {
    assert.equal(nextVersion("1.2.3", "patch"), "1.2.4")
    assert.equal(nextVersion("1.2.3", "minor"), "1.3.0")
    assert.equal(nextVersion("1.2.3", "major"), "2.0.0")
  })

  test("takes an explicit version verbatim", () => {
    assert.equal(nextVersion("1.2.3", "2.0.0"), "2.0.0")
    assert.equal(nextVersion("1.2.3", "2.0.0-rc.1"), "2.0.0-rc.1")
  })

  test("rejects an unknown bump", () => {
    assert.throws(() => nextVersion("1.2.3", "sideways"))
  })

  test("rejects a current version it cannot parse", () => {
    assert.throws(() => nextVersion("nightly", "patch"))
  })

  test("rejects an explicit version carrying characters that would corrupt JSON", () => {
    assert.throws(() => nextVersion("1.2.3", '1.3.0-"rc"'))
    assert.throws(() => nextVersion("1.2.3", "1.3.0-rc\\"))
    assert.throws(() => nextVersion("1.2.3", "1.3.0-rc 1"))
  })

  test("still takes a well-formed prerelease and build tag", () => {
    assert.equal(nextVersion("1.2.3", "1.3.0-rc.1"), "1.3.0-rc.1")
    assert.equal(nextVersion("1.2.3", "1.3.0+build.5"), "1.3.0+build.5")
    assert.equal(nextVersion("1.2.3", "1.3.0-rc.1+build.5"), "1.3.0-rc.1+build.5")
  })

  test("--pre-release bumps a stable version and starts it at rc.1", () => {
    assert.equal(nextVersion("1.31.1", "patch", { preRelease: true }), "1.31.2-rc.1")
    assert.equal(nextVersion("1.31.1", "minor", { preRelease: true }), "1.32.0-rc.1")
    assert.equal(nextVersion("1.31.1", "major", { preRelease: true }), "2.0.0-rc.1")
  })

  test("--pre-release alone counts the current pre-release up", () => {
    assert.equal(nextVersion("1.32.0-rc.1", undefined, { preRelease: true }), "1.32.0-rc.2")
    assert.equal(nextVersion("1.32.0-rc.9", undefined, { preRelease: true }), "1.32.0-rc.10")
  })

  test("--pre-release with the bump that produced the pre-release counts it up rather than restarting", () => {
    assert.equal(nextVersion("1.32.0-rc.2", "minor", { preRelease: true }), "1.32.0-rc.3")
    assert.equal(nextVersion("1.32.0-rc.2", "major", { preRelease: true }), "2.0.0-rc.1")
  })

  test("a plain bump from a pre-release ships the version it was a candidate for", () => {
    assert.equal(nextVersion("1.32.0-rc.2", "minor"), "1.32.0")
    assert.equal(nextVersion("1.32.0-rc.2", "patch"), "1.32.0")
    assert.equal(nextVersion("1.32.0-rc.2", "major"), "2.0.0")
    assert.equal(nextVersion("2.0.0-rc.1", "major"), "2.0.0")
    assert.equal(nextVersion("1.31.2-rc.1", "patch"), "1.31.2")
  })

  test("--pre-release alone on a stable version has nothing to count up", () => {
    assert.throws(() => nextVersion("1.31.1", undefined, { preRelease: true }), /major, minor or patch/)
  })

  test("no bump and no --pre-release is a usage error", () => {
    assert.throws(() => nextVersion("1.31.1", undefined), /usage/)
  })

  test("an explicit version and --pre-release together are ambiguous", () => {
    assert.throws(() => nextVersion("1.31.1", "1.32.0", { preRelease: true }), /either/)
  })
})

describe("SC123: agreedVersion", () => {
  test("returns the version every manifest shares", () => {
    assert.equal(agreedVersion(['{"version": "1.30.0"}', '{"version": "1.30.0"}']), "1.30.0")
  })

  test("refuses to bump manifests that have already drifted", () => {
    assert.throws(
      () => agreedVersion(['{"version": "1.30.0"}', '{"version": "1.31.0"}']),
      /drifted/,
    )
  })

  test("lets a manifest with no version field be filled in from the others", () => {
    assert.equal(agreedVersion(['{"version": "1.30.0"}', '{"name": "yok"}']), "1.30.0")
  })

  test("starts at 0.0.0 when no manifest declares a version", () => {
    assert.equal(agreedVersion(['{"name": "yok"}']), "0.0.0")
  })
})

describe("SC123: readVersion", () => {
  test("finds the version field", () => {
    assert.equal(readVersion('{"version": "1.30.0"}'), "1.30.0")
  })

  test("returns null when there is no version field", () => {
    assert.equal(readVersion('{"name": "yok"}'), null)
  })
})

describe("SC123: setVersion", () => {
  test("rewrites an existing version and leaves the rest of the file alone", () => {
    const source = '{\n  "name": "yok",\n  "version": "1.30.0",\n  "private": true\n}\n'
    assert.equal(
      setVersion(source, "1.31.0"),
      '{\n  "name": "yok",\n  "version": "1.31.0",\n  "private": true\n}\n',
    )
  })

  test("inserts a version after the name when the manifest has none", () => {
    const source = '{\n  "name": "yok",\n  "private": true\n}\n'
    assert.equal(
      setVersion(source, "1.31.0"),
      '{\n  "name": "yok",\n  "version": "1.31.0",\n  "private": true\n}\n',
    )
  })

  test("rejects a manifest with neither field", () => {
    assert.throws(() => setVersion('{\n  "private": true\n}\n', "1.31.0"))
  })
})

describe("SC123: setRef", () => {
  test("repins the marketplace to the new tag and leaves the rest of the file alone", () => {
    const source = '{\n  "name": "main",\n  "source": {\n    "repo": "a/b",\n    "ref": "v1.31.1"\n  }\n}\n'
    assert.equal(
      setRef(source, "v1.32.0-rc.1"),
      '{\n  "name": "main",\n  "source": {\n    "repo": "a/b",\n    "ref": "v1.32.0-rc.1"\n  }\n}\n',
    )
  })

  test("rejects a marketplace that pins nothing", () => {
    assert.throws(() => setRef('{\n  "source": "./"\n}\n', "v1.32.0"), /ref/)
  })
})

const repoDir = fileURLToPath(new URL("..", import.meta.url))

const PACKAGE_MANIFESTS = readdirSync(join(repoDir, "packages"))
  .map((name) => `packages/${name}/package.json`)
  .filter((manifest) => existsSync(join(repoDir, manifest)))

const MANIFESTS = ["package.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ...PACKAGE_MANIFESTS]
const MARKETPLACES = [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]
const RELEASE_FILES = ["scripts/version.ts", "scripts/check-release-tag.sh", "bun.lock", ...MANIFESTS, ...MARKETPLACES]

const copyReleaseFiles = (extra: Readonly<Record<string, string>> = {}): string => {
  const copy = mkdtempSync(join(tmpdir(), "release-"))
  RELEASE_FILES.forEach((file) => {
    mkdirSync(dirname(join(copy, file)), { recursive: true })
    cpSync(join(repoDir, file), join(copy, file))
  })
  Object.entries(extra).forEach(([file, text]) => {
    mkdirSync(dirname(join(copy, file)), { recursive: true })
    writeFileSync(join(copy, file), text)
  })
  return copy
}

const releaseScript = (copy: string, ...args: string[]): void => {
  execFileSync(process.execPath, [join(copy, "scripts/version.ts"), ...args], { cwd: copy, stdio: "pipe" })
}

const releaseInCopy = (
  version: string,
  extra: Readonly<Record<string, string>> = {},
): { readonly copy: string; readonly read: (file: string) => string } => {
  const copy = copyReleaseFiles(extra)
  releaseScript(copy, version, "--no-git")
  return { copy, read: (file) => readFileSync(join(copy, file), "utf8") }
}

const checkTag = (copy: string, tag: string): { readonly code: number; readonly stderr: string } => {
  const result = spawnSync("bash", [join(copy, "scripts/check-release-tag.sh"), tag], { encoding: "utf8" })
  return { code: result.status ?? 1, stderr: result.stderr }
}

const EXTRA_PACKAGE = { "packages/extra/package.json": '{\n  "name": "@yok/extra",\n  "version": "0.0.0"\n}\n' }

// A release cut on the wrong runtime once silently did nothing. process.execPath is the runtime
// running this suite, so test:scripts proves the script under Node and test:scripts:bun under Bun.
describe("the release script, run as a command", () => {
  test("SC120: a stable release writes its version to every manifest, a new package included, and pins both marketplaces", () => {
    const { copy, read } = releaseInCopy("99.99.99", EXTRA_PACKAGE)
    ;[...MANIFESTS, "packages/extra/package.json"].forEach((manifest) =>
      assert.match(read(manifest), /"version": "99\.99\.99"/, manifest),
    )
    assert.ok(PACKAGE_MANIFESTS.includes("packages/sdk/package.json"))
    assert.ok(PACKAGE_MANIFESTS.includes("packages/server/package.json"))
    MARKETPLACES.forEach((marketplace) => assert.match(read(marketplace), /"ref": "v99\.99\.99"/, marketplace))
    assert.equal(checkTag(copy, "v99.99.99").code, 0)
  })

  test("SC121: a pre-release pins both marketplaces to its own rc tag, the stable Claude one included", () => {
    const { copy, read } = releaseInCopy("99.99.99-rc.1")
    MARKETPLACES.forEach((marketplace) => assert.match(read(marketplace), /"ref": "v99\.99\.99-rc\.1"/, marketplace))
    assert.equal(checkTag(copy, "v99.99.99-rc.1").code, 0)
  })

  test("SC149: a release writes its version into bun.lock's workspace packages and commits the lock", () => {
    const copy = copyReleaseFiles()
    const git = (...args: string[]): string =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: copy, encoding: "utf8" })
    git("init", "-q", "-b", "main")
    git("add", ".")
    git("commit", "-qm", "init")
    const rootEntry = (lock: string): string => lock.slice(lock.indexOf('"": {'), lock.indexOf('"packages/'))
    const rootBefore = rootEntry(readFileSync(join(copy, "bun.lock"), "utf8"))

    releaseScript(copy, "patch")

    const lock = readFileSync(join(copy, "bun.lock"), "utf8")
    const versions = [...lock.matchAll(/"packages\/[^"]+": \{\n\s+"name": "[^"]+",\n\s+"version": "([^"]*)"/g)]
    assert.equal(versions.length, PACKAGE_MANIFESTS.length)
    versions.forEach(([, version]) => assert.equal(version, "0.0.1"))
    assert.equal(rootEntry(lock), rootBefore)
    assert.match(git("show", "--name-only", "--format=", "HEAD"), /^bun\.lock$/m)
    execFileSync("bun", ["install"], { cwd: copy, stdio: "pipe" })
    assert.equal(readFileSync(join(copy, "bun.lock"), "utf8"), lock)
  })
})

describe("check-release-tag.sh", () => {
  test("SC122: names every manifest and marketplace that disagrees with the tag", () => {
    const { code, stderr } = checkTag(copyReleaseFiles(), "v99.99.99")
    assert.equal(code, 1)
    ;[...MANIFESTS, ...MARKETPLACES].forEach((file) =>
      assert.match(stderr, new RegExp(`^${file.replaceAll(".", "\\.")} `, "m"), file),
    )
  })

  test("SC123: refuses to run without a tag", () => {
    assert.notEqual(checkTag(copyReleaseFiles(), "").code, 0)
  })
})

// Importing this module must not run the release. If the entrypoint check ever
// regresses, `node --test` would cut a tag from inside the test suite.
describe("SC123: module entry", () => {
  test("importing the script does not bump anything", () => {
    assert.equal(process.exitCode ?? 0, 0)
  })
})
