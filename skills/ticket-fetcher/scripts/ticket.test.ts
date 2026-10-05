import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertPublic,
  TicketFetcherOutputSchema,
  TicketSchema,
  validateTicketDir,
} from "./ticket.ts";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const downloaded = (path: string, text = "hello") => ({
  id: `a-${path}`,
  name: path,
  type: "mockup",
  source: "attachment",
  status: "downloaded",
  path,
  mimeType: "text/plain",
  bytes: Buffer.byteLength(text),
  sha256: sha(text),
});

const unavailable = {
  id: "a-x",
  name: "x.png",
  type: "screenshot",
  source: "attachment",
  status: "unavailable",
  reason: "403",
};

const ticket = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  provider: "linear",
  id: "abc",
  key: "ENG-1",
  url: "https://linear.app/x/issue/ENG-1",
  title: "Add export",
  body: "body",
  properties: { status: "Todo", labels: ["export"] },
  comments: [{ id: "c1", body: "see mockup", author: "Sam", createdAt: "2026-09-30T00:00:00Z" }],
  references: [{ url: "https://example.com", kind: "external", context: "design" }],
  assets: [],
  complete: true,
  fetchedAt: "2026-09-30T00:00:00Z",
  ...overrides,
});

describe("TicketSchema", () => {
  test("SC1: a full ticket with both asset kinds parses", () => {
    const parsed = TicketSchema.safeParse(
      ticket({ assets: [downloaded("m.png"), unavailable], complete: false }),
    );
    expect(parsed.success).toBe(true);
  });

  test.each([
    ["an unknown asset type", { assets: [{ ...downloaded("m.png"), type: "video" }] }],
    ["a bad sha256", { assets: [{ ...downloaded("m.png"), sha256: "abc" }] }],
    ["an unavailable asset carrying a path", { assets: [{ ...unavailable, path: "x.png" }] }],
    [
      "a downloaded asset without bytes",
      { assets: [{ ...downloaded("m.png"), bytes: undefined }] },
    ],
    ["a wrong schemaVersion", { schemaVersion: 2 }],
    ["a non-ISO fetchedAt", { fetchedAt: "yesterday" }],
    ["an unsafe path", { assets: [downloaded("../m.png")] }],
  ])("SC2: rejects %s", (_label, overrides) => {
    expect(TicketSchema.safeParse(ticket(overrides)).success).toBe(false);
  });
});

describe("TicketFetcherOutputSchema", () => {
  test("SC3: task alone is valid, an empty task is not", () => {
    expect(TicketFetcherOutputSchema.safeParse({ task: "do it" }).success).toBe(true);
    expect(TicketFetcherOutputSchema.safeParse({ task: "" }).success).toBe(false);
  });
});

