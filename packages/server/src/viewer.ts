import { readFileSync, realpathSync, statSync } from "node:fs";
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
} from "@yok/core";
import type {
  EmitInput,
  IAgentProvider,
  ILogger,
  ITerminalHost,
  NodeRun,
  Result,
  State,
  WorkflowRun,
} from "@yok/sdk";
import { emitRunEvent, NonEmptyStringSchema, runDirOf } from "@yok/sdk";
import { CommentDraftSchema, type Registry } from "@yok/sdk/internal";
import hljs from "highlight.js/lib/common";
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import MarkdownIt, { type Token } from "markdown-it";
import * as z from "zod";
// @ts-expect-error Bun's text import yields the file's source; TypeScript types the module instead.
import ANCHOR_SOURCE from "./anchor.ts" with { type: "text" };
import { lastDelivery, readStateOrNull, scheduleDelivery } from "./delivery.ts";
import VIEWER_HTML from "./viewer.html" with { type: "text" };

const ANCHOR_JS = new Bun.Transpiler({ loader: "ts" }).transformSync(ANCHOR_SOURCE as string);

type EditorTarget = Readonly<{ file: string; line: number | null }>;

export type ViewerDeps = Readonly<{
  openInEditor: (target: EditorTarget) => Result<null>;
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

const isHunkHeader = (line: string): boolean => line.startsWith("@@");

const sideOf = (hunk: readonly string[], dropped: string): readonly string[] =>
  hunk
    .filter((line) => line.charAt(0) !== dropped)
    .map((line) => line.replace(DIFF_MARK, "").trimEnd());

// The file holds either side of a hunk, depending on whether the step has run yet. A side that
// matches in more than one place says nothing about where the hunk is.
const placeHunk = (
  fileLines: readonly string[],
  hunk: readonly string[],
): readonly [number, number] | null => {
  const places = [sideOf(hunk, "-"), sideOf(hunk, "+")].map((side) => {
    const starts = fileLines.flatMap((_, at) =>
      side.length > 0 && side.every((line, k) => fileLines[at + k] === line) ? [at] : [],
    );
    return starts.length === 1 && starts[0] !== undefined
      ? ([starts[0] + 1, starts[0] + side.length] as const)
      : null;
  });
  return places.find((place) => place !== null) ?? null;
};

const highlightDiff = (
  source: string,
  options: Readonly<{ language: string | undefined; fileLines: readonly string[] | null }>,
): string => {
  const lines = source.replace(/\n$/, "").split("\n");
  const body = lines
    .filter((line) => !isHunkHeader(line))
    .map((line) => line.replace(DIFF_MARK, ""));
  const code = body.join("\n");
  const colored = options.language
    ? hljs.highlight(code, { language: options.language, ignoreIllegals: true })
    : hljs.highlightAuto(code, DIFF_GUESSES);
  const coded = splitHighlighted(colored.value)[Symbol.iterator]();
  const rendered = lines.map((line) => {
    if (isHunkHeader(line))
      return `<span class="diff-line hljs-meta">${markdown.utils.escapeHtml(line)}</span>`;
    const mark = DIFF_MARK.test(line) ? line.charAt(0) : "";
    return `<span class="diff-line${DIFF_CLASS[mark] ?? ""}">${mark}${coded.next().value ?? ""}</span>`;
  });
  const bounds = [
    -1,
    ...lines.flatMap((line, at) => (isHunkHeader(line) ? [at] : [])),
    lines.length,
  ];
  const pieces = bounds.slice(0, -1).flatMap((start, k) => {
    const header = start >= 0 ? rendered.slice(start, start + 1) : [];
    const end = bounds[k + 1] ?? lines.length;
    if (end - start <= 1) return header;
    const place = options.fileLines && placeHunk(options.fileLines, lines.slice(start + 1, end));
    const at = place ? ` data-from="${place[0]}" data-to="${place[1]}"` : "";
    return [
      ...header,
      `<span class="hunk"${at}>${rendered.slice(start + 1, end).join("\n")}</span>`,
    ];
  });
  return `${pieces.join("\n")}\n`;
};

const highlight = (code: string, lang: string): string =>
  hljs.getLanguage(lang)
    ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    : "";

const markdown: MarkdownIt = new MarkdownIt({ html: false, linkify: true, highlight });
// Raw HTML stays escaped, but a markdown table cell holds one line, so <br> is the one tag let
// through: it is how a cell breaks a line on GitHub too.
const BR_TAG = /^<br\s*\/?>/i;
markdown.inline.ruler.before("autolink", "br-tag", (state, silent) => {
  const tag = BR_TAG.exec(state.src.slice(state.pos))?.[0];
  if (tag === undefined) return false;
  if (!silent) state.push("hardbreak", "br", 0);
  state.pos += tag.length;
  return true;
});
markdown.core.ruler.push("source-lines", (state) => {
  for (const token of state.tokens) {
    if (token.nesting === 1 && token.map) token.attrSet("data-lines", lineRange(token.map));
  }
  return true;
});

export type RepoFiles = Readonly<{
  read: (path: string) => string | null;
  exists: (path: string) => boolean;
}>;
const NO_REPO: RepoFiles = { read: () => null, exists: () => false };

const REPO_PATH = /^[\w.@-]+(?:\/[\w.@-]+)*\.[A-Za-z0-9]+$/;

const PATH_AT_LINE = /^(.+?)(?::(\d+)(?:-\d+)?)?$/;

const pathOf = (content: string): Readonly<{ path: string; line: string | undefined }> | null => {
  const [, path = "", line] = PATH_AT_LINE.exec(content) ?? [];
  return REPO_PATH.test(path) ? { path, line } : null;
};

const leadingPath = (inline: Token | undefined): string | undefined => {
  const first = inline?.children?.find((child) => child.type !== "text" || child.content.trim());
  return first?.type === "code_inline" ? pathOf(first.content)?.path : undefined;
};

const firstPath = (inline: Token | undefined): string | undefined =>
  inline?.children
    ?.filter((child) => child.type === "code_inline")
    .map((child) => pathOf(child.content)?.path)
    .find((path) => path !== undefined);

// The planning skill's step card starts the line before a diff with the changed file's path. A diff
// without that line changes the file its step's title names; a path elsewhere in prose is a reference.
const fileOf = (tokens: readonly Token[], index: number): string | undefined => {
  const before =
    tokens[index - 1]?.type === "paragraph_close" ? leadingPath(tokens[index - 2]) : undefined;
  if (before) return before;
  const level = (tokens[index]?.level ?? 0) - 1;
  const item = tokens.findLastIndex(
    (t, at) => at < index && t.type === "list_item_open" && t.level === level,
  );
  return item === -1 ? undefined : firstPath(tokens[item + 2]);
};

const languageOf = (path: string): string | undefined => {
  const extension = path.split(".").pop() ?? "";
  return hljs.getLanguage(extension) ? extension : undefined;
};

markdown.renderer.rules.code_inline = (tokens, index, _options, env) => {
  const content = tokens[index]?.content ?? "";
  const target = pathOf(content);
  const repo: RepoFiles = env.repo ?? NO_REPO;
  const html = markdown.utils.escapeHtml;
  if (target === null || !repo.exists(target.path)) return `<code>${html(content)}</code>`;
  const at = target.line ? ` data-line="${target.line}"` : "";
  return `<code data-path="${html(target.path)}"${at}>${html(content)}</code>`;
};

const defaultFence = markdown.renderer.rules.fence;
markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (token === undefined || defaultFence === undefined) return "";
  const lines = token.map ? ` data-lines="${lineRange(token.map)}"` : "";
  const lang = token.info.trim().split(/\s+/)[0];
  if (lang === "mermaid") {
    return `<pre class="mermaid"${lines}>${markdown.utils.escapeHtml(token.content)}</pre>\n`;
  }
  if (lang === "diff") {
    const file = fileOf(tokens, index);
    const repo: RepoFiles = env.repo ?? NO_REPO;
    const text = file ? repo.read(file) : null;
    const fileLines =
      text
        ?.replace(/\n$/, "")
        .split("\n")
        .map((line) => line.trimEnd()) ?? null;
    const fileAttr = file ? ` data-file="${markdown.utils.escapeHtml(file)}"` : "";
    const total = fileLines ? ` data-total="${fileLines.length}"` : "";
    const code = highlightDiff(token.content, { language: file && languageOf(file), fileLines });
    return `<pre${lines}${fileAttr}${total}><code class="language-diff">${code}</code></pre>\n`;
  }
  return defaultFence(tokens, index, options, env, self).replace(/^<pre>/, `<pre${lines}>`);
};

