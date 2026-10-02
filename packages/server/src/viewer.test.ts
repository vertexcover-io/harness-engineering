import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addComments, readComments, replyToComment } from "@harness/core";
import type { State, WorkflowRun } from "@harness/sdk";
import { noopLogger } from "@harness/sdk";
import { createRegistry } from "@harness/sdk/internal";
import { stopDeliveries } from "./delivery.ts";
import { claudeOver, EMPTY_BOX, fakeHost, RULE } from "./fake-host.ts";
import {
  listArtifacts,
  renderMarkdown,
  resolveArtifactPath,
  startViewer,
  viewerRoutes,
} from "./viewer.ts";

const tempDir = (prefix: string): string =>
  realpathSync(mkdtempSync(join(tmpdir(), `harness-${prefix}-`)));

const put = (root: string, rel: string, content: string | Uint8Array): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
};

const runRecord = (id: string, cwd: string, name: string | null): WorkflowRun => ({
  id,
  workflow: "w",
  workflowPath: "/w.yaml",
  inputs: {},
  cwd,
  sessions: [{ agent: "claude", sessionId: "s1" }],
  name,
  terminal: null,
  config: null,
  tier: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const stateWith = (nodeRuns: unknown): State => ({ nodeRuns }) as unknown as State;

const nodeRun = (artifacts: readonly string[], nodes?: Record<string, unknown>) => ({
  nodeRunId: "n",
  nodeType: "exec",
  status: "completed",
  startedAt: null,
  completedAt: null,
  artifacts: artifacts.map((path) => ({ name: path, path })),
  ...(nodes === undefined ? {} : { nodes }),
});

describe("renderMarkdown", () => {
  test("SC1: each block carries the source lines it came from, and raw HTML is escaped", () => {
    const html = renderMarkdown(
      "# Title\n\nfirst\nsecond\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<script>x</script>\n",
    );
    expect(html).toContain('<h1 data-lines="1-1">');
    expect(html).toContain('<p data-lines="3-4">');
    expect(html).toContain('<table data-lines="6-8">');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("SC2: a mermaid fence becomes a diagram block and other fences stay code", () => {
    const html = renderMarkdown("```mermaid\ngraph TD; A-->B\n```\n\n```ts\nconst a = 1;\n```\n");
    expect(html).toContain('class="mermaid"');
    expect(html).toContain("graph TD; A--&gt;B");
    expect(html).toContain('<code class="language-ts">');
    expect(html.match(/class="mermaid"/g)).toHaveLength(1);
  });
});

describe("listArtifacts", () => {
  test("SC3: a file is a draft until a node run hands it over, including inside a loop", async () => {
    const runDir = tempDir("list");
    put(runDir, "artifacts/design.md", "# d");
    put(runDir, "artifacts/notes.md", "# n");
    const state = stateWith({
      loop: nodeRun([], { inner: nodeRun(["artifacts/design.md"]) }),
    });

    const withState = await listArtifacts(runDir, state);
    expect(withState.find((f) => f.path === "artifacts/design.md")?.draft).toBe(false);
    expect(withState.find((f) => f.path === "artifacts/notes.md")?.draft).toBe(true);

    const noState = await listArtifacts(runDir, null);
    expect(noState.every((f) => f.draft)).toBe(true);
  });
});

describe("listArtifacts symlinks", () => {
  test("a symlink that points outside artifacts/ is not listed", async () => {
    const runDir = tempDir("list-link");
    put(runDir, "artifacts/ok.md", "# ok");
    writeFileSync(join(runDir, "secret.txt"), "outside");
    symlinkSync(join(runDir, "secret.txt"), join(runDir, "artifacts", "leak.txt"));
    const files = await listArtifacts(runDir, null);
    expect(files.map((f) => f.path)).toEqual(["artifacts/ok.md"]);
  });
});

describe("resolveArtifactPath", () => {
  test("SC4: a path that leaves the artifacts folder is refused", () => {
    const runDir = "/runs/x/.harness/n";
    expect(resolveArtifactPath(runDir, "artifacts/../state.json")).toBeNull();
    expect(resolveArtifactPath(runDir, "../../etc/passwd")).toBeNull();
    expect(resolveArtifactPath(runDir, "/etc/passwd")).toBeNull();
    expect(resolveArtifactPath(runDir, "artifacts/a.md")).toBe(`${runDir}/artifacts/a.md`);
  });

  test("a symlink under artifacts/ that points outside the run is refused", () => {
    const runDir = tempDir("viewer-link");
    mkdirSync(join(runDir, "artifacts"), { recursive: true });
    writeFileSync(join(runDir, "secret.txt"), "outside");
    symlinkSync(join(runDir, "secret.txt"), join(runDir, "artifacts", "leak.txt"));
    writeFileSync(join(runDir, "artifacts", "ok.md"), "inside");
    expect(resolveArtifactPath(runDir, "artifacts/leak.txt")).toBeNull();
    expect(resolveArtifactPath(runDir, "artifacts/ok.md")).toBe(join(runDir, "artifacts", "ok.md"));
  });
});

// With a screen, r-named gets a live session showing it, so posted comments are really typed.
const setup = async (screen?: string, alive = true) => {
  const cwd = tempDir("viewer-cwd");
  const registry = createRegistry(join(tempDir("viewer-reg"), "registry.json"), noopLogger);
  const named = runRecord("r-named", cwd, "demo");
  await registry.addRun(screen === undefined ? named : { ...named, terminal: "s1" });
  await registry.addRun(runRecord("r-starting", cwd, null));
  await registry.addRun(runRecord("r-empty", cwd, "bare"));
  const { host, calls } = fakeHost(screen ?? "", alive);
  const now = () => new Date("2026-01-01T00:00:00.000Z");
  const app = viewerRoutes({
    registry,
    log: noopLogger,
    port: 4000,
    providerFor: () => claudeOver(host),
    host,
    now,
  });
  const get = (path: string, headers: Record<string, string> = { host: "localhost:4000" }) =>
    app.request(path, { headers });
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { host: "localhost:4000", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { cwd, registry, app, get, post, calls, runDir: join(cwd, ".harness", "demo") };
};

const until = async (check: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 50 && !(await check()); i++) await Bun.sleep(50);
};

const statusesOf = async (runDir: string): Promise<readonly string[]> => {
  const read = await readComments(runDir);
  return read.ok ? read.value.comments.map((c) => c.status) : [];
};

describe("viewer routes", () => {
  test("SC6: the file list shows every artifact with type and draft flag, top-level first", async () => {
    const { get, runDir } = await setup();
    put(runDir, "artifacts/design.md", "# d");
    put(runDir, "artifacts/state.json", "{}");
    put(runDir, "artifacts/history/v1.md", "# v1");
    put(runDir, "artifacts/logs/run.log", "x");
    put(runDir, "artifacts/mockups/login.png", new Uint8Array([1]));

    const body = (await (await get("/runs/r-named/files")).json()) as {
      files: { path: string; type: string }[];
    };

    expect(body.files.map((f) => [f.path, f.type])).toEqual([
      ["artifacts/design.md", "md"],
      ["artifacts/history/v1.md", "md"],
      ["artifacts/logs/run.log", "text"],
      ["artifacts/mockups/login.png", "image"],
    ]);
  });

  test("SC6b: a state.json that does not parse leaves the list standing, all drafts", async () => {
    const { get, runDir } = await setup();
    put(runDir, "artifacts/design.md", "# d");
    put(runDir, "state.json", "{not json");
    const body = (await (await get("/runs/r-named/files")).json()) as {
      files: { draft: boolean }[];
    };
    expect(body.files.map((f) => f.draft)).toEqual([true]);
  });

  test("SC7: an unnamed run is starting, a named one without artifacts is empty, an unknown one is 404", async () => {
    const { get } = await setup();
    expect(((await (await get("/runs/r-starting/files")).json()) as { state: string }).state).toBe(
      "starting",
    );
    const empty = (await (await get("/runs/r-empty/files")).json()) as {
      state: string;
      files: unknown[];
    };
    expect(empty).toMatchObject({ state: "ready", files: [] });
    expect((await get("/runs/r-missing/files")).status).toBe(404);
  });

  test("SC8: a request from another site is refused", async () => {
    const { get } = await setup();
    const evilHost = await get("/runs/r-named/files", { host: "evil.example:4000" });
    const evilOrigin = await get("/runs/r-named/files", {
      host: "localhost:4000",
      origin: "http://evil.example",
    });
    const ok = await get("/runs/r-named/files", { host: "localhost:4000" });
    const okOrigin = await get("/runs/r-named/files", {
      host: "127.0.0.1:4000",
      origin: "http://127.0.0.1:4000",
    });
    expect([evilHost.status, evilOrigin.status, ok.status, okOrigin.status]).toEqual([
      403, 403, 200, 200,
    ]);
    expect(await evilHost.text()).not.toContain("files");
  });

  test("SC9: each file type comes back in the form the page shows", async () => {
    const { get, runDir } = await setup();
    put(runDir, "artifacts/a.md", "# Hi\n");
    put(runDir, "artifacts/b.json", '{"a":1}');
    put(runDir, "artifacts/c.html", "<p>x</p>");
    put(runDir, "artifacts/d.png", new Uint8Array([137, 80]));
    put(runDir, "artifacts/e.bin", new Uint8Array([0]));
    const read = async (name: string) =>
      (await (await get(`/runs/r-named/file?path=artifacts/${name}`)).json()) as Record<
        string,
        string
      >;

    expect((await read("a.md")).html).toContain("<h1");
    expect((await read("b.json")).text).toBe('{"a":1}');
    const c = await read("c.html");
    const d = await read("d.png");
    const e = await read("e.bin");
    expect(c.raw).toBe("/runs/r-named/raw/artifacts/c.html");
    expect((await get(c.raw as string)).headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    expect((await get(d.raw as string)).headers.get("content-type")).toBe("image/png");
    expect([e.html, e.text, e.raw]).toEqual([undefined, undefined, undefined]);
  });

  test("a path outside artifacts, or a missing file, is 404", async () => {
    const { get, runDir } = await setup();
    put(runDir, "state.json", "{}");
    expect((await get("/runs/r-named/file?path=state.json")).status).toBe(404);
    expect((await get("/runs/r-named/file?path=artifacts/../state.json")).status).toBe(404);
    expect((await get("/runs/r-named/file?path=artifacts/none.md")).status).toBe(404);
    expect((await get("/runs/r-named/raw/artifacts/none.html")).status).toBe(404);
  });

  test("the run page is the viewer HTML", async () => {
    const { get } = await setup();
    const res = await get("/runs/r-named");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('id="threads"');
  });
});

describe("startViewer", () => {
  test("SC10: the port survives a restart and moves when it is taken", async () => {
    const home = tempDir("viewer-home");
    const registry = createRegistry(join(home, "registry.json"), noopLogger);
    const { host } = fakeHost("");
    const start = () =>
      startViewer({ home, registry, providerFor: () => claudeOver(host), host, log: noopLogger });

    const first = await start();
    await first.stop();
    const second = await start();
    await second.stop();
    expect(second.port).toBe(first.port);

    const blocker = Bun.serve({
      hostname: "127.0.0.1",
      port: first.port,
      fetch: () => new Response(),
    });
    const third = await start();
    try {
      expect(third.port).not.toBe(first.port);
      expect(readFileSync(join(home, "viewer.port"), "utf8").trim()).toBe(String(third.port));
      expect(third.origin).toBe(`http://localhost:${third.port}`);
    } finally {
      await third.stop();
      await blocker.stop();
    }
  });
});

afterEach(stopDeliveries);

const draft = {
  file: "artifacts/design.md",
  kind: "comment",
  text: "Why one file?",
  anchor: { quote: "one file", before: "a", after: "b", lines: [14, 16], heading: "Approach" },
};

const eventsOf = (runDir: string, type: string): { payload: unknown }[] =>
  readFileSync(join(runDir, "event.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; payload: unknown })
    .filter((event) => event.type === type);

describe("comment routes", () => {
  test("SC25: a posted batch is saved, logged with its places, typed into the session, and bad bodies are refused", async () => {
    const { post, runDir, calls } = await setup(EMPTY_BOX);
    const res = await post("/runs/r-named/comments", {
      comments: [draft, { file: "artifacts/a.md", kind: "global", text: "Ship it" }],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { comments: { id: string }[] };
    expect(body.comments.map((c) => c.id)).toEqual(["c1", "c2"]);
    const added = eventsOf(runDir, "artifact.comment.added");
    expect(added).toHaveLength(1);
    expect(added[0]?.payload).toEqual({
      comments: [
        { id: "c1", ...draft },
        { id: "c2", file: "artifacts/a.md", kind: "global", text: "Ship it" },
      ],
    });
    await until(async () => (await statusesOf(runDir)).every((s) => s === "delivered"));
    expect(await statusesOf(runDir)).toEqual(["delivered", "delivered"]);
    expect(calls.filter((c) => c.startsWith("text:"))).toHaveLength(1);
    expect(calls[0]).toContain("2 new comments");
    const bad = [
      await post("/runs/r-named/comments", { comments: [{ ...draft, kind: "shout" }] }),
      await post("/runs/r-missing/comments", { comments: [draft] }),
      await post("/runs/r-starting/comments", { comments: [draft] }),
      await post("/runs/r-named/comments", { comments: [{ ...draft, file: "../state.json" }] }),
    ];
    expect(bad.map((r) => r.status)).toEqual([400, 404, 409, 400]);
  });

  test("SC31: a user follow-up sends the thread again and is logged", async () => {
    const { post, get, runDir, calls } = await setup(EMPTY_BOX);
    await post("/runs/r-named/comments", { comments: [draft] });
    await until(async () => (await statusesOf(runDir))[0] === "delivered");
    await replyToComment(runDir, "c1", { status: "answered", text: "Because." }, new Date());

    const res = await post("/runs/r-named/comments/c1/reply", { text: "Can we bundle it later?" });

    expect(res.status).toBe(200);
    const typedFollowUp = () =>
      calls.some((c) => c.includes("c1 · reply on its thread: Can we bundle it later?"));
    await until(async () => typedFollowUp() && (await statusesOf(runDir))[0] === "delivered");
    expect(typedFollowUp()).toBe(true);
    expect(await statusesOf(runDir)).toEqual(["delivered"]);
    const listed = (await (await get("/runs/r-named/comments")).json()) as {
      comments: { status: string; thread: { by: string; text: string }[] }[];
    };
    expect(listed.comments[0]?.thread.at(-1)).toMatchObject({
      by: "user",
      text: "Can we bundle it later?",
    });
    expect(eventsOf(runDir, "artifact.comment.replied")[0]?.payload).toMatchObject({
      id: "c1",
      by: "user",
      status: "sent",
      text: "Can we bundle it later?",
    });
    expect((await post("/runs/r-named/comments/c1/reply", { text: "" })).status).toBe(400);
    expect((await post("/runs/r-named/comments/c9/reply", { text: "x" })).status).toBe(404);
  });
});

type SseEvent = { event: string; data: unknown };

const sseReader = (res: Response) => {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const seen: SseEvent[] = [];
  let buffer = "";
  const parse = (chunk: string): void => {
    const event = /^event: (.*)$/m.exec(chunk)?.[1];
    const data = /^data: (.*)$/m.exec(chunk)?.[1];
    if (event !== undefined && data !== undefined) seen.push({ event, data: JSON.parse(data) });
  };
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      chunks.forEach(parse);
    }
  })().catch(() => undefined);
  const waitFor = async (match: (e: SseEvent) => boolean, ms = 3000): Promise<SseEvent> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const hit = seen.find(match);
      if (hit !== undefined) return hit;
      await Bun.sleep(25);
    }
    throw new Error(`no matching event in ${ms}ms; saw ${JSON.stringify(seen)}`);
  };
  return { seen, waitFor, close: () => reader.cancel().then(() => pump) };
};

describe("run stream", () => {
  test("SC30: the stream sends the run's state at once and again when something changes", async () => {
    const { app, registry, cwd } = await setup();
    await registry.addRun(runRecord("r-late", cwd, null));
    const res = await app.request("/runs/r-late/stream", { headers: { host: "localhost:4000" } });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const sse = sseReader(res);
    try {
      await sse.waitFor(
        (e) => e.event === "files" && (e.data as { state: string }).state === "starting",
      );
      await sse.waitFor(
        (e) => e.event === "comments" && (e.data as { comments: unknown[] }).comments.length === 0,
      );

      await registry.initRun("r-late", "late");
      const lateDir = join(cwd, ".harness", "late");
      await sse.waitFor(
        (e) =>
          e.event === "files" &&
          (e.data as { state: string; files: unknown[] }).state === "ready" &&
          (e.data as { files: unknown[] }).files.length === 0,
      );

      put(lateDir, "artifacts/design.md", "# d\n");
      await sse.waitFor(
        (e) =>
          e.event === "files" &&
          (e.data as { files: { path: string }[] }).files.some(
            (f) => f.path === "artifacts/design.md",
          ),
      );

      sse.seen.length = 0;
      put(lateDir, "artifacts/design.md", "# d\nmore\n");
      await sse.waitFor(
        (e) => e.event === "file" && (e.data as { path: string }).path === "artifacts/design.md",
      );

      await addComments(
        lateDir,
        [{ file: "artifacts/design.md", kind: "global", text: "hi" }],
        new Date(),
      );
      await replyToComment(lateDir, "c1", { status: "answered", text: "Because." }, new Date());
      await sse.waitFor(
        (e) => e.event === "comments" && JSON.stringify(e.data).includes("Because."),
      );
    } finally {
      await sse.close();
    }
  }, 20000);
});

describe("agent status on the stream", () => {
  const agentOf = async (
    screen: string | undefined,
    alive: boolean,
    runId: string,
    after?: (s: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  ): Promise<unknown> => {
    const ctx = await setup(screen, alive);
    const res = await ctx.get(`/runs/${runId}/stream`);
    const sse = sseReader(res);
    try {
      await after?.(ctx);
      const want =
        after === undefined
          ? () => true
          : (e: SseEvent) => JSON.stringify(e.data).includes("waiting");
      return (await sse.waitFor((e) => e.event === "agent" && want(e))).data;
    } finally {
      await sse.close();
    }
  };

  test("an unnamed run is starting", async () => {
    expect(await agentOf(undefined, true, "r-starting")).toEqual({
      state: "starting",
      reason: null,
    });
  });

  test("a run with no terminal or a dead session is stopped", async () => {
    expect(await agentOf(undefined, true, "r-named")).toEqual({ state: "stopped", reason: null });
    expect(await agentOf(EMPTY_BOX, false, "r-named")).toEqual({ state: "stopped", reason: null });
  });

  test("a live session is running", async () => {
    expect(await agentOf(EMPTY_BOX, true, "r-named")).toEqual({ state: "running", reason: null });
  });

  test("a live session whose last delivery waits shows the reason", async () => {
    const busyBox = `${RULE}\n❯ half typed\n${RULE}\n  Model: Opus`;
    const data = await agentOf(busyBox, true, "r-named", async ({ post }) => {
      await post("/runs/r-named/comments", {
        comments: [{ file: "artifacts/a.md", kind: "global", text: "hi" }],
      });
    });
    expect(data).toEqual({
      state: "waiting",
      reason: "agent has a menu open or text in its input box",
    });
  });
});

type Anchor = typeof import("./anchor.ts");

// anchor.ts is bundled as text by viewer.ts, so the tests load the code the browser gets.
const loadAnchor = async (): Promise<Anchor> => {
  const { get } = await setup();
  const source = await (await get("/assets/anchor.js")).text();
  return (await import(`data:text/javascript;base64,${btoa(source)}`)) as Anchor;
};

describe("anchor script", () => {
  const text = "retry 3 times here ... retry 3 times there";
  const quote = "retry 3 times";
  const second = text.lastIndexOf(quote);

  test("SC28: a quote is found again by the words around it", async () => {
    const { findQuote } = await loadAnchor();
    expect(findQuote(text, { quote, before: "... ", after: " there" })).toEqual([
      second,
      second + quote.length,
    ]);
    expect(findQuote(text, { quote, before: "", after: " nowhere" })).toEqual([0, quote.length]);
    expect(findQuote("something else", { quote, before: "", after: "" })).toBeNull();
    // Only the words before tell these apart: the second follows "... ".
    const twins = "a retry 3 times x ... retry 3 times x";
    expect(findQuote(twins, { quote, before: "... ", after: " x" })?.[0]).toBe(
      twins.lastIndexOf(quote),
    );
  });

  test("SC29: the words around a quote stop at 32 characters and at the ends of the text", async () => {
    const { quoteContext } = await loadAnchor();
    const long = "x".repeat(200);
    const { before, after } = quoteContext(long, 5, "xx");
    expect(before).toHaveLength(5);
    expect(after).toHaveLength(32);
    const counted = Array.from({ length: 200 }, (_, i) => String.fromCharCode(48 + (i % 40))).join(
      "",
    );
    expect(quoteContext(counted, 100, "xx").before).toBe(counted.slice(68, 100));
  });

  test("SC32: the page script the browser loads matches the tested code", async () => {
    const { get } = await setup();
    const res = await get("/assets/anchor.js");
    expect(res.headers.get("content-type")).toContain("text/javascript");
    const { findQuote, quoteContext } = await loadAnchor();
    expect(findQuote(text, { quote, before: "... ", after: " there" })).toEqual([
      second,
      second + quote.length,
    ]);
    expect(quoteContext(text, 0, "retry")).toEqual({ before: "", after: text.slice(5, 37) });
  });
});
