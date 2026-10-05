#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  type Api,
  type AssetInfo,
  downloadFile,
  loadApi,
  runProviderCli,
  type Target,
  targetPath,
} from "./ticket.ts";

const SOURCE = {
  keyVar: "LINEAR_API_KEY",
  urlVar: "LINEAR_API_URL",
  defaultUrl: "https://api.linear.app/graphql",
};
// Only the first 50 comments and attachments are read; a longer ticket is cut off there.
const LIMIT = 50;
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

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

export const downloadAsset = async (api: Api, url: string, target: Target): Promise<AssetInfo> => {
  if (!assetHostAllowed(api, url)) throw new Error(`refusing ${url}: not a Linear host`);
  return downloadFile({
    url: new URL(url),
    headers: { authorization: api.key },
    path: await targetPath(target),
    allowedOrigin: api.allowedOrigin,
  });
};

const USAGE = `usage:
  linear.ts search QUERY [--limit N]
  linear.ts issue KEY_OR_URL
  linear.ts asset URL --dir DIR --name NAME`;

const parseLimit = (value: string | undefined): number => {
  if (value === undefined) return 10;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive whole number, got "${value}"`);
  }
  return limit;
};

const runCommand = async (cwd: string, argv: readonly string[]): Promise<unknown> => {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { limit: { type: "string" }, dir: { type: "string" }, name: { type: "string" } },
  });
  const [command, arg] = positionals;
  if (arg === undefined) throw new Error(USAGE);
  const api = await loadApi(cwd, SOURCE);
  if (command === "search") return searchIssues(api, arg, parseLimit(values.limit));
  if (command === "issue") return fetchIssue(api, parseIssueRef(arg));
  const { dir, name } = values;
  if (command !== "asset" || dir === undefined || name === undefined) throw new Error(USAGE);
  return downloadAsset(api, arg, { dir, name });
};

export const main = (argv: readonly string[]): Promise<void> => runProviderCli(runCommand, argv);

if (import.meta.main) await main(process.argv.slice(2));
