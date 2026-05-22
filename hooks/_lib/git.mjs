import { spawnSync } from "node:child_process";

const run = (args, cwd) => {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) return null;
  return res.stdout;
};

export const gitAvailable = () => {
  const res = spawnSync("git", ["--version"], { encoding: "utf8" });
  return res.status === 0;
};

export const repoRoot = (cwd) => {
  const out = run(["rev-parse", "--show-toplevel"], cwd);
  return out ? out.trim() : null;
};

export const diffNamesSince = (sha, cwd) => {
  const a = run(["diff", "--name-only", `${sha}..HEAD`], cwd) ?? "";
  const b = run(["diff", "--name-only", sha], cwd) ?? "";
  const seen = new Set();
  for (const line of (a + b).split("\n")) {
    const t = line.trim();
    if (t) seen.add(t);
  }
  return [...seen];
};
