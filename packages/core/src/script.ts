import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  createGit,
  createRegistryReader,
  loadPickedConfig,
  pickRun,
  type Result,
  registryPath,
} from "@yok/sdk";
import { resolveSkillDir } from "./runs.ts";
import { type ReferenceRun, resolveSkillScript } from "./stage.ts";
import { isInsideDir } from "./workflow/done.ts";

export type ScriptFlags = Readonly<{ skill?: string; run?: string; runId?: string }>;

const existing = (path: string): Result<string> =>
  existsSync(path) ? { ok: true, value: path } : { ok: false, error: `no script at ${path}` };

// FILE inside the skill's folder, compared by real path so neither ../ nor a symlink leaves it.
const fileInSkill = (dir: string, file: string): Result<string> => {
  const found = existing(resolve(dir, file));
  if (!found.ok) return found;
  return isInsideDir(realpathSync(dir), realpathSync(found.value))
    ? found
    : { ok: false, error: `${file} is outside the skill folder ${dir}` };
};

const skillScript = async (
  skill: string,
  file: string,
  flags: ScriptFlags,
): Promise<Result<ReferenceRun>> => {
  const cwd = process.cwd();
  const run = await pickRun({
    registry: createRegistryReader(registryPath()),
    name: flags.run,
    id: flags.runId,
    env: process.env,
    cwd,
  });
  if (!run.ok) return run;
  const repo = await createGit().repoRoot(cwd);
  const dir = await resolveSkillDir(skill, { root: run.value?.cwd ?? repo ?? cwd, run: run.value });
  if (!dir.ok) return dir;
  const found = fileInSkill(dir.value, file);
  if (!found.ok) return found;
  // With no run and no checkout there is no project config, so nothing extends the skill.
  if (run.value === undefined && repo === null) return { ok: true, value: { file: found.value } };
  const loaded = await loadPickedConfig(run.value, cwd);
  if (!loaded.ok) return loaded;
  const { root, config } = loaded.value;
  return resolveSkillScript({ skillDir: dir.value, file: found.value, root, config });
};

// What `yok orchestrate script` runs: FILE from cwd, or with --skill FILE from that skill's
// folder, where the project's extension of a script reference applies.
export const scriptToRun = async (
  file: string,
  flags: ScriptFlags,
): Promise<Result<ReferenceRun>> => {
  if (flags.skill !== undefined) return skillScript(flags.skill, file, flags);
  const found = existing(isAbsolute(file) ? file : resolve(process.cwd(), file));
  return found.ok ? { ok: true, value: { file: found.value } } : found;
};
