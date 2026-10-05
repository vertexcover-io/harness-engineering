import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assetHostAllowed,
  downloadAsset,
  fetchIssue,
  parseIssueRef,
  searchIssues,
} from "./linear.ts";
import { type Api, loadApiKey } from "./ticket.ts";

const ASSET_BYTES = "binary-bytes";
const seen: { auth: (string | null)[]; queries: string[] } = { auth: [], queries: [] };

const respond = (query: string, variables: Record<string, unknown>): unknown => {
  if (query.includes("searchIssues")) {
    return { data: { searchIssues: { nodes: [{ id: "i1", identifier: "ENG-1", title: "T" }] } } };
  }
  if (variables.id === "ENG-404") return { data: { issue: null } };
  if (variables.id === "ENG-500") return { errors: [{ message: "boom" }] };
  return {
    data: {
      issue: {
        id: "i1",
        identifier: "ENG-1",
        title: "T",
        comments: { nodes: [{ id: "c0", body: "body 0" }] },
        attachments: { nodes: [{ id: "a1", url: "u1" }] },
      },
    },
  };
};

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    seen.auth.push(req.headers.get("authorization"));
    const url = new URL(req.url);
    if (url.pathname === "/asset") {
      return new Response(ASSET_BYTES, { headers: { "content-type": "image/png; charset=x" } });
    }
    if (url.pathname === "/redirect") {
      return new Response(null, {
        status: 302,
        headers: { location: url.searchParams.get("to") ?? "" },
      });
    }
    if (url.pathname === "/denied") return new Response("no", { status: 403 });
    const body = (await req.json()) as { query: string; variables: Record<string, unknown> };
    seen.queries.push(body.query);
    if (body.variables.id === "ENG-HTTP") return new Response("down", { status: 502 });
    return Response.json(respond(body.query, body.variables));
  },
});

const base = `http://${server.hostname}:${server.port}`;
const api: Api = { url: `${base}/graphql`, key: "secret-key" };
const dir = mkdtempSync(join(tmpdir(), "linear-"));
const CLI = join(import.meta.dir, "../../../packages/cli/src/index.ts");
const LINEAR = [
  "--no-env-file",
  CLI,
  "orchestrate",
  "script",
  "--skill",
  "ticket-fetcher",
  "scripts/linear.ts",
];

// Async spawn: a sync one would block this process's fake server from answering.
const runCli = async (args: readonly string[], cwd: string) => {
  const { LINEAR_API_KEY: _, ...env } = process.env;
  const child = Bun.spawn(["bun", ...LINEAR, ...args], {
    cwd,
    env: { ...env, LINEAR_API_URL: `${base}/graphql` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
};

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

const makeRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "linear-repo-"));
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  return root;
};

afterAll(() => server.stop(true));

describe("parseIssueRef", () => {
  test("accepts a key", () => expect(parseIssueRef("ENG-123")).toBe("ENG-123"));
  test("accepts a Linear URL", () => {
    expect(parseIssueRef("https://linear.app/acme/issue/ENG-123/some-slug")).toBe("ENG-123");
  });
  test("rejects anything else", () => {
    expect(() => parseIssueRef("nonsense")).toThrow("not a Linear issue key or URL");
    expect(() => parseIssueRef("https://linear.app/acme/projects/x")).toThrow();
  });
});

