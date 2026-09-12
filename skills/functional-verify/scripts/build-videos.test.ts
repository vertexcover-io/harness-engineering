import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCropWindow, scenarioPrefixes } from "./build-videos.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "build-videos.ts");

const ffmpegMissing = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0;
const needsFfmpeg = ffmpegMissing ? "ffmpeg is not on PATH" : false;

type Run = { readonly status: number; readonly stdout: string; readonly stderr: string };

const run = (...args: readonly string[]): Run => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

const sandbox = (name: string): string => mkdtempSync(join(tmpdir(), `bv-${name}-`));

const withScreenshots = (name: string): string => {
  const dir = sandbox(name);
  mkdirSync(join(dir, "screenshots"));
  return dir;
};

const frame = (dir: string, name: string, width = 1280, height = 800): void => {
  const path = join(dir, "screenshots", name);
  if (ffmpegMissing) {
    writeFileSync(path, "");
    return;
  }
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i",
    `color=c=red:s=${width}x${height}:d=1`, "-frames:v", "1", path], { stdio: "ignore" });
};

test("SC1: prefix discovery groups a scenario's frames and ignores unrelated files", () => {
  const dir = withScreenshots("prefixes");
  frame(dir, "01_float_matches__01_open.png");
  frame(dir, "01_float_matches__02_detailed.png");
  frame(dir, "02_phone_replay__01_open.png");
  writeFileSync(join(dir, "screenshots", "notes.txt"), "");
  writeFileSync(join(dir, "screenshots", "stray.png"), "");

  assert.deepEqual(scenarioPrefixes(join(dir, "screenshots")), [
    "01_float_matches",
    "02_phone_replay",
  ]);
});

test("SC2: prefix discovery over a directory that does not exist is empty, not an error", () => {
  assert.deepEqual(scenarioPrefixes(join(sandbox("absent"), "screenshots")), []);
});

test("SC3: the crop window is the last one cropdetect reported", () => {
  const output = [
    "[Parsed_cropdetect_0 @ 0x1] x1:0 x2:1279 w:1280 h:720 crop=1280:720:0:0",
    "[Parsed_cropdetect_0 @ 0x1] x1:478 x2:797 w:320 h:720 crop=320:720:478:0",
  ].join("\n");

  assert.equal(parseCropWindow(output), "crop=320:720:478:0");
  assert.equal(parseCropWindow("frame= 1 fps=0.0 q=-1.0 Lsize=N/A\n"), null);
});

test("SC4: a directory with no frames exits 0 and says so", () => {
  const dir = withScreenshots("noframes");

  const r = run(dir);

  assert.equal(r.status, 0);
  assert.match(r.stdout, /no frames under .*screenshots — no videos to build/);
});

test("SC5: a directory with no screenshots folder at all exits 0 the same way", () => {
  const r = run(sandbox("bare"));

  assert.equal(r.status, 0);
  assert.match(r.stdout, /no videos to build/);
});

test("SC6: a missing or extra argument, or an absent directory, exits 2", () => {
  assert.equal(run().status, 2);
  assert.match(run().stderr, /usage: build-videos\.ts VERIFICATION_DIR/);
  assert.equal(run("a", "b").status, 2);
  assert.equal(run(join(sandbox("gone"), "nope")).status, 2);
});

test("SC7: each scenario builds its own video and reports its crop window",
  { skip: needsFfmpeg }, () => {
    const dir = withScreenshots("build");
    frame(dir, "01_desktop__01_open.png", 1280, 800);
    frame(dir, "01_desktop__02_saved.png", 1280, 800);
    frame(dir, "02_phone__01_open.png", 390, 844);

    const r = run(dir);

    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok 01_desktop\.mp4 crop=\d+:\d+:\d+:\d+$/m);
    assert.match(r.stdout, /^ok 02_phone\.mp4 crop=\d+:\d+:\d+:\d+$/m);
    assert.ok(existsSync(join(dir, "01_desktop.mp4")));
    assert.ok(existsSync(join(dir, "02_phone.mp4")));
  });

test("SC8: a scenario ffmpeg cannot build is FAILED, and the run exits non-zero",
  { skip: needsFfmpeg }, () => {
    const dir = withScreenshots("failure");
    frame(dir, "01_good__01_open.png", 1280, 800);
    writeFileSync(join(dir, "screenshots", "02_broken__01_open.png"), "not a png");

    const r = run(dir);

    assert.equal(r.status, 1);
    assert.match(r.stdout, /^ok 01_good\.mp4 crop=/m);
    assert.match(r.stdout, /^FAILED 02_broken — ffmpeg: .+/m);
  });
