import { chmod, rename, writeFile } from "node:fs/promises";
import { Command, InvalidArgumentError, Option } from "@commander-js/extra-typings";
import {
  agentBinary,
  installPlugin,
  type WorkflowAgent,
  WorkflowAgentSchema,
  YOK_REPO,
} from "@yok/core";
import { execWithTimeout, spawnInteractive } from "@yok/sdk";
import { isCompiled, VERSION } from "@yok/sdk/internal";
import * as z from "zod";
import { fail } from "./client.ts";

const PLATFORMS: Readonly<Record<string, string>> = { darwin: "darwin", linux: "linux" };
const ARCHES: Readonly<Record<string, string>> = { arm64: "arm64", x64: "x64" };

export const assetName = (platform: string, arch: string): string => {
  const os = PLATFORMS[platform];
  const cpu = ARCHES[arch];
  if (os === undefined || cpu === undefined) {
    throw new Error(`no yok build for ${platform}-${arch}`);
  }
  return `yok-${os}-${cpu}`;
};

const ReleasesSchema = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
    assets: z.array(z.object({ name: z.string() })),
  }),
);

// GitHub lists releases newest first, so the first match is the newest.
export const pickRelease = (
  releasesJson: unknown,
  asset: string,
  preRelease: boolean,
): string | null =>
  ReleasesSchema.parse(releasesJson).find(
    (r) => !r.draft && (preRelease || !r.prerelease) && r.assets.some((a) => a.name === asset),
  )?.tag_name ?? null;

// checksums.txt is `shasum -a 256` output: "HASH  NAME" per line.
export const checksumFor = (checksums: string, asset: string): string | null =>
  checksums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0] ?? null;

// The custom parser replaces the one `.choices()` installs, so it validates the value itself.
const parseAgent = (
  value: string,
  previous: readonly WorkflowAgent[] = [],
): readonly WorkflowAgent[] => {
  const agent = WorkflowAgentSchema.safeParse(value);
  if (!agent.success) {
    throw new InvalidArgumentError(
      `expected ${WorkflowAgentSchema.options.join(" or ")}, got ${value}`,
    );
  }
  return [...previous, agent.data];
};

const agentOption = () =>
  new Option("--agent <name>", "claude or codex; repeat for both")
    .argParser(parseAgent)
    .makeOptionMandatory();

const DEV_PLUGIN = "yok-dev loads the plugin from this checkout: claude --plugin-dir PATH_TO_REPO";
const DEV_UPDATE = "yok-dev is this checkout: run git pull";

const installAll = async (agents: readonly WorkflowAgent[]): Promise<void> => {
  for (const agent of agents) {
    const binary = agentBinary(agent, process.env);
    const exec = execWithTimeout(120_000);
    const result = await installPlugin(agent, binary, VERSION, exec, process.cwd());
    if (!result.ok) return fail(result.error);
    console.log(result.value);
  }
};

export const pluginCommand = () =>
  new Command("plugin").description("Manage the yok agent plugin").addCommand(
    new Command("install")
      .description("Install the plugin at this binary's version, or move an installed one to it")
      .addOption(agentOption())
      .action(async ({ agent }) => (isCompiled ? installAll(agent) : fail(DEV_PLUGIN))),
  );

const download = async (url: string): Promise<Uint8Array> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

export type UpdateTarget = Readonly<{
  execPath: string;
  releasesUrl: string;
  downloadBase: string;
  version: string;
}>;

const GITHUB: Omit<UpdateTarget, "execPath" | "version"> = {
  releasesUrl: `https://api.github.com/repos/${YOK_REPO}/releases?per_page=30`,
  downloadBase: `https://github.com/${YOK_REPO}/releases/download`,
};

// Returns the problem, or null once the new binary is in place. Nothing is written on a mismatch.
const replaceBinary = async (
  target: UpdateTarget,
  tag: string,
  asset: string,
): Promise<string | null> => {
  const base = `${target.downloadBase}/${tag}`;
  const [binary, checksums] = await Promise.all([
    download(`${base}/${asset}`),
    download(`${base}/checksums.txt`).then((bytes) => new TextDecoder().decode(bytes)),
  ]);
  if (checksumFor(checksums, asset) !== sha256(binary)) {
    return `checksum mismatch for ${asset}; the installed yok is unchanged`;
  }
  // Renaming over the running file is safe on macOS and Linux: the process keeps its open copy.
  const next = `${target.execPath}.new`;
  await writeFile(next, binary);
  await chmod(next, 0o755);
  await rename(next, target.execPath);
  return null;
};

const report = (message: string): number => {
  console.error(message);
  return 1;
};

// Returns the exit code. The plugin install runs in target.execPath after the swap: the new binary
// knows its own version, which this process does not.
export const runUpdate = async (
  target: UpdateTarget,
  agents: readonly WorkflowAgent[],
  preRelease: boolean,
): Promise<number> => {
  const asset = assetName(process.platform, process.arch);
  const listed = await fetch(target.releasesUrl);
  if (!listed.ok) return report(`could not list releases: HTTP ${listed.status}`);
  const tag = pickRelease(await listed.json(), asset, preRelease);
  if (tag === null) return report(`no release has ${asset}`);
  // Not newer is not the same tag: a pre-release is ahead of the newest stable release.
  if (Bun.semver.order(tag.slice(1), target.version) <= 0) {
    console.log(`yok ${target.version} is up to date: the newest release is ${tag}`);
  } else {
    const problem = await replaceBinary(target, tag, asset);
    if (problem !== null) return report(problem);
    console.log(`yok ${target.version} replaced by ${tag}`);
  }
  const args = ["plugin", "install", ...agents.flatMap((agent) => ["--agent", agent])];
  return spawnInteractive(target.execPath, args, { cwd: process.cwd() });
};

export const updateCommand = () =>
  new Command("update")
    .description("Install the newest yok release, then move the plugin to it")
    .option("--pre-release", "take the newest release of any kind, not only stable")
    .addOption(agentOption())
    .action(async ({ agent, preRelease }) => {
      if (!isCompiled) return fail(DEV_UPDATE);
      const target = { ...GITHUB, execPath: process.execPath, version: VERSION };
      process.exitCode = await runUpdate(target, agent, preRelease === true);
    });
