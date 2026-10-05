import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadAsset, fetchTask, parseTaskRef } from "./asana.ts";
import type { Api } from "./ticket.ts";

const seen: { auth: (string | null)[]; urls: URL[] } = { auth: [], urls: [] };

const TASK = {
  gid: "222",
  name: "Add export",
  notes: "Export to CSV",
  permalink_url: "https://app.asana.com/1/999/task/222",
};
const STORIES = [
  {
    gid: "s1",
    resource_subtype: "comment_added",
    text: "please hurry",
    created_by: { name: "Ann" },
  },
  { gid: "s2", resource_subtype: "assigned", text: "Ann assigned to Bob" },
];
const LATER_STORIES = [
  { gid: "s3", resource_subtype: "comment_added", text: "the latest decision" },
];
const FULL_PAGE = Array.from({ length: 50 }, (_, i) => ({
  gid: `c${i}`,
  resource_subtype: "comment_added",
  text: `comment ${i}`,
}));
const ATTACHMENTS = [
  {
    gid: "301",
    name: "mockup.png",
    host: "asana",
    view_url: "https://s3.example.com/signed?X-Amz-Signature=secret",
    download_url: "https://s3.example.com/signed?X-Amz-Signature=secret",
  },
  { gid: "302", name: "spec", host: "gdrive", view_url: "https://drive.google.com/d/1" },
];

const server = Bun.serve({
  port: 0,
  fetch(req): Response {
    const url = new URL(req.url);
    seen.auth.push(req.headers.get("authorization"));
    seen.urls.push(url);
    if (url.pathname === "/files/a1")
      return new Response(FILE_BYTES, { headers: { "content-type": "image/png" } });
    if (url.pathname === "/files/hop") {
      return new Response(null, { status: 302, headers: { location: `${base}/files/a1` } });
    }
    if (url.pathname.endsWith("/attachments/502")) return new Response("<html>", { status: 502 });
    if (url.searchParams.get("offset") === "broken") return new Response("down", { status: 503 });
    if (url.pathname.endsWith("/tasks/222/stories") && url.searchParams.get("offset") === "page2") {
      return Response.json({ data: LATER_STORIES, next_page: null });
    }
    const body = routes[url.pathname.replace(/^\/api\/1\.0/, "")];
    if (body !== undefined) return Response.json(body);
    return Response.json({ errors: [{ message: "task: Not a recognized ID" }] }, { status: 404 });
  },
});
afterAll(() => server.stop(true));

const base = `http://${server.hostname}:${server.port}`;
const api: Api = { url: `${base}/api/1.0`, key: "secret-key" };
const local: Api = { ...api, allowedOrigin: base };
const FILE_BYTES = "png-bytes";

const routes: Record<string, unknown> = {
  "/tasks/222": { data: TASK },
  "/tasks/222/stories": { data: STORIES, next_page: { offset: "page2" } },
  "/tasks/223": { data: { ...TASK, gid: "223" } },
  "/tasks/223/stories": { data: FULL_PAGE, next_page: { offset: "broken" } },
  "/attachments": { data: ATTACHMENTS },
  "/attachments/301": {
    data: { gid: "301", name: "mockup.png", host: "asana", download_url: `${base}/files/a1` },
  },
  "/attachments/302": { data: { gid: "302", name: "spec", host: "gdrive", download_url: null } },
  "/attachments/303": { data: { gid: "303", name: "gone.png", host: "asana", download_url: null } },
  "/attachments/304": {
    data: { gid: "304", name: "hop.png", host: "asana", download_url: `${base}/files/hop` },
  },
  "/attachments/200": {},
};

describe("parseTaskRef", () => {
  test.each([
    ["a bare task gid", "1204567890123456", "1204567890123456"],
    ["a legacy project URL", "https://app.asana.com/0/111/222", "222"],
    ["a legacy URL in full-screen mode", "https://app.asana.com/0/111/222/f", "222"],
    ["a project task URL", "https://app.asana.com/1/999/project/111/task/222", "222"],
    ["a workspace task URL with a query", "https://app.asana.com/1/999/task/222?focus=true", "222"],
    ["a task URL in full-screen mode", "https://app.asana.com/1/999/task/222/f", "222"],
  ])("reads %s as its task gid", (_label, input, gid) => {
    expect(parseTaskRef(input)).toBe(gid);
  });

  test.each([
    ["wording", "fix the export"],
    ["a project URL with no task", "https://app.asana.com/0/111/list"],
    ["a task URL on another host", "https://evil.example.com/0/111/222"],
    ["a Linear key", "ENG-123"],
  ])("refuses %s", (_label, input) => {
    expect(() => parseTaskRef(input)).toThrow("not an Asana task id or URL");
  });
});

describe("fetchTask", () => {
  test("returns the task with its comments and attachments, sending the key as a bearer token", async () => {
    const task = await fetchTask(api, "222");
    expect(task).toMatchObject({ ...TASK, comments: [STORIES[0], LATER_STORIES[0]] });
    expect(seen.auth.at(-1)).toBe("Bearer secret-key");
    const attachments = seen.urls.find((url) => url.pathname.endsWith("/attachments"));
    expect(attachments?.searchParams.get("parent")).toBe("222");
    expect(attachments?.searchParams.get("limit")).toBe("50");
  });

  test("50 comments on the first page stop the paging: a broken next page is never requested", async () => {
    const task = await fetchTask(api, "223");
    expect(task.comments).toHaveLength(50);
    expect(seen.urls.some((url) => url.searchParams.get("offset") === "broken")).toBe(false);
  });

  test("keeps signed links out: no download_url, and no view_url for a file Asana hosts", async () => {
    const task = await fetchTask(api, "222");
    expect(task.attachments).toEqual([
      { gid: "301", name: "mockup.png", host: "asana" },
      { gid: "302", name: "spec", host: "gdrive", view_url: "https://drive.google.com/d/1" },
    ]);
    expect(JSON.stringify(task)).not.toContain("X-Amz-Signature");
  });

  test("a task Asana does not know fails with the status and Asana's message", async () => {
    await expect(fetchTask(api, "404")).rejects.toThrow(
      "Asana API returned HTTP 404: task: Not a recognized ID",
    );
  });
});