describe("loadApiKey", () => {
  test("reads the key from the project .env", async () => {
    const root = mkdtempSync(join(tmpdir(), "linear-env-"));
    writeFileSync(join(root, ".env"), "LINEAR_API_KEY=from-file\n");
    expect(await loadApiKey(root, "LINEAR_API_KEY")).toBe("from-file");
  });

  test("from a linked worktree the CLI reads .env in the main checkout, as the doctor does", async () => {
    const main = makeRepo();
    const worktree = join(main, "linked");
    git(main, "worktree", "add", "-q", worktree);
    writeFileSync(join(main, ".env"), "LINEAR_API_KEY=from-main\n");
    const { code } = await runCli(["search", "export"], worktree);
    expect(code).toBe(0);
    expect(seen.auth.at(-1)).toBe("from-main");
  });

  test("from a linked worktree with its own .env the CLI reads that file, not main's", async () => {
    const main = makeRepo();
    const worktree = join(main, "linked");
    git(main, "worktree", "add", "-q", worktree);
    writeFileSync(join(main, ".env"), "LINEAR_API_KEY=from-main\n");
    writeFileSync(join(worktree, ".env"), "LINEAR_API_KEY=from-worktree\n");
    const { code } = await runCli(["search", "export"], worktree);
    expect(code).toBe(0);
    expect(seen.auth.at(-1)).toBe("from-worktree");
  });

  test("throws a clear error when missing", async () => {
    const saved = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      await expect(
        loadApiKey(mkdtempSync(join(tmpdir(), "linear-none-")), "LINEAR_API_KEY"),
      ).rejects.toThrow("LINEAR_API_KEY");
    } finally {
      if (saved !== undefined) process.env.LINEAR_API_KEY = saved;
    }
  });
});

describe("searchIssues", () => {
  test("returns candidate nodes and sends the key", async () => {
    const found = await searchIssues(api, "export", 5);
    expect(found).toEqual([{ id: "i1", identifier: "ENG-1", title: "T" }]);
    expect(seen.auth.at(-1)).toBe("secret-key");
  });
});

describe("fetchIssue", () => {
  test("reads the first 50 comments and attachments in one request", async () => {
    const before = seen.queries.length;
    const issue = await fetchIssue(api, "ENG-1");
    expect(issue).toMatchObject({
      comments: { nodes: [{ id: "c0" }] },
      attachments: { nodes: [{ id: "a1" }] },
    });
    expect(seen.queries.length).toBe(before + 1);
    expect(seen.queries.at(-1)).toContain("comments(first: 50)");
    expect(seen.queries.at(-1)).toContain("attachments(first: 50)");
  });

  test("fails on a missing issue", async () => {
    await expect(fetchIssue(api, "ENG-404")).rejects.toThrow("not found");
  });

  test("fails on a GraphQL error", async () => {
    await expect(fetchIssue(api, "ENG-500")).rejects.toThrow("boom");
  });

  test("fails on an HTTP error and keeps the status", async () => {
    await expect(fetchIssue(api, "ENG-HTTP")).rejects.toThrow("502");
  });
});

// Promises 100 bytes, sends 7, then drops the connection; Bun.serve cannot cut a body short.
const truncating = createServer((socket) => {
  socket.once("data", () => {
    socket.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\npartial");
    setTimeout(() => socket.destroy(), 20);
  });
});
await new Promise<void>((resolve) => truncating.listen(0, "127.0.0.1", resolve));
const truncatingAddress = truncating.address();
if (truncatingAddress === null || typeof truncatingAddress === "string") throw new Error("no port");
const truncatingOrigin = `http://127.0.0.1:${truncatingAddress.port}`;
afterAll(() => truncating.close());

