import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFrameShape, parseCropWindow, pngSize, scenarioPrefixes } from "./build-videos.ts";

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

// Every crop window below is one this repo's own ffmpeg actually reported for that source shape.
test("SC9: a portrait frame whose crop fills the canvas was stretched", () => {
  const verdict = checkFrameShape({ width: 390, height: 844 }, "crop=1280:720:0:0");

  assert.equal(verdict.kind, "stretched");
  assert.match(verdict.note ?? "", /0\.46/);
  assert.match(verdict.note ?? "", /1\.78/);
});

test("SC10: a portrait frame pillarboxed into the canvas kept its shape", () => {
  assert.equal(checkFrameShape({ width: 390, height: 844 }, "crop=320:720:478:0").kind, "matches");
  assert.equal(checkFrameShape({ width: 1170, height: 2532 }, "crop=320:720:478:0").kind, "matches");
  assert.equal(checkFrameShape({ width: 390, height: 2000 }, "crop=128:720:576:0").kind, "matches");
});

test("SC11: a 16:10 desktop frame with bars kept its shape", () => {
  assert.equal(checkFrameShape({ width: 1280, height: 800 }, "crop=1152:720:64:0").kind, "matches");
  assert.equal(checkFrameShape({ width: 1512, height: 982 }, "crop=1104:720:86:0").kind, "matches");
});

test("SC12: a 16:9 frame filling the canvas exactly is not a stretch", () => {
  assert.equal(checkFrameShape({ width: 1280, height: 720 }, "crop=1280:720:0:0").kind, "matches");
  assert.equal(checkFrameShape({ width: 1920, height: 1080 }, "crop=1280:720:0:0").kind, "matches");
});

test("SC13: a reshaped desktop frame is caught too, not just a portrait one", () => {
  assert.equal(checkFrameShape({ width: 1280, height: 800 }, "crop=1280:720:0:0").kind, "stretched");
  assert.equal(checkFrameShape({ width: 768, height: 1024 }, "crop=1280:720:0:0").kind, "stretched");
});

test("SC14: an unreadable source or an unreadable window skips the check, never fails it", () => {
  assert.equal(checkFrameShape(null, "crop=1280:720:0:0").kind, "unchecked");
  // An extreme source makes cropdetect report a negative height, which parses to nothing useful.
  assert.equal(checkFrameShape({ width: 390, height: 3000 }, "crop=80:").kind, "unchecked");
  assert.equal(checkFrameShape({ width: 0, height: 0 }, "crop=1280:720:0:0").kind, "unchecked");
});

test("SC15: the PNG header reader reports a real frame's dimensions",
  { skip: needsFfmpeg }, () => {
    const dir = withScreenshots("pngsize");
    frame(dir, "01_phone__01_open.png", 390, 844);
    frame(dir, "02_desktop__01_open.png", 1280, 800);

    assert.deepEqual(pngSize(join(dir, "screenshots", "01_phone__01_open.png")),
      { width: 390, height: 844 });
    assert.deepEqual(pngSize(join(dir, "screenshots", "02_desktop__01_open.png")),
      { width: 1280, height: 800 });
  });

test("SC16: anything that is not a readable PNG reads as no dimensions", () => {
  const dir = withScreenshots("notpng");
  const at = (name: string, bytes: Buffer | string): string => {
    const path = join(dir, "screenshots", name);
    writeFileSync(path, bytes);
    return path;
  };

  assert.equal(pngSize(join(dir, "screenshots", "absent.png")), null);
  assert.equal(pngSize(at("empty.png", "")), null);
  assert.equal(pngSize(at("text.png", "not a png")), null);
  assert.equal(pngSize(at("truncated.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))), null);
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
