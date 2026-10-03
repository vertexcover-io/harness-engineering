#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as z from "zod";
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
  keyVar: "ASANA_API_KEY",
  urlVar: "ASANA_API_URL",
  defaultUrl: "https://app.asana.com/api/1.0",
};
// Only the first 50 comments and attachments are kept; a longer task is cut off there.
const LIMIT = 50;
const TASK_FIELDS =
  "gid,name,notes,completed,permalink_url,assignee.name,tags.name,projects.name,memberships.section.name,due_on,created_at,modified_at";
const STORY_FIELDS = "gid,resource_subtype,text,created_at,created_by.name";
const ATTACHMENT_FIELDS = "gid,name,host,view_url";
const GID_PATTERN = /^\d+$/;
const URL_PATTERNS = [/^\/0\/\d+\/(\d+)(?:\/f)?\/?$/, /\/task\/(\d+)(?:\/f)?\/?$/];

export const parseTaskRef = (input: string): string => {
  const trimmed = input.trim();
  if (GID_PATTERN.test(trimmed)) return trimmed;
  const url = URL.parse(trimmed);
  const gid =
    url?.hostname === "app.asana.com"
      ? URL_PATTERNS.map((pattern) => url.pathname.match(pattern)?.[1]).find(Boolean)
      : undefined;
  if (gid !== undefined) return gid;
  throw new Error(`not an Asana task id or URL: ${input}`);
};

const ErrorBodySchema = z.object({ errors: z.array(z.object({ message: z.string() })) });
const EnvelopeSchema = z.object({
  data: z.unknown(),
  next_page: z.object({ offset: z.string() }).nullish(),
});
type Envelope = z.infer<typeof EnvelopeSchema>;

const get = async (api: Api, path: string, query: Record<string, string>): Promise<Envelope> => {
  const url = new URL(`${api.url}${path}?${new URLSearchParams(query)}`);
  const response = await fetch(url, { headers: { authorization: `Bearer ${api.key}` } });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const messages = ErrorBodySchema.safeParse(body).data?.errors.map((e) => e.message);
    const detail = messages === undefined ? "" : `: ${messages.join("; ")}`;
    throw new Error(`Asana API returned HTTP ${response.status}${detail}`);
  }
  const parsed = EnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new Error(`Asana API returned no data for ${path}`);
  return parsed.data;
};

// The feed mixes comments with system events (assigned, moved, completed), so a page limit
// would drop the newest comments; every page is read before filtering.
const getStories = async (api: Api, gid: string, offset?: string): Promise<unknown[]> => {
  const query = { opt_fields: STORY_FIELDS, limit: "100", ...(offset && { offset }) };
  const page = await get(api, `/tasks/${gid}/stories`, query);
  const rest = page.next_page == null ? [] : await getStories(api, gid, page.next_page.offset);
  return [...z.array(z.unknown()).parse(page.data), ...rest];
};

const StorySchema = z.looseObject({ resource_subtype: z.string() });
const AttachmentSchema = z.looseObject({
  gid: z.string(),
  name: z.string(),
  host: z.string(),
  view_url: z.string().nullish(),
  download_url: z.string().nullish(),
});
type Attachment = z.infer<typeof AttachmentSchema>;

// A file Asana hosts has signed links that grant access to anyone holding them; `asset` fetches
// a fresh one, so they never reach the agent or ticket.json.
const withoutSignedLinks = ({ download_url: _, view_url, ...rest }: Attachment) =>
  rest.host === "asana" || view_url == null ? rest : { ...rest, view_url };

export const fetchTask = async (api: Api, gid: string) => {
  const [task, stories, attachments] = await Promise.all([
    get(api, `/tasks/${gid}`, { opt_fields: TASK_FIELDS }),
    getStories(api, gid),
    get(api, "/attachments", { parent: gid, opt_fields: ATTACHMENT_FIELDS, limit: String(LIMIT) }),
  ]);
  return {
    ...z.record(z.string(), z.unknown()).parse(task.data),
    comments: z
      .array(StorySchema)
      .parse(stories)
      .filter((story) => story.resource_subtype === "comment_added")
      .slice(0, LIMIT),
    attachments: z.array(AttachmentSchema).parse(attachments.data).map(withoutSignedLinks),
  };
};

// The signed link needs no key, and the key must not reach the file host, so it is never sent.
export const downloadAsset = async (api: Api, gid: string, target: Target): Promise<AssetInfo> => {
  if (!GID_PATTERN.test(gid)) throw new Error(`not an Asana attachment id: ${gid}`);
  const path = await targetPath(target);
  const attachment = AttachmentSchema.pick({ host: true, download_url: true }).parse(
    (await get(api, `/attachments/${gid}`, { opt_fields: "host,download_url" })).data,
  );
  if (attachment.host !== "asana" || attachment.download_url == null) {
    throw new Error(`attachment ${gid} is not a file Asana hosts; record it as a reference`);
  }
  const url = new URL(attachment.download_url);
  return downloadFile({ url, headers: {}, path, allowedOrigin: api.allowedOrigin });
};

const USAGE = `usage:
  bun run asana task GID_OR_URL
  bun run asana asset ATTACHMENT_GID --dir DIR --name NAME`;

const runCommand = async (cwd: string, argv: readonly string[]): Promise<unknown> => {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { dir: { type: "string" }, name: { type: "string" } },
  });
  const [command, arg] = positionals;
  if (arg === undefined) throw new Error(USAGE);
  if (command === "task") return fetchTask(await loadApi(cwd, SOURCE), parseTaskRef(arg));
  const { dir, name } = values;
  if (command !== "asset" || dir === undefined || name === undefined) throw new Error(USAGE);
  return downloadAsset(await loadApi(cwd, SOURCE), arg, { dir, name });
};

if (import.meta.main) await runProviderCli(runCommand, process.argv.slice(2));