describe("downloadAsset", () => {
  const overridden = { ...api, allowedOrigin: base };

  test("streams bytes to DIR/NAME and reports hash and type", async () => {
    const info = await downloadAsset(overridden, `${base}/asset`, { dir, name: "a.png" });
    expect(info).toEqual({
      path: join(dir, "a.png"),
      bytes: ASSET_BYTES.length,
      sha256: createHash("sha256").update(ASSET_BYTES).digest("hex"),
      mimeType: "image/png",
    });
    expect(readFileSync(join(dir, "a.png"), "utf8")).toBe(ASSET_BYTES);
  });

  test("refuses an existing path and leaves it untouched", async () => {
    writeFileSync(join(dir, "keep.txt"), "original");
    await expect(
      downloadAsset(overridden, `${base}/asset`, { dir, name: "keep.txt" }),
    ).rejects.toThrow("exists");
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("original");
  });

  test.each(["../escape.png", "sub/x.png", ".hidden", ""])(
    "refuses the unsafe name %p before sending a request",
    async (name) => {
      const before = seen.auth.length;
      await expect(downloadAsset(overridden, `${base}/asset`, { dir, name })).rejects.toThrow(
        "unsafe file name",
      );
      expect(seen.auth.length).toBe(before);
    },
  );

  test("refuses a foreign host even with the test override, sending no request", async () => {
    const before = seen.auth.length;
    const target = { dir, name: "evil.bin" };
    await expect(downloadAsset(overridden, "https://evil.example.com/x", target)).rejects.toThrow(
      "not a Linear host",
    );
    await expect(downloadAsset(api, `${base}/asset`, target)).rejects.toThrow("not a Linear host");
    expect(seen.auth.length).toBe(before);
    expect(existsSync(join(dir, "evil.bin"))).toBe(false);
  });

  test("allows Linear hosts over https only", () => {
    expect(assetHostAllowed(api, "https://uploads.linear.app/x")).toBe(true);
    expect(assetHostAllowed(api, "https://linear.app/x")).toBe(true);
    expect(assetHostAllowed(api, "http://uploads.linear.app/x")).toBe(false);
    expect(assetHostAllowed(api, "https://notlinear.app/x")).toBe(false);
    expect(assetHostAllowed(api, "https://linear.app.evil.com/x")).toBe(false);
    expect(assetHostAllowed(overridden, `${base}/asset`)).toBe(true);
  });

  test("fails on an HTTP error without creating the file", async () => {
    await expect(
      downloadAsset(overridden, `${base}/denied`, { dir, name: "denied.bin" }),
    ).rejects.toThrow("403");
    expect(existsSync(join(dir, "denied.bin"))).toBe(false);
  });

  test("a body cut short leaves no partial file behind for the retry to trip on", async () => {
    const cut = { ...api, allowedOrigin: truncatingOrigin };
    const target = { dir, name: "cut.bin" };
    await expect(downloadAsset(cut, `${truncatingOrigin}/x`, target)).rejects.toThrow();
    expect(existsSync(join(dir, "cut.bin"))).toBe(false);
  });
});

const withFetchStub = async (
  replies: readonly Response[],
  run: () => Promise<unknown>,
): Promise<Request[]> => {
  const real = globalThis.fetch;
  const calls: Request[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(String(input instanceof Request ? input.url : input), init));
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error("unexpected extra request");
    return Promise.resolve(reply);
  }) as typeof fetch;
  try {
    await run().catch(() => undefined);
  } finally {
    globalThis.fetch = real;
  }
  return calls;
};

const redirect = (to: string): Response =>
  new Response(null, { status: 302, headers: { location: to } });

describe("redirects", () => {
  const overridden = { ...api, allowedOrigin: base };

  test("downloadAsset refuses a redirect to a loopback address and saves nothing", async () => {
    const hop = `${base}/redirect?to=${encodeURIComponent(`${base}/asset`)}`;
    await expect(downloadAsset(overridden, hop, { dir, name: "r1.bin" })).rejects.toThrow(
      "refusing",
    );
    expect(existsSync(join(dir, "r1.bin"))).toBe(false);
  });

  test("downloadAsset follows a redirect to a public https host without the key", async () => {
    let result: unknown;
    const calls = await withFetchStub(
      [redirect("https://cdn.example.com/signed"), new Response("ok")],
      async () => {
        result = await downloadAsset(api, "https://uploads.linear.app/x", { dir, name: "r2.bin" });
      },
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://uploads.linear.app/x",
      "https://cdn.example.com/signed",
    ]);
    expect(calls[0]?.headers.get("authorization")).toBe("secret-key");
    expect(calls[1]?.headers.get("authorization")).toBeNull();
    expect(result).toMatchObject({ bytes: 2 });
  });

  test.each([
    ["a private address", "https://169.254.169.254/latest"],
    ["plain http", "http://example.com/a"],
  ])("downloadAsset refuses a redirect to %s", async (_label, to) => {
    const calls = await withFetchStub([redirect(to)], async () => {
      await expect(
        downloadAsset(api, "https://uploads.linear.app/x", { dir, name: "r3.bin" }),
      ).rejects.toThrow("refusing");
    });
    expect(calls).toHaveLength(1);
    expect(existsSync(join(dir, "r3.bin"))).toBe(false);
  });

  test("downloadAsset gives up after too many hops", async () => {
    const loop = Array.from({ length: 10 }, () => redirect("https://example.com/next"));
    const calls = await withFetchStub(loop, async () => {
      await expect(
        downloadAsset(api, "https://uploads.linear.app/x", { dir, name: "r5.bin" }),
      ).rejects.toThrow("too many redirects");
    });
    expect(calls.length).toBeLessThan(10);
    expect(existsSync(join(dir, "r5.bin"))).toBe(false);
  });
});

