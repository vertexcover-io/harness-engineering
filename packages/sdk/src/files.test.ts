import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importModule, parseFrontmatter, runScriptFile } from "./files.ts";

describe("parseFrontmatter", () => {
  test("WS25 — a frontmatter block parses to its mapping", () => {
    const text = "---\nname: demo\ntags: [a, b]\n---\n# Body\n";
    expect(parseFrontmatter(text, "SKILL.md")).toEqual({
      ok: true,
      value: { name: "demo", tags: ["a", "b"] },
    });
  });

  test.each([
    ["text with no frontmatter", "# Body\n", "no frontmatter"],
    ["an unclosed block", "---\nname: demo\n# Body\n", "not closed"],
  ])("WS25 — %s is an error naming the file", (_label, text, message) => {
    const result = parseFrontmatter(text, "/skills/demo/SKILL.md");
    if (result.ok) throw new Error("expected a failure");
    expect(result.error).toContain("/skills/demo/SKILL.md");
    expect(result.error).toContain(message);
  });
});

describe("runScriptFile", () => {
  test("SC42: a module's main gets the given args, sees them in process.argv, and its number is returned", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "script-")), "record.ts");
    await writeFile(
      file,
      "export const main = (argv) => { globalThis.__sc42 = { argv, processArgv: [...process.argv] }; return 4; };\n",
    );
    const saved = process.argv;
    try {
      const result = await runScriptFile(file, ["a", "--b"]);
      expect(result).toEqual({ ok: true, value: 4 });
    } finally {
      process.argv = saved;
    }
    expect(Reflect.get(globalThis, "__sc42")).toEqual({
      argv: ["a", "--b"],
      processArgv: [process.execPath, file, "a", "--b"],
    });
  });
});

describe("importModule", () => {
  test("SC86: an unserved yok: name fails to load, naming it, and is never a missing file", async () => {
    const result = await importModule("yok:nothing");

    if (result.ok) throw new Error("expected a failure");
    expect(result.error.kind).toBe("load-failed");
    expect(result.error.message).toContain("yok:nothing");
  });
});
