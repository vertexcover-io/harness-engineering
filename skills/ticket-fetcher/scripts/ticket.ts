#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, realpath, rm, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { NonEmptyStringSchema, readProjectEnv } from "@yok/sdk";
import * as z from "zod";

export const SafeFilenameSchema = NonEmptyStringSchema.refine(
  (name) => !/[/\\\0]|^\./.test(name) && !name.includes(".."),
  "Expected one filename with no directory part, no .. and no leading dot",
);

const AssetBaseSchema = z.strictObject({
  id: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  type: z.enum([
    "mockup",
    "screenshot",
    "diagram",
    "recording",
    "document",
    "log",
    "code",
    "data",
    "other",
  ]),
  source: NonEmptyStringSchema,
});

const AssetSchema = z.discriminatedUnion("status", [
  AssetBaseSchema.extend({
    status: z.literal("downloaded"),
    path: SafeFilenameSchema,
    mimeType: NonEmptyStringSchema,
    bytes: z.int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  AssetBaseSchema.extend({ status: z.literal("unavailable"), reason: NonEmptyStringSchema }),
]);

export const TicketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  provider: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
  key: NonEmptyStringSchema,
  url: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  body: z.string(),
  properties: z.record(z.string(), z.json()),
  comments: z.array(
    z.strictObject({
      id: NonEmptyStringSchema,
      body: z.string(),
      author: NonEmptyStringSchema.optional(),
      createdAt: z.iso.datetime().optional(),
    }),
  ),
  references: z.array(
    z.strictObject({ url: NonEmptyStringSchema, kind: NonEmptyStringSchema, context: z.string() }),
  ),
  assets: z.array(AssetSchema),
  complete: z.boolean(),
  fetchedAt: z.iso.datetime(),
});
export type Ticket = z.infer<typeof TicketSchema>;
type Asset = Ticket["assets"][number];

export const TicketFetcherInputSchema = z.strictObject({ request: NonEmptyStringSchema });

export const TicketFetcherOutputSchema = z.strictObject({
  task: NonEmptyStringSchema,
  ticket: z
    .strictObject({
      provider: NonEmptyStringSchema,
      key: NonEmptyStringSchema,
      url: NonEmptyStringSchema,
      path: NonEmptyStringSchema,
      complete: z.boolean(),
    })
    .optional(),
});

export const schemas = {
  "ticket-fetcher.input.v1": TicketFetcherInputSchema,
  "ticket-fetcher.output.v1": TicketFetcherOutputSchema,
};

export type Validation =
  | Readonly<{ ok: true; path: string }>
  | Readonly<{ ok: false; issues: readonly string[] }>;

const readTicketFile = async (path: string): Promise<Ticket | string> => {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text === undefined) return `${path}: cannot read ticket.json`;
  try {
    const parsed = TicketSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : z.prettifyError(parsed.error);
  } catch {
    return `${path}: not valid JSON`;
  }
};

const sha256Of = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

// realDir is the folder's realpath, so a symlink out of it is caught.
const fileIssue = async (realDir: string, asset: Extract<Asset, { status: "downloaded" }>) => {
  const label = `asset ${asset.id} (${asset.path})`;
  const file = await realpath(join(realDir, asset.path)).catch(() => undefined);
  if (file === undefined) return [`${label}: file is missing`];
  if (!file.startsWith(`${realDir}${sep}`)) return [`${label}: file resolves outside the folder`];
  const info = await stat(file);
  if (!info.isFile()) return [`${label}: not a regular file`];
  if (info.size !== asset.bytes) return [`${label}: bytes is ${info.size}, not ${asset.bytes}`];
  return (await sha256Of(file)) === asset.sha256
    ? []
    : [`${label}: sha256 does not match the file`];
};

const duplicatePaths = (paths: readonly string[]): readonly string[] =>
  paths
    .filter((path, index) => paths.indexOf(path) !== index)
    .map((path) => `duplicate asset path ${path}`);

export const validateTicketDir = async (dir: string): Promise<Validation> => {
  const path = join(dir, "ticket.json");
  const ticket = await readTicketFile(path);
  if (typeof ticket === "string") return { ok: false, issues: [ticket] };
  const files = ticket.assets.filter((asset) => asset.status === "downloaded");
  const realDir = await realpath(dir);
  const issues = [
    ...duplicatePaths(files.map((asset) => asset.path)),
    ...(ticket.complete && files.length < ticket.assets.length
      ? ["complete must be false while an asset is unavailable"]
      : []),
    ...(await Promise.all(files.map((asset) => fileIssue(realDir, asset)))).flat(),
  ];
  return issues.length === 0 ? { ok: true, path } : { ok: false, issues };
};

export type AssetInfo = Readonly<{ path: string; bytes: number; sha256: string; mimeType: string }>;
export type Target = Readonly<{ dir: string; name: string }>;

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