export const renderMarkdown = (source: string, repo: RepoFiles = NO_REPO): string =>
  markdown.render(source, { repo });

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

const MAX_SOURCE_BYTES = 2_000_000;

const resolveRepoPath = (cwd: string, relPath: string): string | null => {
  const root = resolve(cwd);
  const resolved = resolve(root, relPath);
  if (!isInsideDir(root, resolved)) return null;
  try {
    return isInsideDir(realpathSync(root), realpathSync(resolved)) ? resolved : null;
  } catch {
    return null;
  }
};

const repoFiles = (cwd: string): RepoFiles => ({
  exists: (path) => {
    const abs = resolveRepoPath(cwd, path);
    try {
      return abs !== null && statSync(abs).isFile();
    } catch {
      return false;
    }
  },
  read: (path) => {
    const abs = resolveRepoPath(cwd, path);
    if (abs === null) return null;
    try {
      const info = statSync(abs);
      return info.isFile() && info.size <= MAX_SOURCE_BYTES ? readFileSync(abs, "utf8") : null;
    } catch {
      return null;
    }
  },
});

const colorFile = (text: string, path: string): readonly string[] => {
  const language = languageOf(path);
  const body = text.replace(/\n$/, "");
  return splitHighlighted(
    language
      ? hljs.highlight(body, { language, ignoreIllegals: true }).value
      : markdown.utils.escapeHtml(body),
  );
};

