#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readProjectEnv, resolveRoot } from "@harness/sdk";
import * as z from "zod";
import { SafeFilenameSchema } from "./ticket.ts";

const DEFAULT_API_URL = "https://api.linear.app/graphql";
// Only the first 50 comments and attachments are read; a longer ticket is cut off there.
const LIMIT = 50;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

export type Api = Readonly<{ url: string; key: string; allowedOrigin?: string }>;

type Json = Record<string, unknown>;

const ISSUE_FIELDS = `
  id identifier title url description priority priorityLabel createdAt updatedAt
  state { name type }
  assignee { name email }
  labels { nodes { name } }
  project { name }
`;

export const parseIssueRef = (input: string): string => {
  const trimmed = input.trim();
  if (KEY_PATTERN.test(trimmed)) return trimmed;
  const fromUrl = URL.parse(trimmed)?.pathname.match(/\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/|$)/);
  if (fromUrl?.[1] !== undefined) return fromUrl[1];
  throw new Error(`not a Linear issue key or URL: ${input}`);
};

export const loadApiKey = async (root: string): Promise<string> => {
  const key = await readProjectEnv(root, "LINEAR_API_KEY");
  if (key === undefined || key === "") {
    throw new Error("LINEAR_API_KEY is not set; add it to the project .env or the environment");
  }
  return key;
};

const graphql = async (api: Api, query: string, variables: Json): Promise<Json> => {
  const response = await fetch(api.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: api.key },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Linear API returned HTTP ${response.status}`);
  const body = (await response.json()) as { data?: Json; errors?: { message: string }[] };
  if (body.errors !== undefined && body.errors.length > 0) {
    throw new Error(`Linear API error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (body.data === undefined) throw new Error("Linear API returned no data");
  return body.data;
};

export const searchIssues = async (api: Api, term: string, limit: number): Promise<unknown[]> => {
  const data = await graphql(
    api,
    `query($term: String!, $first: Int!) {
      searchIssues(term: $term, first: $first) {
        nodes { id identifier title url updatedAt state { name } }
      }
    }`,
    { term, first: limit },
  );
  return (data.searchIssues as { nodes: unknown[] }).nodes;
};

export const fetchIssue = async (api: Api, key: string): Promise<Json> => {
  const data = await graphql(
    api,
    `query($id: String!) {
      issue(id: $id) {
        ${ISSUE_FIELDS}
        comments(first: ${LIMIT}) { nodes { id body createdAt user { name } } }
        attachments(first: ${LIMIT}) { nodes { id title subtitle url sourceType metadata } }
      }
    }`,
    { id: key },
  );
  if (data.issue === null) throw new Error(`Linear issue not found: ${key}`);
  return data.issue as Json;
};

const isLinearHost = (host: string): boolean =>
  host === "linear.app" || host.endsWith(".linear.app");

export const assetHostAllowed = (api: Api, url: string): boolean => {
  const parsed = URL.parse(url);
  if (parsed === null) return false;
  if (parsed.protocol === "https:" && isLinearHost(parsed.hostname.toLowerCase())) return true;
  return api.allowedOrigin !== undefined && parsed.origin === api.allowedOrigin;
};

export type AssetInfo = Readonly<{ path: string; bytes: number; sha256: string; mimeType: string }>;
export type Target = Readonly<{ dir: string; name: string }>;

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const targetPath = async ({ dir, name }: Target): Promise<string> => {
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
const PRIVATE_IPV6 = /^\[(?:::1?|::ffff:.*|f[cd].*|fe[89ab].*)\]$/;

const isPrivateHost = (host: string): boolean =>
  host === "localhost" ||
  host.endsWith(".localhost") ||
  PRIVATE_IPV4.test(host) ||
  PRIVATE_IPV6.test(host);

const assertPublic = (url: URL): void => {
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

export const downloadAsset = async (api: Api, url: string, target: Target): Promise<AssetInfo> => {
  if (!assetHostAllowed(api, url)) throw new Error(`refusing ${url}: not a Linear host`);
  const path = await targetPath(target);
  return save(await fetchFollowing(new URL(url), { authorization: api.key }), path);
};

const USAGE = `usage:
  bun run linear search QUERY [--limit N]
  bun run linear issue KEY_OR_URL
  bun run linear asset URL --dir DIR --name NAME`;

const parseLimit = (value: string | undefined): number => {
  if (value === undefined) return 10;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive whole number, got "${value}"`);
  }
  return limit;
};

const loadApi = async (root: string): Promise<Api> => {
  const override = process.env.LINEAR_API_URL;
  return {
    url: override ?? DEFAULT_API_URL,
    key: await loadApiKey(root),
    ...(override === undefined ? {} : { allowedOrigin: new URL(override).origin }),
  };
};

const runCommand = async (root: string, argv: readonly string[]): Promise<unknown> => {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { limit: { type: "string" }, dir: { type: "string" }, name: { type: "string" } },
  });
  const [command, arg] = positionals;
  if (arg === undefined) throw new Error(USAGE);
  const api = await loadApi(root);
  if (command === "search") return searchIssues(api, arg, parseLimit(values.limit));
  if (command === "issue") return fetchIssue(api, parseIssueRef(arg));
  const { dir, name } = values;
  if (command !== "asset" || dir === undefined || name === undefined) throw new Error(USAGE);
  return downloadAsset(api, arg, { dir, name });
};

const main = async (argv: readonly string[]): Promise<void> => {
  try {
    const root = await resolveRoot(undefined);
    if (!root.ok) throw new Error(root.error);
    console.log(JSON.stringify(await runCommand(root.value, argv)));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
};

if (import.meta.main) await main(process.argv.slice(2));
