#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { NonEmptyStringSchema } from "@harness/sdk";
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

const USAGE = "usage: bun run ticket validate DIR";

const main = async (argv: readonly string[]): Promise<void> => {
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
