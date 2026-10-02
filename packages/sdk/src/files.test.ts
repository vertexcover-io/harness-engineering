import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "./files.ts";

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
