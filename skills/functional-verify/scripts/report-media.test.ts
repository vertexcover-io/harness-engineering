import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkFrameShape, mediaPaths, parseCropWindow, parseReportData, pngSize, scenarioPrefixes,
  withMediaIsland,
} from "./report-media.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "report-media.ts");

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
  assert.match(run().stderr, /usage: report-media\.ts \[--inline\] VERIFICATION_DIR/);
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

const island = (id: string, json: string): string =>
  `<script type="application/json" id="${id}">${json}</script>`;

const reportHtml = (data: unknown): string =>
  `<html><body>\n${island("report-data", JSON.stringify(data))}\n<script>render()</script></body></html>`;

const withReport = (name: string, data: unknown): string => {
  const dir = withScreenshots(name);
  writeFileSync(join(dir, "proof-report.html"), reportHtml(data));
  return dir;
};

test("SC17: the report's media paths are every video, frame, baseline and artifact, once each", () => {
  const data = {
    scenarios: [
      {
        video: "01_a.mp4",
        frames: [{ src: "screenshots/01_a__01_open.png", label: "open" }, "screenshots/01_a__02_saved.png"],
        visualMatch: { baseline: "design/a.png" },
        artifacts: [{ label: "export", href: "01_a_export.csv" }, "01_a.mp4"],
      },
      { frames: [{ src: "screenshots/01_a__01_open.png" }], visualMatch: { baseline: null } },
      { video: "https://example.com/run.mp4", artifacts: [{ href: "data:text/plain,hi" }, { label: "no href" }] },
      "not a scenario",
    ],
  };

  assert.deepEqual(mediaPaths(data), [
    "01_a.mp4",
    "screenshots/01_a__01_open.png",
    "screenshots/01_a__02_saved.png",
    "design/a.png",
    "01_a_export.csv",
  ]);
  assert.deepEqual(mediaPaths({}), []);
});

test("SC18: the report data is read out of its island, and anything else reads as null", () => {
  assert.deepEqual(parseReportData(reportHtml({ scenarios: [] })), { scenarios: [] });
  assert.equal(parseReportData("<html></html>"), null);
  assert.equal(parseReportData(`<html>${island("report-data", "{not json")}</html>`), null);
  assert.equal(parseReportData(`<html>${island("report-data", "[1]")}</html>`), null);
});

test("SC19: the media island lands before the data island, and a re-run replaces it", () => {
  const once = withMediaIsland(reportHtml({}), { "a.png": "data:image/png;base64,AA==" });
  const twice = withMediaIsland(once, { "b.png": "data:image/png;base64,BB==" });

  assert.ok(once.indexOf('id="report-media"') < once.indexOf('id="report-data"'));
  assert.match(once, /"a\.png":"data:image\/png;base64,AA=="/);
  assert.equal(twice.match(/id="report-media"/g)?.length, 1);
  assert.doesNotMatch(twice, /a\.png/);
  assert.match(twice, /b\.png/);
  assert.deepEqual(parseReportData(twice), {});
});

test("SC20: --inline writes every readable file into the report as a data URI", () => {
  const dir = withReport("inline", {
    scenarios: [{ video: "01_a.mp4", frames: [{ src: "screenshots/01_a__01_open.png" }] }],
  });
  writeFileSync(join(dir, "01_a.mp4"), "video-bytes");
  writeFileSync(join(dir, "screenshots", "01_a__01_open.png"), "png-bytes");

  const r = run("--inline", dir);

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^ok 01_a\.mp4 11B$/m);
  assert.match(r.stdout, /^ok screenshots\/01_a__01_open\.png 9B$/m);
  const html = readFileSync(join(dir, "proof-report.html"), "utf8");
  assert.ok(html.includes(`"01_a.mp4":"data:video/mp4;base64,${Buffer.from("video-bytes").toString("base64")}"`));
  assert.ok(html.includes(`data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`));
});

test("SC21: a file --inline cannot read is FAILED, exits 1, and the rest is still inlined", () => {
  const dir = withReport("inline-missing", {
    scenarios: [{ video: "01_a.mp4", artifacts: [{ href: "01_a.bin" }], visualMatch: { baseline: "gone.png" } }],
  });
  writeFileSync(join(dir, "01_a.mp4"), "video-bytes");
  writeFileSync(join(dir, "01_a.bin"), "binary");

  const r = run("--inline", dir);

  assert.equal(r.status, 1);
  assert.match(r.stdout, /^ok 01_a\.mp4 11B$/m);
  assert.match(r.stdout, /^FAILED gone\.png — no such file$/m);
  assert.match(r.stdout, /^FAILED 01_a\.bin — not a type the report shows$/m);
  const html = readFileSync(join(dir, "proof-report.html"), "utf8");
  assert.match(html, /"01_a\.mp4":"data:video\/mp4/);
  assert.doesNotMatch(html, /"gone\.png":/);
});

test("SC22: --inline without a readable report exits 2", () => {
  const bare = sandbox("inline-bare");
  assert.equal(run("--inline", bare).status, 2);
  assert.match(run("--inline", bare).stderr, /no proof-report\.html under/);

  writeFileSync(join(bare, "proof-report.html"), "<html></html>");
  assert.equal(run("--inline", bare).status, 2);
  assert.match(run("--inline", bare).stderr, /no report-data island/);

  assert.equal(run("--inline").status, 2);
  assert.equal(run("--inline", bare, "extra").status, 2);
});
