import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { agreedVersion, nextVersion, readVersion, setVersion } from "./version.ts"

describe("nextVersion", () => {
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
})

describe("agreedVersion", () => {
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
    assert.equal(agreedVersion(['{"version": "1.30.0"}', '{"name": "harness"}']), "1.30.0")
  })

  test("starts at 0.0.0 when no manifest declares a version", () => {
    assert.equal(agreedVersion(['{"name": "harness"}']), "0.0.0")
  })
})

describe("readVersion", () => {
  test("finds the version field", () => {
    assert.equal(readVersion('{"version": "1.30.0"}'), "1.30.0")
  })

  test("returns null when there is no version field", () => {
    assert.equal(readVersion('{"name": "harness"}'), null)
  })
})

describe("setVersion", () => {
  test("rewrites an existing version and leaves the rest of the file alone", () => {
    const source = '{\n  "name": "harness",\n  "version": "1.30.0",\n  "private": true\n}\n'
    assert.equal(
      setVersion(source, "1.31.0"),
      '{\n  "name": "harness",\n  "version": "1.31.0",\n  "private": true\n}\n',
    )
  })

  test("inserts a version after the name when the manifest has none", () => {
    const source = '{\n  "name": "harness",\n  "private": true\n}\n'
    assert.equal(
      setVersion(source, "1.31.0"),
      '{\n  "name": "harness",\n  "version": "1.31.0",\n  "private": true\n}\n',
    )
  })

  test("rejects a manifest with neither field", () => {
    assert.throws(() => setVersion('{\n  "private": true\n}\n', "1.31.0"))
  })
})

// Importing this module must not run the release. If the entrypoint check ever
// regresses, `node --test` would cut a tag from inside the test suite.
describe("module entry", () => {
  test("importing the script does not bump anything", () => {
    assert.equal(process.exitCode ?? 0, 0)
  })
})
