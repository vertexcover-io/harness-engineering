#!/usr/bin/env node --experimental-strip-types
// Builds one video per verification scenario from its promoted frames, then cropdetects each
// video to prove the frame letterboxed into the canvas instead of being stretched to fill it.
// Usage: build-videos.ts VERIFICATION_DIR
// Prints one line per scenario — "ok NN_<slug>.mp4 crop=<window>", or
// "FAILED NN_<slug> — <reason>" — and writes each NN_<slug>.mp4 beside the report.
// Exits 0 when every scenario built, and when there are no frames at all; 1 when any scenario
// failed; 2 when the argument, the directory, or a missing ffmpeg makes a build impossible.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ScenarioResult = {
  readonly prefix: string;
  readonly crop: string | null;
  readonly failure: string | null;
};

// Copied verbatim from references/writing-the-report.md. The canvas is fixed at 1280x720 and
// every frame letterboxes into it; three seconds a frame, the last frame held two seconds longer.
const FILTER_GRAPH =
  "scale=1280:720:force_original_aspect_ratio=decrease," +
  "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuv420p," +
  "tpad=stop_mode=clone:stop_duration=2";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** The scenario prefixes behind a directory of promoted `NN_<slug>__SS_<step>.png` frames. */
export function scenarioPrefixes(screenshotsDir: string): readonly string[] {
  if (!existsSync(screenshotsDir)) return [];
  const prefixes = readdirSync(screenshotsDir)
    .filter((name) => name.endsWith(".png") && name.includes("__"))
    .map((name) => name.slice(0, name.indexOf("__")));
  return [...new Set(prefixes)].toSorted();
}

/** The last crop window cropdetect reported, which is the picture inside the bars. */
export function parseCropWindow(ffmpegOutput: string): string | null {
  const windows = ffmpegOutput.match(/crop=[0-9:]+/g);
  if (windows === null) return null;
  return windows.at(-1) ?? null;
}

function ffmpegFailure(err: unknown): string {
  const stderr = isRecord(err) && typeof err["stderr"] === "string" ? err["stderr"] : "";
  const message = isRecord(err) && typeof err["message"] === "string" ? err["message"] : "";
  const lastLine = stderr.trim().split("\n").at(-1) ?? "";
  return lastLine || message || "ffmpeg exited non-zero";
}

function buildVideo(dir: string, prefix: string): string | null {
  try {
    execFileSync(
      "ffmpeg",
      [
        "-nostdin", "-v", "error", "-y",
        "-framerate", "1/3",
        "-pattern_type", "glob",
        "-i", join("screenshots", `${prefix}__*.png`),
        "-vf", FILTER_GRAPH,
        "-c:v", "libx264", "-preset", "veryfast", "-r", "30",
        `${prefix}.mp4`,
      ],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return null;
  } catch (err) {
    return ffmpegFailure(err);
  }
}

function cropWindow(dir: string, prefix: string): string | null {
  // cropdetect writes its report to stderr, which only spawnSync hands back on a zero exit.
  // Default loglevel, since -v error silences cropdetect itself.
  const probe = spawnSync(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-ss", "1", "-t", "0.5", "-i", `${prefix}.mp4`,
      "-vf", "cropdetect", "-f", "null", "-"],
    { cwd: dir, encoding: "utf8" },
  );
  return parseCropWindow(`${probe.stdout ?? ""}\n${probe.stderr ?? ""}`);
}

/** Builds and checks every scenario in the directory, in prefix order. */
export function buildScenarios(dir: string): readonly ScenarioResult[] {
  return scenarioPrefixes(join(dir, "screenshots")).map((prefix) => {
    const failure = buildVideo(dir, prefix);
    if (failure !== null) return { prefix, crop: null, failure: `ffmpeg: ${failure}` };

    const crop = cropWindow(dir, prefix);
    if (crop === null) {
      return { prefix, crop: null, failure: `cropdetect read no crop window out of ${prefix}.mp4` };
    }
    return { prefix, crop, failure: null };
  });
}

export const formatResult = (result: ScenarioResult): string =>
  result.failure === null
    ? `ok ${result.prefix}.mp4 ${result.crop}`
    : `FAILED ${result.prefix} — ${result.failure}`;

const hasFfmpeg = (): boolean => spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

export function main(args: readonly string[]): number {
  const target = args[0];
  if (target === undefined || args.length > 1) {
    console.error("usage: build-videos.ts VERIFICATION_DIR");
    return 2;
  }

  const dir = resolve(target);
  if (!isDirectory(dir)) {
    console.error(`no such directory: ${dir}`);
    return 2;
  }

  const screenshots = join(dir, "screenshots");
  if (scenarioPrefixes(screenshots).length === 0) {
    console.log(`no frames under ${screenshots} — no videos to build`);
    return 0;
  }

  if (!hasFfmpeg()) {
    console.error("ffmpeg is not on PATH — no video can be built");
    return 2;
  }

  const results = buildScenarios(dir);
  for (const result of results) console.log(formatResult(result));
  return results.some((result) => result.failure !== null) ? 1 : 0;
}

const invokedScript = (): string => {
  const argv1 = resolve(process.argv[1] ?? "");
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
};

if (fileURLToPath(import.meta.url) === invokedScript()) {
  process.exit(main(process.argv.slice(2)));
}
