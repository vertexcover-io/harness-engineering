import { tmpdir } from "node:os";
import { join } from "node:path";

export const activeBreadcrumbPath = () =>
  join(tmpdir(), ".claude-harness-active");

export const harnessDir = (cwd, specName) =>
  join(cwd, ".harness", specName);