describe("validateTicketDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ticket-"));
  });

  const write = (value: unknown) => writeFileSync(join(dir, "ticket.json"), JSON.stringify(value));

  test("SC4: a good bundle validates", async () => {
    writeFileSync(join(dir, "m.png"), "hello");
    write(ticket({ assets: [downloaded("m.png")] }));
    expect(await validateTicketDir(dir)).toEqual({ ok: true, path: join(dir, "ticket.json") });
  });

  test("SC5: a path that leaves the folder is an issue", async () => {
    write(ticket({ assets: [downloaded("../m.png")] }));
    const result = await validateTicketDir(dir);
    expect(result.ok).toBe(false);
  });

  test("SC6: a missing file is an issue naming it", async () => {
    write(ticket({ assets: [downloaded("m.png")] }));
    const result = await validateTicketDir(dir);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).toContain("m.png");
  });

  test("SC7: a hash mismatch is an issue", async () => {
    writeFileSync(join(dir, "m.png"), "changed");
    write(ticket({ assets: [{ ...downloaded("m.png"), bytes: 7 }] }));
    expect(JSON.stringify(await validateTicketDir(dir))).toContain("sha256");
  });

  test("SC8: a size mismatch is the only issue, since the file is not hashed", async () => {
    writeFileSync(join(dir, "m.png"), "hello!");
    write(ticket({ assets: [downloaded("m.png")] }));
    expect(await validateTicketDir(dir)).toEqual({
      ok: false,
      issues: ["asset a-m.png (m.png): bytes is 6, not 5"],
    });
  });

  test("SC9: duplicate paths are an issue", async () => {
    writeFileSync(join(dir, "m.png"), "hello");
    write(ticket({ assets: [downloaded("m.png"), { ...downloaded("m.png"), id: "other" }] }));
    expect(JSON.stringify(await validateTicketDir(dir))).toContain("duplicate");
  });

  test("SC10: complete true with an unavailable asset is an issue", async () => {
    write(ticket({ assets: [unavailable], complete: true }));
    expect(JSON.stringify(await validateTicketDir(dir))).toContain("complete");
  });

  test("SC11: a symlink pointing outside the folder is an issue", async () => {
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "secret"), "hello");
    symlinkSync(join(outside, "secret"), join(dir, "m.png"));
    write(ticket({ assets: [downloaded("m.png")] }));
    expect((await validateTicketDir(dir)).ok).toBe(false);
  });

  test("SC12: a directory in place of a file is an issue", async () => {
    mkdirSync(join(dir, "m.png"));
    write(ticket({ assets: [downloaded("m.png")] }));
    expect((await validateTicketDir(dir)).ok).toBe(false);
  });

  test("SC13: a missing or malformed ticket.json is an issue", async () => {
    expect((await validateTicketDir(dir)).ok).toBe(false);
    writeFileSync(join(dir, "ticket.json"), "{not json");
    expect((await validateTicketDir(dir)).ok).toBe(false);
  });
});

describe("assertPublic", () => {
  test.each([
    ["IPv6 loopback", "https://[::1]/x"],
    ["IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/x"],
    ["IPv4-compatible loopback", "https://[::7f00:1]/x"],
    ["NAT64 loopback", "https://[64:ff9b::7f00:1]/x"],
    ["unique-local IPv6", "https://[fd00::1]/x"],
    ["link-local IPv4", "https://169.254.169.254/x"],
  ])("refuses %s", (_label, url) => {
    expect(() => assertPublic(new URL(url))).toThrow("a local or private address");
  });

  test("allows a public IPv6 address", () => {
    expect(() => assertPublic(new URL("https://[2606:4700::1111]/x"))).not.toThrow();
  });
});

describe("yok orchestrate script --skill ticket-fetcher scripts/ticket.ts validate", () => {
  const CLI = join(import.meta.dir, "../../../packages/cli/src/index.ts");
  const validate = (dir: string) =>
    spawnSync(
      "bun",
      [
        "--no-env-file",
        CLI,
        "orchestrate",
        "script",
        "--skill",
        "ticket-fetcher",
        "scripts/ticket.ts",
        "validate",
        dir,
      ],
      { encoding: "utf8", env: { ...process.env, YOK_RUN_ID: undefined } },
    );

  test("SC52: a valid bundle prints ok and exits 0, and one listing a missing asset prints its issues and exits 1", () => {
    const good = mkdtempSync(join(tmpdir(), "ticket-"));
    writeFileSync(join(good, "m.png"), "hello");
    writeFileSync(
      join(good, "ticket.json"),
      JSON.stringify(ticket({ assets: [downloaded("m.png")] })),
    );
    const broken = mkdtempSync(join(tmpdir(), "ticket-"));
    writeFileSync(
      join(broken, "ticket.json"),
      JSON.stringify(ticket({ assets: [downloaded("m.png")] })),
    );

    const passed = validate(good);
    const failed = validate(broken);

    expect(passed.status).toBe(0);
    expect(JSON.parse(passed.stdout)).toEqual({ ok: true, path: join(good, "ticket.json") });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("m.png");
  });
});