const GOTO_EDITORS = new Set(["code", "code-insiders", "cursor", "codium", "windsurf", "positron"]);
const COLON_EDITORS = new Set(["zed", "subl", "sublime_text"]);
const LINE_FLAG_EDITORS = new Set(["idea", "webstorm", "pycharm", "goland", "rider", "clion"]);
const TERMINAL_EDITORS = new Set([
  "vi",
  "vim",
  "nvim",
  "nano",
  "pico",
  "emacs",
  "micro",
  "hx",
  "kak",
]);
const WAIT_FLAGS = new Set(["--wait", "-w"]);

export const editorCommand = ({
  editor,
  file,
  line,
}: Readonly<{ editor: string } & EditorTarget>): readonly string[] | null => {
  const [bin = "", ...args] = editor.trim().split(/\s+/);
  const name = basename(bin);
  if (TERMINAL_EDITORS.has(name)) return null;
  const flags = args.filter((arg) => !WAIT_FLAGS.has(arg));
  if (line === null) return [bin, ...flags, file];
  if (GOTO_EDITORS.has(name)) return [bin, ...flags, "-g", `${file}:${line}`];
  if (COLON_EDITORS.has(name)) return [bin, ...flags, `${file}:${line}`];
  if (LINE_FLAG_EDITORS.has(name)) return [bin, ...flags, "--line", String(line), file];
  return [bin, ...args, file];
};

