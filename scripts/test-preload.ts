import { join } from "node:path";

// Tests run outside the yok CLI, so they set what its entry sets when run from source.
process.env.YOK_SELF ??= JSON.stringify([
  process.execPath,
  "--no-env-file",
  join(import.meta.dir, "..", "packages", "cli", "src", "index.ts"),
]);
