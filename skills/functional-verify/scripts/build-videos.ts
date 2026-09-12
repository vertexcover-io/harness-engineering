#!/usr/bin/env node --experimental-strip-types
// Builds one video per verification scenario from its promoted frames, then cropdetects each video
// and fails the scenario unless the window it reports still carries the source frame's aspect
// ratio — a frame stretched to fill the canvas shows a geometry that was never on screen.
// Usage: build-videos.ts VERIFICATION_DIR
// Prints one line per scenario — "ok NN_<slug>.mp4 crop=<window>", or
// "FAILED NN_<slug> — <reason>" — and writes each NN_<slug>.mp4 beside the report.
// Exits 0 when every scenario built, and when there are no frames at all; 1 when any scenario
// failed; 2 when the argument, the directory, or a missing ffmpeg makes a build impossible.

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type ScenarioResult = {
  readonly prefix: string;
  readonly crop: string | null;
  readonly failure: string | null;
  readonly note: string | null;
};

type FrameSize = {
  readonly width: number;
  readonly height: number;
};

type ShapeCheck = {
  readonly kind: "matches" | "stretched" | "unchecked";
  readonly note: string | null;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Three seconds a frame, the last held two longer. The 1280x720 canvas is fixed and every frame
// letterboxes into it, never reshaped to fill it — widening it to swallow a phone frame's bars is
// what would pass off a landscape shape that was never on screen. A hand rebuild keeps these.
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

/** The first `bytes` of a file, or null when it cannot be read that far. */
function readHead(path: string, bytes: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(bytes);
    return readSync(fd, head, 0, bytes, 0) === bytes ? head : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** A PNG's dimensions from its IHDR — big-endian uint32 at byte 16 and 20. Null if unreadable. */
export function pngSize(path: string): FrameSize | null {
  const head = readHead(path, 24);
  if (head === null) return null;
  if (!head.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (head.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

/** The `W:H` of a `crop=W:H:X:Y` window, when it reports a real rectangle. */
function cropSize(cropWindow: string): FrameSize | null {
  const [width, height] = cropWindow.replace("crop=", "").split(":").map(Number);
  if (width === undefined || height === undefined) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return width > 0 && height > 0 ? { width, height } : null;
}

// cropdetect rounds the window it reports down to a multiple of 16 (its `round` default) and the
// scaler rounds to an even size first, so a window can read up to 18px short of the real picture.
// Those 18px cost little aspect on a 1280-wide window and a lot on the 128-wide one a tall phone
// frame produces, so the tolerance scales with the window instead of being flat. Measured here:
// an honest 390x2000 frame is 0.017 off its source aspect (8.8% of it) and a stretched 1280x800
// one 0.178 off (11% of it), so no flat percentage separates them; and a wider-than-16:9 source
// quantises on height instead, which no flat absolute covers. Honest builds use at most 70% of
// this budget (390x844 -> crop=320:720 is 0.0176 against 0.0250), stretches overshoot it 4x up.
const QUANTISATION_PX = 18;

const aspectTolerance = (crop: FrameSize): number =>
  (QUANTISATION_PX / crop.height) * Math.max(1, crop.width / crop.height);

/** Whether the picture inside the letterbox still has the source frame's shape. */
export function checkFrameShape(source: FrameSize | null, cropWindow: string): ShapeCheck {
  if (source === null || source.width <= 0 || source.height <= 0) {
    return { kind: "unchecked", note: "shape unchecked: the source frame is not a readable PNG" };
  }

  const crop = cropSize(cropWindow);
  if (crop === null) {
    return { kind: "unchecked", note: `shape unchecked: ${cropWindow} is not a rectangle` };
  }

  const sourceAspect = source.width / source.height;
  const cropAspect = crop.width / crop.height;
  if (Math.abs(sourceAspect - cropAspect) <= aspectTolerance(crop)) {
    return { kind: "matches", note: null };
  }

  return {
    kind: "stretched",
    note: `the frame was stretched: source ${source.width}x${source.height} is aspect ` +
      `${sourceAspect.toFixed(2)}, ${cropWindow} is aspect ${cropAspect.toFixed(2)}`,
  };
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

/** The shape of the scenario's first frame, which is the one the cropdetect probe samples. */
function firstFrameSize(screenshotsDir: string, prefix: string): FrameSize | null {
  const first = readdirSync(screenshotsDir)
    .filter((name) => name.startsWith(`${prefix}__`) && name.endsWith(".png"))
    .toSorted()
    .at(0);
  return first === undefined ? null : pngSize(join(screenshotsDir, first));
}

/** Builds and checks every scenario in the directory, in prefix order. */
export function buildScenarios(dir: string): readonly ScenarioResult[] {
  const screenshots = join(dir, "screenshots");
  return scenarioPrefixes(screenshots).map((prefix) => {
    const failure = buildVideo(dir, prefix);
    if (failure !== null) {
      return { prefix, crop: null, failure: `ffmpeg: ${failure}`, note: null };
    }

    const crop = cropWindow(dir, prefix);
    if (crop === null) {
      const unread = `cropdetect read no crop window out of ${prefix}.mp4`;
      return { prefix, crop: null, failure: unread, note: null };
    }

    const shape = checkFrameShape(firstFrameSize(screenshots, prefix), crop);
    if (shape.kind === "stretched") return { prefix, crop, failure: shape.note, note: null };
    return { prefix, crop, failure: null, note: shape.note };
  });
}

export const formatResult = (result: ScenarioResult): string =>
  result.failure !== null
    ? `FAILED ${result.prefix} — ${result.failure}`
    : `ok ${result.prefix}.mp4 ${result.crop}${result.note === null ? "" : ` — ${result.note}`}`;

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
