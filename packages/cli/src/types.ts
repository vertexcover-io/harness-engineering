import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "@commander-js/extra-typings";
import { createGit } from "@yok/sdk";
import { VERSION } from "@yok/sdk/internal";
import { fail } from "./client.ts";
import SDK_TYPES from "./sdk-types.json";

const TYPES_DIR = join(".yok", "types");
const PATHS_ENTRY = '"@yok/sdk": ["./.yok/types/index.d.ts"]';

const readVersion = async (dir: string): Promise<string | undefined> =>
  readFile(join(dir, "VERSION"), "utf8").then(
    (text) => text.trim(),
    () => undefined,
  );

// Types from the same or a newer yok stay; VERSION is written last, so a cut-short write retries.
export const writeProjectTypes = async (root: string, version: string): Promise<boolean> => {
  const dir = join(root, TYPES_DIR);
  const existing = await readVersion(dir);
  if (existing !== undefined && Bun.semver.order(existing, version) >= 0) return false;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all(
    Object.entries(SDK_TYPES.files).map(([name, text]) => writeFile(join(dir, name), text)),
  );
  await writeFile(join(dir, "VERSION"), `${version}\n`);
  return true;
};

export const typesCommand = () =>
  new Command("types")
    .description("Write the SDK's type files into .yok/types for editors and tsc")
    .action(async () => {
      const root = await createGit().repoRoot(process.cwd());
      if (root === null) return fail("not inside a git repository");
      const wrote = await writeProjectTypes(root, VERSION);
      console.log(
        wrote ? `wrote ${TYPES_DIR} (yok ${VERSION})` : `${TYPES_DIR} is current (yok ${VERSION})`,
      );
      console.log("Add to tsconfig.json compilerOptions.paths:");
      console.log(`  ${PATHS_ENTRY}`);
      console.log(`For zod's types: bun add -d zod@${SDK_TYPES.zodVersion}`);
    });