const withKey = () => {
  const root = makeRepo();
  writeFileSync(join(root, ".env"), "LINEAR_API_KEY=cli-key\n");
  return root;
};

describe("SC50: the linear CLI through yok orchestrate script", () => {
  test("search prints the candidates as JSON", async () => {
    const { code, stdout } = await runCli(["search", "export", "--limit", "5"], withKey());
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual([{ id: "i1", identifier: "ENG-1", title: "T" }]);
  });

  test("issue prints the issue with its comments", async () => {
    const { code, stdout } = await runCli(
      ["issue", "https://linear.app/acme/issue/ENG-1/slug"],
      withKey(),
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      identifier: "ENG-1",
      comments: { nodes: [{ id: "c0" }] },
    });
  });

  test("an issue that does not exist exits 1 with the reason on stderr", async () => {
    const { code, stdout, stderr } = await runCli(["issue", "ENG-404"], withKey());
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("not found");
  });

  test.each([
    ["no arguments", []],
    ["search without a query", ["search"]],
    ["asset without --dir and --name", ["asset", "https://uploads.linear.app/x"]],
    ["an unknown command", ["delete", "ENG-1"]],
    ["the removed fetch command", ["fetch", "https://example.com/a", "--dir", ".", "--name", "a"]],
  ])("%s exits 1 with the usage", async (_label, args) => {
    const { code, stderr } = await runCli(args, withKey());
    expect(code).toBe(1);
    expect(stderr).toContain("usage:");
  });

  test.each(["abc", "0", "-3", "2.5"])(
    "search --limit %p exits 1 before any request",
    async (limit) => {
      const before = seen.queries.length;
      const { code, stderr } = await runCli(["search", "export", "--limit", limit], withKey());
      expect(code).toBe(1);
      expect(stderr).toContain("--limit");
      expect(seen.queries.length).toBe(before);
    },
  );
});

describe("SC50: linear CLI downloads through yok orchestrate script", () => {
  test("asset URL --dir DIR --name NAME writes the file and prints its info", async () => {
    const root = withKey();
    const { code, stdout } = await runCli(
      ["asset", `${base}/asset`, "--dir", root, "--name", "cli.png"],
      root,
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      path: join(root, "cli.png"),
      bytes: ASSET_BYTES.length,
      mimeType: "image/png",
    });
    expect(seen.auth.at(-1)).toBe("cli-key");
  });

  test("asset with a name that climbs out of DIR exits 1 and writes nothing", async () => {
    const root = withKey();
    const { code, stderr } = await runCli(
      ["asset", `${base}/asset`, "--dir", root, "--name", "../evil.ts"],
      root,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("unsafe file name");
  });

  test("asset without LINEAR_API_KEY exits 1 naming it", async () => {
    const root = makeRepo();
    const { code, stderr } = await runCli(
      ["asset", `${base}/asset`, "--dir", root, "--name", "a.png"],
      root,
    );
    expect(code).toBe(1);
    expect(stderr).toContain("LINEAR_API_KEY is not set");
  });
});

beforeAll(() => {
  seen.auth.length = 0;
});
