import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assetName, checksumFor, pickRelease, runUpdate } from "./plugin.ts";

const dirs: string[] = [];
const temp = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const release = (tag: string, assets: readonly string[], extra: Record<string, boolean> = {}) => ({
  tag_name: tag,
  draft: false,
  prerelease: false,
  assets: assets.map((name) => ({ name })),
  ...extra,
});

const ALL = ["yok-darwin-arm64", "yok-darwin-x64", "yok-linux-x64", "yok-linux-arm64"];

describe("release lookup", () => {
  test("SC134: picks the newest non-draft release carrying the asset, pre-releases only when asked", () => {
    const releases = [
      release("v0.0.4", ALL, { draft: true }),
      release("v0.0.3-rc.1", ALL, { prerelease: true }),
      release(
        "v0.0.2",
        ALL.filter((name) => name !== "yok-linux-arm64"),
      ),
      release("v0.0.1", ALL),
    ];
    expect(pickRelease(releases, "yok-darwin-arm64", false)).toBe("v0.0.2");
    expect(pickRelease(releases, "yok-linux-arm64", false)).toBe("v0.0.1");
    expect(pickRelease(releases, "yok-darwin-arm64", true)).toBe("v0.0.3-rc.1");
    expect(pickRelease(releases, "yok-sunos-sparc", true)).toBeNull();
  });

  test("SC135: finds yok-linux-x64's hash by whole name, not yok-linux-x64-baseline's", () => {
    const text = "aaa  yok-linux-x64-baseline\nbbb  yok-linux-x64\n";
    expect(checksumFor(text, "yok-linux-x64")).toBe("bbb");
    expect(checksumFor(text, "yok-darwin-arm64")).toBeNull();
  });

  test("SC136: names the four builds and throws for win32-x64", () => {
    const pairs = [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
    ] as const;
    expect(pairs.map(([os, cpu]) => assetName(os, cpu))).toEqual([
      "yok-darwin-arm64",
      "yok-darwin-x64",
      "yok-linux-arm64",
      "yok-linux-x64",
    ]);
    expect(() => assetName("win32", "x64")).toThrow("no yok build for win32-x64");
  });
});

const ASSET = assetName(process.platform, process.arch);

// A stand-in yok: logs "VERSION ARGS" and exits with `code`.
const fakeYok = (version: string, log: string, code = 0): string =>
  `#!/bin/sh\necho "${version} $*" >> "${log}"\nexit ${code}\n`;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const servers: { stop: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

type Published = Readonly<{ tag: string; script: string; checksum?: string }>;

const serveReleases = (published: Published) => {
  const files: Record<string, string> = {
    [`/download/${published.tag}/${ASSET}`]: published.script,
    [`/download/${published.tag}/checksums.txt`]: `${published.checksum ?? sha256(published.script)}  ${ASSET}\n`,
  };
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/releases") return Response.json([release(published.tag, [ASSET])]);
      const body = files[path];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    },
  });
  servers.push(server);
  return { releasesUrl: `${server.url}releases`, downloadBase: `${server.url}download` };
};

const installed = (log: string) => {
  const execPath = join(temp("yok-update-"), "yok");
  writeFileSync(execPath, fakeYok("0.0.1", log));
  chmodSync(execPath, 0o755);
  return execPath;
};

const logLines = (log: string): readonly string[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];

