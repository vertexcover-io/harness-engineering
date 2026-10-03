import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  addComments,
  addUserReply,
  commentRepliedEvent,
  commentsAddedEvent,
  isInsideDir,
  readComments,
  type WorkflowAgent,
} from "@harness/core";
import type {
  EmitInput,
  IAgentProvider,
  ILogger,
  ITerminalHost,
  NodeRun,
  State,
  WorkflowRun,
} from "@harness/sdk";
import { emitRunEvent, runDirOf } from "@harness/sdk";
import { CommentDraftSchema, type Registry } from "@harness/sdk/internal";
import hljs from "highlight.js/lib/common";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import MarkdownIt from "markdown-it";
import * as z from "zod";
// @ts-expect-error Bun's text import yields the file's source; TypeScript types the module instead.
import ANCHOR_SOURCE from "./anchor.ts" with { type: "text" };
import { lastDelivery, readStateOrNull, scheduleDelivery } from "./delivery.ts";
import VIEWER_HTML from "./viewer.html" with { type: "text" };

const ANCHOR_JS = new Bun.Transpiler({ loader: "ts" }).transformSync(ANCHOR_SOURCE as string);

export type ViewerDeps = Readonly<{
  registry: Registry;
  log: ILogger;
  port: number;
  providerFor: (agent: WorkflowAgent) => IAgentProvider;
  host: ITerminalHost;
  now: () => Date;
}>;
export type FileType = "md" | "html" | "image" | "text" | "binary";
export type ArtifactEntry = Readonly<{ path: string; type: FileType; draft: boolean }>;
export type ViewedRun =
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "starting"; run: WorkflowRun }>
  | Readonly<{ kind: "ready"; run: WorkflowRun; runDir: string }>;
export type Viewer = Readonly<{ origin: string; port: number; stop: () => Promise<void> }>;

const lineRange = (map: readonly [number, number]): string => `${map[0] + 1}-${map[1]}`;

// hljs closes a span only where its token ends, so a comment or string that spans lines leaves
// spans open across "\n"; close them at each line end and reopen them on the next line.
const splitHighlighted = (html: string): readonly string[] => {
  const open: string[] = [];
  return html.split("\n").map((raw) => {
    const reopened = open.join("");
    for (const tag of raw.match(/<span[^>]*>|<\/span>/g) ?? []) {
      if (tag === "</span>") open.pop();
      else open.push(tag);
    }
    return reopened + raw + "</span>".repeat(open.length);
  });
};

const DIFF_MARK = /^[+\- ]/;
// A diff fence names no language. Guessing among every grammar reads TypeScript as PHP or Java,
// so the guess is limited to languages a plan is likely to show.
const DIFF_GUESSES = [
  "typescript",
  "javascript",
  "json",
  "yaml",
  "bash",
  "python",
  "css",
  "xml",
  "markdown",
  "sql",
  "go",
  "rust",
];
const DIFF_CLASS: Readonly<Record<string, string>> = {
  "+": " hljs-addition",
  "-": " hljs-deletion",
};

const highlightDiff = (source: string): string => {
  const lines = source.replace(/\n$/, "").split("\n");
  const isHunk = (line: string): boolean => line.startsWith("@@");
  const body = lines.filter((line) => !isHunk(line)).map((line) => line.replace(DIFF_MARK, ""));
  const coded = splitHighlighted(hljs.highlightAuto(body.join("\n"), DIFF_GUESSES).value)[
    Symbol.iterator
  ]();
  const rendered = lines.map((line) => {
    if (isHunk(line))
      return `<span class="diff-line hljs-meta">${markdown.utils.escapeHtml(line)}</span>`;
    const mark = DIFF_MARK.test(line) ? line.charAt(0) : "";
    return `<span class="diff-line${DIFF_CLASS[mark] ?? ""}">${mark}${coded.next().value ?? ""}</span>`;
  });
  return `${rendered.join("\n")}\n`;
};

