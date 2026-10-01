import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, readProjectEnv } from "./files.ts";

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

describe("readProjectEnv", () => {
  const withEnv = async (content: string | null, run: (root: string) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "project-env-"));
    if (content !== null) writeFileSync(join(root, ".env"), content);
    try {
      await run(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("parses plain, exported and quoted values, skipping comments and blanks", async () => {
    const content = ["# note", "", "A=1", "export B=two", 'C="three four"', "D='five'"].join("\n");
    await withEnv(content, async (root) => {
      expect(await readProjectEnv(root, "A")).toBe("1");
      expect(await readProjectEnv(root, "B")).toBe("two");
      expect(await readProjectEnv(root, "C")).toBe("three four");
      expect(await readProjectEnv(root, "D")).toBe("five");
    });
  });

  test("strips an inline comment and expands an escaped newline in a double-quoted value", async () => {
    await withEnv('E=six # note\nF="a\\nb"\n', async (root) => {
      expect(await readProjectEnv(root, "E")).toBe("six");
      expect(await readProjectEnv(root, "F")).toBe("a\nb");
    });
  });

  test("a key the file sets wins over the process environment", async () => {
    process.env.PROJECT_ENV_TEST_KEY = "from-process";
    await withEnv("PROJECT_ENV_TEST_KEY=from-file\n", async (root) => {
      expect(await readProjectEnv(root, "PROJECT_ENV_TEST_KEY")).toBe("from-file");
    });
    delete process.env.PROJECT_ENV_TEST_KEY;
  });

  test("a key the file lacks, or a missing file, falls back to the process environment", async () => {
    process.env.PROJECT_ENV_TEST_KEY = "from-process";
    await withEnv("OTHER=1\n", async (root) => {
      expect(await readProjectEnv(root, "PROJECT_ENV_TEST_KEY")).toBe("from-process");
    });
    await withEnv(null, async (root) => {
      expect(await readProjectEnv(root, "PROJECT_ENV_TEST_KEY")).toBe("from-process");
      expect(await readProjectEnv(root, "PROJECT_ENV_TEST_ABSENT")).toBeUndefined();
    });
    delete process.env.PROJECT_ENV_TEST_KEY;
  });
});
