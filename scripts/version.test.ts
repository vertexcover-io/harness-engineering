import { describe, expect, test } from "bun:test"
import { nextVersion, readVersion, setVersion } from "./version.ts"

describe("nextVersion", () => {
  test("bumps a segment and zeroes the ones below it", () => {
    expect(nextVersion("1.2.3", "patch")).toBe("1.2.4")
    expect(nextVersion("1.2.3", "minor")).toBe("1.3.0")
    expect(nextVersion("1.2.3", "major")).toBe("2.0.0")
  })

  test("takes an explicit version verbatim", () => {
    expect(nextVersion("1.2.3", "2.0.0")).toBe("2.0.0")
    expect(nextVersion("1.2.3", "2.0.0-rc.1")).toBe("2.0.0-rc.1")
  })

  test("rejects an unknown bump", () => {
    expect(() => nextVersion("1.2.3", "sideways")).toThrow()
  })

  test("rejects a current version it cannot parse", () => {
    expect(() => nextVersion("nightly", "patch")).toThrow()
  })
})

describe("readVersion", () => {
  test("finds the version field", () => {
    expect(readVersion('{"version": "1.30.0"}')).toBe("1.30.0")
  })

  test("returns null when there is no version field", () => {
    expect(readVersion('{"name": "harness"}')).toBeNull()
  })
})

describe("setVersion", () => {
  test("rewrites an existing version and leaves the rest of the file alone", () => {
    const source = '{\n  "name": "harness",\n  "version": "1.30.0",\n  "private": true\n}\n'
    expect(setVersion(source, "1.31.0")).toBe(
      '{\n  "name": "harness",\n  "version": "1.31.0",\n  "private": true\n}\n',
    )
  })

  test("inserts a version after the name when the manifest has none", () => {
    const source = '{\n  "name": "harness",\n  "private": true\n}\n'
    expect(setVersion(source, "1.31.0")).toBe(
      '{\n  "name": "harness",\n  "version": "1.31.0",\n  "private": true\n}\n',
    )
  })

  test("rejects a manifest with neither field", () => {
    expect(() => setVersion('{\n  "private": true\n}\n', "1.31.0")).toThrow()
  })
})
