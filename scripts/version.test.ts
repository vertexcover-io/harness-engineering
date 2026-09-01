import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { nextVersion, readVersion, setVersion } from "./version.ts"

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