// The server has no terminal to show, so an editor that needs one cannot be opened from the page.
export const openInEditor = ({
  env,
  file,
  line,
}: Readonly<
  { env: Readonly<Record<string, string | undefined>> } & EditorTarget
>): Result<null> => {
  const editor = env.VISUAL || env.EDITOR;
  if (!editor)
    return { ok: false, error: "no editor: set VISUAL or EDITOR where the yok server starts" };
  const command = editorCommand({ editor, file, line });
  if (command === null) {
    return {
      ok: false,
      error: `${editor} runs in a terminal: set VISUAL to an editor with a window, such as zed or code`,
    };
  }
  Bun.spawn([...command], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  return { ok: true, value: null };
};

const handedOver = (nodeRuns: Readonly<Record<string, NodeRun>>): readonly string[] =>
  Object.values(nodeRuns).flatMap((run) => [
    ...run.artifacts.flatMap((artifact) => ("path" in artifact ? [artifact.path] : [])),
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

type ReadyRun = Extract<ViewedRun, { kind: "ready" }>;

const fileReply = async (c: Context, page: ReadyRun, entry: ArtifactEntry) => {
  const abs = resolveArtifactPath(page.runDir, entry.path);
  if (abs === null || !(await isFile(abs))) return notFound(c);
  if (entry.type === "md") {
    const html = renderMarkdown(await readFile(abs, "utf8"), repoFiles(page.run.cwd));
    return c.json({ ...entry, html });
  }
  if (entry.type === "text") return c.json({ ...entry, text: await readFile(abs, "utf8") });
  if (entry.type === "html" || entry.type === "image") {
    return c.json({ ...entry, raw: `/runs/${page.run.id}/raw/${entry.path}` });
  }
  return c.json(entry);
};

const requireReadyRun = async (c: Context, deps: ViewerDeps): Promise<ReadyRun | Response> => {
  const page = await findViewedRun(deps.registry, c.req.param("id") ?? "");
  if (page.kind === "missing") return notFound(c);
  if (page.kind === "starting") return c.text("run has no name yet", 409);
  return page;
};

const BatchSchema = z.strictObject({ comments: z.array(CommentDraftSchema).min(1).max(50) });
const FollowUpSchema = z.strictObject({ text: z.string().trim().min(1) });
const OpenSchema = z.strictObject({
  path: NonEmptyStringSchema,
  line: z.number().int().positive().optional(),
});

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
      return entry === undefined ? notFound(c) : fileReply(c, page, entry);
    })
    .get("/runs/:id/source", async (c) => {
      const page = await findViewedRun(deps.registry, c.req.param("id"));
      if (page.kind !== "ready") return notFound(c);
      const path = c.req.query("path") ?? "";
      const text = repoFiles(page.run.cwd).read(path);
      if (text === null) return notFound(c);
      const lines = colorFile(text, path);
      const from = Math.max(1, Number(c.req.query("from")) || 1);
      const to = Math.min(lines.length, Number(c.req.query("to")) || lines.length);
      return c.json({ from, to, total: lines.length, lines: lines.slice(from - 1, to) });
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
    .post("/runs/:id/open", async (c) => {
      const page = await requireReadyRun(c, deps);
      if (page instanceof Response) return page;
      const body = OpenSchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.text("invalid open request", 400);
      const { path, line } = body.data;
      const abs = path.startsWith("artifacts/")
        ? resolveArtifactPath(page.runDir, path)
        : resolveRepoPath(page.run.cwd, path);
      if (abs === null || !(await isFile(abs))) return notFound(c);
      try {
        const opened = deps.openInEditor({ file: abs, line: line ?? null });
        return opened.ok ? c.json({ opened: abs }) : c.text(opened.error, 409);
      } catch (error) {
        deps.log.error({ err: error, file: abs }, "the editor did not start");
        return c.text("the editor did not start; the server log has the reason", 500);
      }
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
    openInEditor?: ViewerDeps["openInEditor"];
  }>,
): Promise<Viewer> => {
  const server = bindPreferred(await savedPort(deps.home));
  const port = server.port as number;
  const { registry, providerFor, host, log } = deps;
  const opener = deps.openInEditor ?? ((target) => openInEditor({ ...target, env: process.env }));
  server.reload({
    fetch: viewerRoutes({
      registry,
      providerFor,
      host,
      log,
      port,
      now: () => new Date(),
      openInEditor: opener,
    }).fetch,
  });
  await Bun.write(viewerPortPath(deps.home), String(port));
  deps.log.info({ port }, "viewer listening");
  return { origin: `http://localhost:${port}`, port, stop: () => server.stop() };
};