export const targetPath = async ({ dir, name }: Target): Promise<string> => {
  const safe = SafeFilenameSchema.safeParse(name);
  if (!safe.success) {
    throw new Error(`unsafe file name ${JSON.stringify(name)}: ${z.prettifyError(safe.error)}`);
  }
  const path = join(dir, name);
  if (await exists(path)) throw new Error(`${path} already exists`);
  return path;
};

const writeStream = async (body: ReadableStream<Uint8Array>, path: string): Promise<string> => {
  const file = await open(path, "wx");
  const hash = createHash("sha256");
  try {
    await body.pipeTo(
      new WritableStream<Uint8Array>({
        write: async (chunk) => {
          hash.update(chunk);
          await file.write(chunk);
        },
      }),
    );
  } finally {
    await file.close();
  }
  return hash.digest("hex");
};

const save = async (response: Response, path: string): Promise<AssetInfo> => {
  if (!response.ok || response.body === null) {
    throw new Error(`download returned HTTP ${response.status}`);
  }
  // A partial file would make the one allowed retry fail with "already exists".
  const sha256 = await writeStream(response.body, path).catch(async (error: unknown) => {
    await rm(path, { force: true });
    throw error;
  });
  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim();
  return {
    path,
    bytes: (await stat(path)).size,
    sha256,
    mimeType: mimeType || "application/octet-stream",
  };
};

// Literal addresses only; a public name that resolves to a private address is not caught.
const PRIVATE_IPV4 = /^(?:0|10|127)\.|^169\.254\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./;
// `::` with at most 32 low bits set covers loopback and IPv4-compatible forms; 64:ff9b:: is NAT64.
const PRIVATE_IPV6 =
  /^\[(?:::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})?)?|::ffff:.*|64:ff9b:.*|f[cd].*|fe[89ab].*)\]$/;

const isPrivateHost = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  PRIVATE_IPV4.test(host) ||
  PRIVATE_IPV6.test(host);

export const assertPublic = (url: URL): void => {
  if (url.protocol !== "https:") throw new Error(`refusing ${url}: only https URLs are fetched`);
  if (isPrivateHost(url.hostname.toLowerCase())) {
    throw new Error(`refusing ${url}: a local or private address`);
  }
};

const MAX_REDIRECTS = 5;

// Each hop is re-checked as a public URL and gets no credentials: only the first request carries them.
const fetchFollowing = async (
  url: URL,
  headers: Record<string, string>,
  hops = 0,
): Promise<Response> => {
  const response = await fetch(url, { headers, redirect: "manual", credentials: "omit" });
  const location = response.headers.get("location");
  if (response.status < 300 || response.status >= 400 || location === null) return response;
  await response.body?.cancel();
  if (hops >= MAX_REDIRECTS) throw new Error(`refusing ${url}: too many redirects`);
  const next = URL.parse(location, url.href);
  if (next === null) throw new Error(`refusing ${url}: invalid redirect to ${location}`);
  assertPublic(next);
  return fetchFollowing(next, {}, hops + 1);
};

export type Download = Readonly<{
  url: URL;
  headers: Record<string, string>;
  path: string;
  allowedOrigin?: string | undefined;
}>;

export const downloadFile = async (download: Download): Promise<AssetInfo> => {
  const { url, headers, path, allowedOrigin } = download;
  if (url.origin !== allowedOrigin) assertPublic(url);
  return save(await fetchFollowing(url, headers), path);
};

// A provider's API. `allowedOrigin` is set only when a test points the provider at a fake
// server, and is the one non-public origin a download may reach.
export type Api = Readonly<{ url: string; key: string; allowedOrigin?: string }>;
export type ApiSource = Readonly<{ keyVar: string; urlVar: string; defaultUrl: string }>;

export const loadApiKey = async (cwd: string, keyVar: string): Promise<string> => {
  const key = await readProjectEnv(cwd, keyVar);
  if (key === undefined || key === "") {
    throw new Error(`${keyVar} is not set; add it to the project .env or the environment`);
  }
  return key;
};

export const loadApi = async (cwd: string, source: ApiSource): Promise<Api> => {
  const override = process.env[source.urlVar];
  return {
    url: override ?? source.defaultUrl,
    key: await loadApiKey(cwd, source.keyVar),
    ...(override === undefined ? {} : { allowedOrigin: new URL(override).origin }),
  };
};

export const runProviderCli = async (
  run: (cwd: string, argv: readonly string[]) => Promise<unknown>,
  argv: readonly string[],
): Promise<void> => {
  try {
    console.log(JSON.stringify(await run(process.cwd(), argv)));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
};

const USAGE = "usage: yok orchestrate script --skill ticket-fetcher scripts/ticket.ts validate DIR";

export const main = async (argv: readonly string[]): Promise<void> => {
  const [command, dir] = argv;
  if (command !== "validate" || dir === undefined) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  const result = await validateTicketDir(dir);
  if (result.ok) return console.log(JSON.stringify(result));
  console.error(JSON.stringify(result.issues, null, 2));
  process.exitCode = 1;
};

if (import.meta.main) await main(process.argv.slice(2));