const highlight = (code: string, lang: string): string => {
  if (lang === "diff") return highlightDiff(code);
  return hljs.getLanguage(lang)
    ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    : "";
};

const markdown: MarkdownIt = new MarkdownIt({ html: false, linkify: true, highlight });
markdown.core.ruler.push("source-lines", (state) => {
  for (const token of state.tokens) {
    if (token.nesting === 1 && token.map) token.attrSet("data-lines", lineRange(token.map));
  }
  return true;
});

const defaultFence = markdown.renderer.rules.fence;
markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (token === undefined || defaultFence === undefined) return "";
  const lines = token.map ? ` data-lines="${lineRange(token.map)}"` : "";
  if (token.info.trim() === "mermaid") {
    return `<pre class="mermaid"${lines}>${markdown.utils.escapeHtml(token.content)}</pre>\n`;
  }
  return defaultFence(tokens, index, options, env, self).replace(/^<pre>/, `<pre${lines}>`);
};

export const renderMarkdown = (source: string): string => markdown.render(source);

const EXTENSIONS: Readonly<Record<Exclude<FileType, "binary">, readonly string[]>> = {
  md: [".md", ".markdown"],
  html: [".html", ".htm"],
  image: [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"],
  text: [
    ".json",
    ".jsonl",
    ".log",
    ".txt",
    ".yaml",
    ".yml",
    ".ts",
    ".js",
    ".css",
    ".csv",
    ".toml",
    ".sh",
  ],
};

export const fileType = (path: string): FileType => {
  const lower = path.toLowerCase();
  const match = Object.entries(EXTENSIONS).find(([, extensions]) =>
    extensions.some((extension) => lower.endsWith(extension)),
  );
  return (match?.[0] as FileType | undefined) ?? "binary";
};

export const resolveArtifactPath = (runDir: string, relPath: string): string | null => {
  const root = join(resolve(runDir), "artifacts");
  const resolved = resolve(runDir, relPath);
  if (resolved === root || !isInsideDir(root, resolved)) return null;
  // A symlink under artifacts/ can point anywhere, so its real path must stay inside too. A file
  // that does not exist yet has no real path; the route's own existence check answers for it.
  try {
    return isInsideDir(realpathSync(root), realpathSync(resolved)) ? resolved : null;
  } catch {
    return resolved;
  }
};

const handedOver = (nodeRuns: Readonly<Record<string, NodeRun>>): readonly string[] =>
  Object.values(nodeRuns).flatMap((run) => [
    ...run.artifacts.map((artifact) => artifact.path),
    ...handedOver(run.nodes ?? {}),
  ]);

const walk = async (dir: string): Promise<readonly string[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map(async (entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    ),
  );
  return nested.flat();
};

const byListOrder = (a: string, b: string): number => {
  const aNested = a.includes("/");
  const bNested = b.includes("/");
  if (aNested !== bNested) return aNested ? 1 : -1;
  return a < b ? -1 : a > b ? 1 : 0;
};

// The engine writes its own state file and its temp copies beside the artifacts.
const ENGINE_FILES = /^(state\.json|\.state\..*\.tmp)$/;

export const listArtifacts = async (
  runDir: string,
  state: State | null,
): Promise<readonly ArtifactEntry[]> => {
  const artifactsDir = join(runDir, "artifacts");
  const delivered = new Set(state === null ? [] : handedOver(state.nodeRuns));
  const inside = (await walk(artifactsDir)).filter(
    (file) => resolveArtifactPath(runDir, relative(runDir, file).split(sep).join("/")) !== null,
  );
  return inside
    .map((file) => relative(artifactsDir, file).split(sep).join("/"))
    .filter((rel) => !ENGINE_FILES.test(rel))
    .sort(byListOrder)
    .map((rel) => {
      const path = `artifacts/${rel}`;
      return { path, type: fileType(path), draft: !delivered.has(path) };
    });
};

export const findViewedRun = async (registry: Registry, runId: string): Promise<ViewedRun> => {
  const run = await registry.findRun(runId);
  if (run === undefined) return { kind: "missing" };
  if (run.name === null) return { kind: "starting", run };
  return { kind: "ready", run, runDir: runDirOf(run.cwd, run.name) };
};

const hostGuard =
  (port: number): MiddlewareHandler =>
  async (c, next) => {
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    const origin = c.req.header("origin");
    const hostOk = hosts.includes(c.req.header("host") ?? "");
    const originOk = origin === undefined || hosts.some((host) => origin === `http://${host}`);
    if (!hostOk || !originOk) return c.text("forbidden", 403);
    await next();
  };

const notFound = (c: Context) => c.text("not found", 404);

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

const contentType = (path: string): string =>
  fileType(path) === "html" ? "text/html; charset=utf-8" : Bun.file(path).type;

const fileReply = async (c: Context, runId: string, runDir: string, entry: ArtifactEntry) => {
  const abs = resolveArtifactPath(runDir, entry.path);
  if (abs === null || !(await isFile(abs))) return notFound(c);
  if (entry.type === "md")
    return c.json({ ...entry, html: renderMarkdown(await readFile(abs, "utf8")) });
  if (entry.type === "text") return c.json({ ...entry, text: await readFile(abs, "utf8") });
  if (entry.type === "html" || entry.type === "image") {
    return c.json({ ...entry, raw: `/runs/${runId}/raw/${entry.path}` });
  }
  return c.json(entry);
};

type ReadyRun = Extract<ViewedRun, { kind: "ready" }>;

const requireReadyRun = async (c: Context, deps: ViewerDeps): Promise<ReadyRun | Response> => {
  const page = await findViewedRun(deps.registry, c.req.param("id") ?? "");
  if (page.kind === "missing") return notFound(c);
  if (page.kind === "starting") return c.text("run has no name yet", 409);
  return page;
};

const BatchSchema = z.strictObject({ comments: z.array(CommentDraftSchema).min(1).max(50) });
const FollowUpSchema = z.strictObject({ text: z.string().trim().min(1) });

const storeFailure = (c: Context, error: string) =>
  error.startsWith("no comment ") ? notFound(c) : c.text(error, 500);

const logEvent = async (deps: ViewerDeps, page: ReadyRun, event: EmitInput): Promise<void> => {
  const { id, cwd } = page.run;
  const logged = await emitRunEvent({ id, cwd, name: basename(page.runDir) }, event);
  if (!logged.ok) deps.log.error({ runId: id, error: logged.error }, "comment event not logged");
};

const POLL_MS = 1000;

type FilesBody = Readonly<{
  state: "starting" | "ready";
  run: Readonly<{ id: string; name: string | null }>;
  files: readonly ArtifactEntry[];
}>;
type CommentsBody = Readonly<{ comments: readonly unknown[]; delivery: unknown }>;

const filesBody = async (page: Exclude<ViewedRun, { kind: "missing" }>): Promise<FilesBody> => {
  const run = { id: page.run.id, name: page.run.name };
  if (page.kind === "starting") return { state: "starting", run, files: [] };
  const files = await listArtifacts(page.runDir, await readStateOrNull(page.runDir));
  return { state: "ready", run, files };
};

const commentsBody = async (
  page: Exclude<ViewedRun, { kind: "missing" }>,
): Promise<CommentsBody | null> => {
  if (page.kind === "starting") return { comments: [], delivery: null };
  const read = await readComments(page.runDir);
  if (!read.ok) return null;
  return { comments: read.value.comments, delivery: lastDelivery(page.run.id) ?? null };
};

export type AgentStatus = Readonly<{
  state: "starting" | "running" | "waiting" | "stopped";
  reason: string | null;
}>;

const agentStatus = async (
  page: Exclude<ViewedRun, { kind: "missing" }>,
  deps: ViewerDeps,
): Promise<AgentStatus> => {
  if (page.kind === "starting") return { state: "starting", reason: null };
  const { terminal, id } = page.run;
  const pane = terminal === null ? null : deps.host.find(terminal);
  if (pane === null || !(await pane.isAlive())) return { state: "stopped", reason: null };
  const last = lastDelivery(id);
  if (last?.kind === "waiting") return { state: "waiting", reason: last.reason };
  return { state: "running", reason: null };
};

type Stamp = Readonly<{ mtimeMs: number; size: number }>;

const fileStamps = async (
  runDir: string,
  files: readonly ArtifactEntry[],
): Promise<ReadonlyMap<string, Stamp>> => {
  const stamps = await Promise.all(
    files.map(async (file) => {
      const info = await stat(join(runDir, file.path)).catch(() => null);
      return [file.path, { mtimeMs: info?.mtimeMs ?? 0, size: info?.size ?? 0 }] as const;
    }),
  );
  return new Map(stamps);
};

const sameStamp = (a: Stamp | undefined, b: Stamp): boolean =>
  a !== undefined && a.mtimeMs === b.mtimeMs && a.size === b.size;

const sendEvent = (stream: SSEStreamingApi, event: string, data: unknown) =>
  stream.writeSSE({ event, data: JSON.stringify(data) });

const streamRun = async (stream: SSEStreamingApi, deps: ViewerDeps, id: string): Promise<void> => {
  let sentFiles = "";
  let sentComments = "";
  let sentAgent = "";
  // null until the first look at the folder: files already there on connect are not "changed".
  let stamps: ReadonlyMap<string, Stamp> | null = null;
  while (!stream.aborted) {
    const page = await findViewedRun(deps.registry, id);
    if (page.kind === "missing") {
      await stream.sleep(POLL_MS);
      continue;
    }
    const files = await filesBody(page);
    const filesJson = JSON.stringify(files);
    if (filesJson !== sentFiles) {
      sentFiles = filesJson;
      await sendEvent(stream, "files", files);
    }
    if (page.kind === "ready") {
      const now = await fileStamps(page.runDir, files.files);
      for (const [path, stamp] of stamps === null ? [] : now) {
        if (!sameStamp(stamps?.get(path), stamp)) {
          await sendEvent(stream, "file", { path, mtimeMs: stamp.mtimeMs });
        }
      }
      stamps = now;
    }
    const agentJson = JSON.stringify(await agentStatus(page, deps));
    if (agentJson !== sentAgent) {
      sentAgent = agentJson;
      await stream.writeSSE({ event: "agent", data: agentJson });
    }
    const comments = await commentsBody(page);
    const commentsJson = JSON.stringify(comments);
    if (comments !== null && commentsJson !== sentComments) {
      sentComments = commentsJson;
      await sendEvent(stream, "comments", comments);
    }
    await stream.sleep(POLL_MS);
  }
};

export const viewerRoutes = (deps: ViewerDeps) =>
  new Hono()
    .use("*", hostGuard(deps.port))
    .get("/runs/:id", (c) => c.html(VIEWER_HTML as unknown as string))
    .get("/assets/anchor.js", (c) =>
      c.body(ANCHOR_JS, 200, { "content-type": "text/javascript; charset=utf-8" }),
    )
    .get("/runs/:id/files", async (c) => {
      const page = await findViewedRun(deps.registry, c.req.param("id"));
      return page.kind === "missing" ? notFound(c) : c.json(await filesBody(page));
    })
    .get("/runs/:id/stream", async (c) => {
      const id = c.req.param("id");
      if ((await findViewedRun(deps.registry, id)).kind === "missing") return notFound(c);
      return streamSSE(c, (stream) => streamRun(stream, deps, id));
    })
    .get("/runs/:id/file", async (c) => {
      const id = c.req.param("id");
      const page = await findViewedRun(deps.registry, id);
      if (page.kind !== "ready") return notFound(c);
      const relPath = c.req.query("path") ?? "";
      const files = await listArtifacts(page.runDir, await readStateOrNull(page.runDir));
      const entry = files.find((file) => file.path === relPath);
      return entry === undefined ? notFound(c) : fileReply(c, id, page.runDir, entry);
    })
    .get("/runs/:id/raw/*", async (c) => {
      const id = c.req.param("id");
      const page = await findViewedRun(deps.registry, id);
      if (page.kind !== "ready") return notFound(c);
      const relPath = decodeURIComponent(c.req.path.slice(`/runs/${id}/raw/`.length));
      const abs = resolveArtifactPath(page.runDir, relPath);
      if (abs === null || !(await isFile(abs))) return notFound(c);
      return new Response(Bun.file(abs), { headers: { "content-type": contentType(abs) } });
    })
    .get("/runs/:id/comments", async (c) => {
      const page = await requireReadyRun(c, deps);
      if (page instanceof Response) return page;
      const body = await commentsBody(page);
      return body === null ? c.text("comments.json is unreadable", 500) : c.json(body);
    })
    .post("/runs/:id/comments", async (c) => {
      const id = c.req.param("id");
      const page = await requireReadyRun(c, deps);
      if (page instanceof Response) return page;
      const body = BatchSchema.safeParse(await c.req.json().catch(() => null));
      const drafts = body.success ? body.data.comments : [];
      if (
        drafts.length === 0 ||
        drafts.some((d) => resolveArtifactPath(page.runDir, d.file) === null)
      ) {
        return c.text("invalid comments", 400);
      }
      const added = await addComments(page.runDir, drafts, deps.now());
      if (!added.ok) return c.text(added.error, 500);
      await logEvent(deps, page, commentsAddedEvent(added.value));
      void scheduleDelivery(id, deps);
      return c.json({ comments: added.value }, 201);
    })
    .post("/runs/:id/comments/:cid/reply", async (c) => {
      const id = c.req.param("id");
      const page = await requireReadyRun(c, deps);
      if (page instanceof Response) return page;
      const body = FollowUpSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.text("invalid reply", 400);
      const replied = await addUserReply(
        page.runDir,
        c.req.param("cid"),
        body.data.text,
        deps.now(),
      );
      if (!replied.ok) return storeFailure(c, replied.error);
      await logEvent(deps, page, commentRepliedEvent("viewer", replied.value));
      void scheduleDelivery(id, deps);
      return c.json({ comment: replied.value });
    });

export const viewerPortPath = (home: string): string => join(home, "viewer.port");

const savedPort = async (home: string): Promise<number | null> => {
  const text = await readFile(viewerPortPath(home), "utf8").catch(() => "");
  const port = Number.parseInt(text, 10);
  return Number.isInteger(port) && port > 0 ? port : null;
};

const placeholder = (): Response => new Response("starting", { status: 503 });

// The stream stays open and quiet between changes; the default 10-second idle limit would cut it.
const bind = (port: number) =>
  Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 0, fetch: placeholder });

const bindPreferred = (preferred: number | null) => {
  if (preferred === null) return bind(0);
  try {
    return bind(preferred);
  } catch {
    return bind(0);
  }
};

export const startViewer = async (
  deps: Readonly<{
    home: string;
    registry: Registry;
    providerFor: (agent: WorkflowAgent) => IAgentProvider;
    host: ITerminalHost;
    log: ILogger;
  }>,
): Promise<Viewer> => {
  const server = bindPreferred(await savedPort(deps.home));
  const port = server.port as number;
  const { registry, providerFor, host, log } = deps;
  server.reload({
    fetch: viewerRoutes({ registry, providerFor, host, log, port, now: () => new Date() }).fetch,
  });
  await Bun.write(viewerPortPath(deps.home), String(port));
  deps.log.info({ port }, "viewer listening");
  return { origin: `http://localhost:${port}`, port, stop: () => server.stop() };
};