describe("runUpdate", () => {
  test("SC146: swaps in v0.0.2 and returns the exit code of its plugin install", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const script = fakeYok("0.0.2", log, 3);
    const urls = serveReleases({ tag: "v0.0.2", script });

    const code = await runUpdate({ ...urls, execPath, version: "0.0.1" }, ["claude"], false);

    expect(readFileSync(execPath, "utf8")).toBe(script);
    expect(existsSync(`${execPath}.new`)).toBe(false);
    expect(logLines(log)).toEqual(["0.0.2 plugin install --agent claude"]);
    expect(code).toBe(3);
  });

  test("SC147: keeps the 0.0.1 binary and runs no plugin install when the checksum is wrong", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const before = readFileSync(execPath, "utf8");
    const urls = serveReleases({
      tag: "v0.0.2",
      script: fakeYok("0.0.2", log),
      checksum: "0".repeat(64),
    });
    const errors = spyOn(console, "error").mockImplementation(() => undefined);

    const code = await runUpdate({ ...urls, execPath, version: "0.0.1" }, ["claude"], false);

    const printed = errors.mock.calls.flat();
    errors.mockRestore();
    expect(readFileSync(execPath, "utf8")).toBe(before);
    expect(existsSync(`${execPath}.new`)).toBe(false);
    expect(printed).toContain(`checksum mismatch for ${ASSET}; the installed yok is unchanged`);
    expect(code).toBe(1);
    expect(logLines(log)).toEqual([]);
  });

  test("SC148: on the newest release keeps the binary and still runs its plugin install", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const before = readFileSync(execPath, "utf8");
    const urls = serveReleases({ tag: "v0.0.1", script: before });
    const lines = spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runUpdate({ ...urls, execPath, version: "0.0.1" }, ["claude"], false);

    const printed = lines.mock.calls.flat();
    lines.mockRestore();
    expect(code).toBe(0);
    expect(readFileSync(execPath, "utf8")).toBe(before);
    expect(printed).toContain("yok 0.0.1 is up to date: the newest release is v0.0.1");
    expect(logLines(log)).toEqual(["0.0.1 plugin install --agent claude"]);
  });

  test("on a pre-release newer than the newest stable release keeps the binary", async () => {
    const log = join(temp("yok-log-"), "log");
    const execPath = installed(log);
    const before = readFileSync(execPath, "utf8");
    const urls = serveReleases({ tag: "v0.0.1", script: fakeYok("0.0.1-old", log) });
    const lines = spyOn(console, "log").mockImplementation(() => undefined);

    const code = await runUpdate({ ...urls, execPath, version: "0.0.2-rc.1" }, ["claude"], false);

    const printed = lines.mock.calls.flat();
    lines.mockRestore();
    expect(code).toBe(0);
    expect(readFileSync(execPath, "utf8")).toBe(before);
    expect(printed).toContain("yok 0.0.2-rc.1 is up to date: the newest release is v0.0.1");
  });
});

const CLI = join(import.meta.dir, "index.ts");

// The CLI from source, with a fake claude first on PATH that logs every call.
const fromSource = (args: readonly string[]) => {
  const bin = temp("yok-fake-bin-");
  const log = join(bin, "claude.log");
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$*" >> "${log}"\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const { YOK_CLAUDE_BIN: _claude, YOK_CODEX_BIN: _codex, ...env } = process.env;
  const result = spawnSync("bun", ["--no-env-file", CLI, ...args], {
    encoding: "utf8",
    env: { ...env, PATH: `${bin}:${process.env.PATH}`, YOK_HOME: temp("yok-home-") },
  });
  return { code: result.status, output: result.stdout + result.stderr, calls: logLines(log) };
};

describe("the plugin commands from source", () => {
  test("SC137: yok-dev refuses plugin install and update, points at the checkout and runs no claude", () => {
    const install = fromSource(["plugin", "install", "--agent", "claude"]);
    expect(install.code).toBe(1);
    expect(install.output).toContain("claude --plugin-dir");
    expect(install.calls).toEqual([]);

    const update = fromSource(["update", "--agent", "claude"]);
    expect(update.code).toBe(1);
    expect(update.output).toContain("git pull");
    expect(update.calls).toEqual([]);
  }, 30_000);

  test("SC150: --agent foo is refused by plugin install and by update, before any agent runs", () => {
    for (const command of [["plugin", "install"], ["update"]]) {
      const result = fromSource([...command, "--agent", "foo"]);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("expected claude or codex, got foo");
      expect(result.calls).toEqual([]);
    }
  }, 30_000);
});
