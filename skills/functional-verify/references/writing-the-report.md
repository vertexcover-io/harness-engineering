# Writing the Proof Report

**Read this when:** grading scenarios, assembling videos (Step 5), or writing the report (Step 6). Everything here
is done once the browser is closed; the driving and capture craft is in `driving-the-browser.md`.

## Grading — two tracks

Grade each scenario on two tracks; they answer different questions and flow to different places.

The **documented check** answers the question you were given: do these frames show the behaviour the docs describe?
The verdict is Success or Failure, and it cites concrete evidence — a measured rect, a quoted string, a computed
style, a network response. Layout claims cite a measurement. This becomes the scenario's row in the report.

The **open visual review** asks what's wrong regardless of what was asked for: alignment, contrast, clipping,
overlap, a broken empty state, copy issues. Run it on every scenario, including the ones that passed cleanly. Treat
`truncate` and `line-clamp` on a primary headline as a bug to justify, not a default to accept. Anything real you
find here is a bug, and Step 4 owns it.

## Building the videos (Step 5)

The videos are **assembled, not captured**: ffmpeg builds each one from the promoted frames in `screenshots/`. One
video per scenario, grouped by the `NN_<slug>` prefix before the `__`, written beside the report:

```bash
cd verification
for p in $(ls screenshots/*.png 2>/dev/null | sed 's#.*/##; s#__.*##' | sort -u); do
  ffmpeg -v error -y -framerate 1/3 -pattern_type glob -i "screenshots/${p}__*.png" \
    -vf "scale=1280:720:force_original_aspect_ratio=decrease,\
pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p,\
tpad=stop_mode=clone:stop_duration=2" \
    -c:v libx264 -preset veryfast -r 30 "${p}.mp4" \
    && echo "ok  ${p}.mp4" || echo "FAILED ${p}"
done
```

Three seconds a frame, the last frame held two seconds longer, so a reviewer can follow each step. The `sed` strips
the directory and everything from `__` on, leaving the `NN_<slug>` prefix, so each scenario's frames assemble into
`NN_<slug>.mp4` — the exact name the report's Evidence cell links.

**Keep the frames** — they are the only machine-readable evidence, and a re-grade or second look needs the PNGs. If
a merge fails, name the scenario and move on; its frames still prove it.

## The report format

`verification/proof-report.md` is for someone who knows the product and is reading to decide whether this ships —
and they will only read the whole thing if it is short. Three questions are what they came for: what worked, what
didn't and why, and how you know. The table answers the first two, the proofs answer the third, and anything serving
none of them gets cut however true it is. Failing rows earn more words than passing ones; that is where a reader
slows down.

One line naming where you drove and as what, then the table:

```markdown
# Proof Report — GSTR-2B Monetary Match

Driven on the reconciliation report at `/app/<business>/reports/gstr2breconciliation`, June 2026.

| # | What is to be tested | Steps | Success/Failure | Reason/Details | Evidence |
|---|---|---|---|---|---|
| 01 | An invoice whose tax total carries a floating-point artefact still reconciles against the supplier's filed entry | 1. Open the June 2026 reconciliation report<br>2. Switch to Detailed View<br>3. Find the invoice filed at ₹7,127.20 | Success | Books stored `7127.200000000001`; both sides render ₹7,127.20 and the pair reads **Complete Match** | [video](01_float_artefact_still_matches.mp4) |
| 02 | A pair whose amounts differ by exactly ₹0.50 is treated as a match | 1. Open the July 2026 report<br>2. Find the invoice booked at ₹10,000 against ₹10,000.50 filed | Success | Screen shows the ₹0.50 difference and still reads **Complete Match** — the boundary is inclusive | [video](02_half_rupee_gap_matches.mp4) |
| 04 | Reconciliation results are cached under a fresh key so stale pre-deploy results are not served | see *Cached under a new key* below | Success | Both cache keys carry the new version segment | [proofs](#04-cached-under-a-new-key) |
```

**The `#` is the scenario's stable number**, so a reader jumps from a row straight to its files. **Write the "what is
to be tested" cell as a sentence** a QA would use. Steps are the walk you actually drove, numbered — they summarise
the flow rather than mapping onto frames. Reason/Details is a sentence naming the observation that decided the
verdict — the rendered string, the measured value, the status code. When something needs more room, put it under the
table and point the row at it.