describe("downloadAsset", () => {
  const dir = mkdtempSync(join(tmpdir(), "asana-assets-"));

  test("looks up a fresh link, saves DIR/NAME, and never sends the key to the file host", async () => {
    const info = await downloadAsset(local, "301", { dir, name: "mockup.png" });
    expect(info).toMatchObject({ path: join(dir, "mockup.png"), bytes: FILE_BYTES.length });
    expect(readFileSync(join(dir, "mockup.png"), "utf8")).toBe(FILE_BYTES);
    expect(seen.urls.at(-1)?.pathname).toBe("/files/a1");
    expect(seen.auth.at(-1)).toBeNull();
  });

  test("refuses an unsafe name before sending any request", async () => {
    const before = seen.urls.length;
    await expect(downloadAsset(local, "301", { dir, name: "../escape.png" })).rejects.toThrow(
      "unsafe file name",
    );
    expect(seen.urls.length).toBe(before);
  });

  test("refuses an attachment id that is not a number before sending any request", async () => {
    const before = seen.urls.length;
    await expect(downloadAsset(local, "../tasks/222", { dir, name: "x.png" })).rejects.toThrow(
      "not an Asana attachment id",
    );
    expect(seen.urls.length).toBe(before);
  });

  test.each([
    ["another service hosts", "302"],
    ["Asana hosts but has no download link", "303"],
  ])("refuses an attachment %s, saving nothing", async (_label, gid) => {
    await expect(downloadAsset(local, gid, { dir, name: `refused-${gid}` })).rejects.toThrow(
      "not a file Asana hosts",
    );
    expect(existsSync(join(dir, `refused-${gid}`))).toBe(false);
  });

  test("refuses a download link that redirects to a local address, saving nothing", async () => {
    await expect(downloadAsset(local, "304", { dir, name: "hop.png" })).rejects.toThrow("refusing");
    expect(existsSync(join(dir, "hop.png"))).toBe(false);
  });

  test.each([
    ["an error page that is not JSON", "502", "Asana API returned HTTP 502"],
    ["a reply with no data", "200", "Asana API returned no data"],
  ])("fails clearly on %s", async (_label, gid, message) => {
    await expect(downloadAsset(local, gid, { dir, name: `bad-${gid}` })).rejects.toThrow(message);
  });

  test("refuses a download link to a local address outside the test override", async () => {
    await expect(downloadAsset(api, "301", { dir, name: "local.png" })).rejects.toThrow("refusing");
    expect(existsSync(join(dir, "local.png"))).toBe(false);
  });
});

const CLI = join(import.meta.dir, "../../../packages/cli/src/index.ts");
const ASANA = ["--no-env-file", CLI, "orchestrate", "skill", "run", "ticket-fetcher.asana-api"];

// Async spawn: a sync one would block this process's fake server from answering.
const runCli = async (args: readonly string[], key: string | null = "cli-key") => {
  const cwd = mkdtempSync(join(tmpdir(), "asana-cli-"));
  if (key !== null) writeFileSync(join(cwd, ".env"), `ASANA_API_KEY=${key}\n`);
  const { ASANA_API_KEY: _, ...env } = process.env;
  const child = Bun.spawn(["bun", ...ASANA, ...args], {
    cwd,
    env: { ...env, ASANA_API_URL: `${base}/api/1.0` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { cwd, code, stdout, stderr };
};

describe("the asana CLI through yok orchestrate skill run", () => {
  test("task URL prints the task with its comments, using the key from .env", async () => {
    const { code, stdout } = await runCli(["task", "https://app.asana.com/0/111/222/f"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      gid: "222",
      comments: [{ gid: "s1" }, { gid: "s3" }],
    });
    expect(seen.auth.at(-1)).toBe("Bearer cli-key");
  });

  test("a task that does not exist exits 1 with the reason on stderr", async () => {
    const { code, stdout, stderr } = await runCli(["task", "404"]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("HTTP 404");
  });

  test("asset GID --dir DIR --name NAME writes the file and prints its info", async () => {
    const dir = mkdtempSync(join(tmpdir(), "asana-cli-out-"));
    const { code, stdout } = await runCli(["asset", "301", "--dir", dir, "--name", "m.png"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ path: join(dir, "m.png"), mimeType: "image/png" });
  });

  test("without ASANA_API_KEY it exits 1 naming it", async () => {
    const { code, stderr } = await runCli(["task", "222"], null);
    expect(code).toBe(1);
    expect(stderr).toContain("ASANA_API_KEY is not set");
  });

  test.each([
    ["no arguments", []],
    ["task without an id", ["task"]],
    ["asset without --dir and --name", ["asset", "301"]],
    ["search, which Asana does not support", ["search", "export"]],
  ])("%s exits 1 with the usage", async (_label, args) => {
    const { code, stderr } = await runCli(args);
    expect(code).toBe(1);
    expect(stderr).toContain("usage:");
  });
});
