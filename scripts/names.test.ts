import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

// Split so this file never names an old product itself.
const OLD = ["har", "ness"].join("")
const INTERIM = ["yok", "tra"].join("")

const readJson = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(ROOT, file), "utf8"))

const pluginNames = (marketplace: Record<string, unknown>): readonly unknown[] =>
  Array.isArray(marketplace.plugins) ? marketplace.plugins.map((plugin) => plugin?.name) : []

describe("plugin and marketplace names", () => {
  test("SC8: both plugin manifests and both marketplaces name the plugin yok, and the marketplaces are named yok", () => {
    for (const manifest of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
      assert.equal(readJson(manifest).name, "yok", manifest)
    }
    for (const file of [".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json"]) {
      const marketplace = readJson(file)
      assert.equal(marketplace.name, "yok", file)
      assert.deepEqual(pluginNames(marketplace), ["yok"], file)
    }
    const checkScript = readFileSync(join(ROOT, "scripts/check-release-tag.sh"), "utf8")
    assert.match(checkScript, /select\(\.name == "yok"\) \| \.source\.ref/)
  })
})

describe("plugin hooks", () => {
  test("SC9: the plugin ships no hooks file and neither manifest names one", () => {
    assert.equal(existsSync(join(ROOT, "hooks/hooks.json")), false)
    for (const manifest of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]) {
      assert.equal("hooks" in readJson(manifest), false, manifest)
    }
  })
})

const SYMLINK_MODE = "120000"

const trackedTextFiles = (): readonly string[] =>
  execFileSync("git", ["ls-files", "-s"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .flatMap((line) => {
      const [meta = "", path = ""] = line.split("\t")
      return path === "" || meta.startsWith(SYMLINK_MODE) ? [] : [path]
    })
    .filter((path) => !path.startsWith("docs/") && path !== "bun.lock")
    .filter((path) => existsSync(join(ROOT, path)) && lstatSync(join(ROOT, path)).isFile())

const OLD_FORMS = [`@${OLD}/`, `${OLD.toUpperCase()}_`, `.${OLD}/`]
const OLD_WORD = new RegExp(`\\b${OLD}\\b(?!-engineering)`, "i")
// The one place the word means a test rig, not the product.
const GENERIC_USE = { file: "skills/tdd/references/hermetic-e2e.md", phrase: `integration ${OLD}` }

const namesOldProduct = (file: string, line: string): boolean => {
  if (OLD_FORMS.some((form) => line.includes(form))) return true
  if (line.toLowerCase().includes(INTERIM)) return true
  const rest = file === GENERIC_USE.file ? line.replaceAll(GENERIC_USE.phrase, "") : line
  return OLD_WORD.test(rest)
}

const oldNameLines = (file: string): readonly string[] => {
  const text = readFileSync(join(ROOT, file), "utf8")
  if (text.includes("\0")) return []
  return text
    .split("\n")
    .flatMap((line, index) => (namesOldProduct(file, line) ? [`${file}:${index + 1}: ${line.trim()}`] : []))
}

describe("the rename sweep", () => {
  test("SC10: no tracked file outside docs/ and bun.lock still names an old product", () => {
    assert.deepEqual(trackedTextFiles().flatMap(oldNameLines), [])
  })
})