### Proofs

The frame proves the **surface**; a `## Proofs` block proves the **mechanism** underneath it. A scenario earns a
block when it has one of two things a video cannot carry:

- **No surface** — it never renders anywhere. A cache key, a queue write, a webhook body, a row written by a job.
- **The mechanism behind a surface that did render** — the frame shows the outcome, the block shows it was reached
  the way it was supposed to be. The intermediate call proving the right branch was taken; the query proving the
  total was recomputed rather than served stale; the response behind a table that looks correct either way.

Everything a QA could screenshot stays out — the board, the modal count, the toast, the received email are already
proven in `screenshots/`. When a capture is half visible, quote only the fields the frame couldn't show.

Heading is `### NN <name>`, so the row links it as `[proofs](#NN-name)`:

```markdown
## Proofs

### 04 Cached under a new key
**Reconciliation request** — `GET /businesses/$B/gstr2b-reconciliation/detailedview?period=062026` → `200`
{"redis":{"get":"serana:gstr2brecon:v2:6a59…:062026",
          "set":"serana:gstr2brecon:v2:6a59…:062026","ttl":604800}}
Both keys carry the v2 segment and no unversioned key was touched. The screen showed the right total
either way — this is what proves it was recomputed rather than served from the pre-deploy key.
```

Each entry is three parts: where it came from and its status, the excerpt that decides it, one sentence on what that
excerpt settled — the same shape whether it's HTTP, a log, a query, or a file. Save the full capture beside the
report under its `NN_<slug>` prefix and link it: the block holds what you concluded, the file holds what a reader
needs to reach the thing themselves — where it came from, whatever marks it as this run's rather than an earlier
one, and anything the sink recorded alongside it. Write it as it arrived rather than summarised, keep excerpts
short — twenty lines is plenty, the full file is one click away — redact secrets as `<redacted>`, and when the
artifact came from a stand-in for the real thing, say so in the file.

**Read the row's video, then its block: a block that told you nothing the video left open should not have been
written.**

### Bugs section

Below the table, a section for **bugs in the application** — defects that will bite a user or a developer. A
misleading message, lost or corrupted data, stale UI state, a 500 reaching the user, a silent no-op, a permission
leak, a broken recovery path; or, for developers, a documented command that is gone, an artifact contradicting the
tree.

Each is a bug report a maintainer could act on without asking you a question: what it is, its severity (blocker /
major / minor) and why that rung and not the one above, the repro, what happens, what should happen, and the video.
Most consequential first. Your infrastructure adventures, the data you couldn't find, and the workaround that got
the stack up go in what you report back to whoever dispatched you (Step 6). Found no bugs? Say so in one line, with
the sentence from Step 4 naming your best attack and why it didn't land.

## Completion checklist — the report is done when all of these hold

- Every scenario has a stable `#`, a row, and a verdict, and every behaviour the docs describe is covered. One you
  could not verify is a row reading `NOT VERIFIED` with the reason and what would close it; one that turned out not
  to apply is `INVALID` with why. Neither is dropped, and neither is quietly backfilled with an adjacent passing
  check.
- Every verdict cites a live observation from this run — a DOM assert, an HTTP status and body, a DB read-back, a
  measured rect, a captured webhook body. This is the only thing separating a real verification from a plausible
  one. Where that observation is mechanism rather than surface, its row links a `[proofs]` block, and it is written
  there once.
- Every UI row links its video with a report-relative path, and every downloaded file or API capture the report
  names exists beside it under the same `NN_<slug>` prefix.
- Every side-effect row carries the right receipt: an **email** links the mail-viewer frames and its video; a
  **job-queue** row links a bull-board screenshot (queue card + job), or — only when the board couldn't be brought
  up — a log/Redis capture with a note saying why; a **webhook or delivered file** links its captured artifact
  (`NN_<slug>.<ext>`).
- Things this skill genuinely cannot reach (touch-hold gestures, real-device sensors, visual diffs against last
  week's build) are rows too, marked `NOT VERIFIED`.
- No internal ids appear anywhere — the `#` column's plain sequential numbers are the only identifiers a reader
  needs. Nothing is said twice.
