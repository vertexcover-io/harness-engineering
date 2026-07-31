# Writing the Proof Report

**Read this when:** grading scenarios, assembling videos (Step 5), or writing the report (Step 6). Everything here
is done once the browser is closed; the driving and capture craft is in `driving-the-browser.md`.

## Grading — two tracks

Grade each scenario on two tracks; they answer different questions and flow to different places.

The **documented check** answers the question you were given: do these frames show the behaviour the docs describe?
The verdict is Success or Failure, and it cites concrete evidence — a measured rect, a quoted string, a computed
style, a network response. Layout claims cite a measurement. This becomes the scenario's `verdict` and `reason`.

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
`NN_<slug>.mp4` — the exact name the scenario's `video` names.

**Keep the frames** — they are the only machine-readable evidence, and a re-grade or second look needs the PNGs. If
a merge fails, name the scenario and move on; its frames still prove it.

## The report format

Copy `references/proof-report-template.html` to `verification/proof-report.html` and **fill its JSON island — the
`<script type="application/json" id="report-data">` block. Change nothing else in the file.** You write data, not
markup; the template renders it. Its header comment is the field-by-field guide, and it stays in the file you ship.

The reader knows the product and is deciding whether this ships, and the contract's four questions are what they
came for. Anything serving none of them gets cut however true it is. Failing scenarios earn more words than passing
ones; that is where a reader slows down.

`summary` at the top level is the Overview pane a reader lands on, in three short paragraphs: what this feature does
in the product's terms, what was tested and how it was driven, and what the verdict means for shipping. Plain
sentences a reader takes in at a glance — the environment detail belongs in `drivenOn` and `fields[]` beside it.

```json
{
  "title": "GSTR-2B monetary match",
  "drivenOn": "The reconciliation report at `/app/<business>/reports/gstr2breconciliation`, June 2026.",
  "scenarios": [
    {
      "n": "01",
      "slug": "01_float_artefact_still_matches",
      "short": "Float artefact matches",
      "title": "An invoice whose tax total carries a floating-point artefact still reconciles against the supplier's filed entry",
      "verdict": "Success",
      "expected": "An invoice whose books total is `7127.200000000001` and whose filed entry is `7127.20` reads **Complete Match**, both sides rendering ₹7,127.20.",
      "reason": "Books stored `7127.200000000001`; both sides render ₹7,127.20 and the pair reads **Complete Match**.",
      "steps": ["Open the June 2026 reconciliation report", "Switch to Detailed View",
                "Find invoice `INV-4417`, books ₹7,127.200000000001 against filed ₹7,127.20"],
      "video": "01_float_artefact_still_matches.mp4",
      "frames": [{ "src": "screenshots/01_float_artefact_still_matches__01_report_open.png",
                   "label": "June report, detailed view" }]
    }
  ]
}
```

**`n` is the scenario's stable number** and `slug` is the prefix every one of its artifacts carries, so a reader
reaches its files from the scenario alone. **Write `title` as a sentence** a QA would use, and `short` as the three
or four words that identify it in the left rail.

**Write `expected` from the docs before you drive it** — one or two sentences naming the outcome and the values it
turns on. It is the bar the run is graded against, and `reason` is the diff between it and what you saw. A scenario
whose `expected` could only have been written afterwards has graded itself.

`steps` is the walk you actually drove, one plain sentence each, **each naming the value it sent** — "POST the client
as `{clientId:"v-crm-1", name:"Verify Acme"}`" rather than "POST the client" — so a dev re-runs the walk from the
report alone. They summarise the flow rather than mapping onto frames. `reason` is what decided the verdict — the
rendered string, the measured value, the status code — and a blank line inside it starts a new paragraph.

Three shapes are fixed, because they are what makes two reports comparable: **`expected` renders above the walk**,
**`steps` renders numbered in order**, and
**`video` + `frames[]` render as Visual proof**, the video leading with the screenshots folded behind a toggle.
Everything else is prose you shape yourself. When something fits none of the sections, put it in `extra[]` —
`{heading, body, capture}`, all optional, no imposed shape.

`` `code` `` and `**bold**` work in every prose field.

### Proofs

The frame proves the **surface**; a `proofs[]` entry proves the **mechanism** underneath it. A scenario earns one
when it has one of two things a video cannot carry:

- **No surface** — it never renders anywhere. A cache key, a queue write, a webhook body, a row written by a job.
- **The mechanism behind a surface that did render** — the frame shows the outcome, the block shows it was reached
  the way it was supposed to be. The intermediate call proving the right branch was taken; the query proving the
  total was recomputed rather than served stale; the response behind a table that looks correct either way.

Where a frame already carries the surface — the board, the modal count, the toast, the received email — the entry
carries the mechanism under it. **Where there is no frame, the exchange is the whole evidence, so it goes in whole.**

`tag` is the one-word kind shown as a chip — `queue`, `email`, `http`, `db`, `cache`, `file`:

```json
"proofs": [
  {
    "tag": "cache",
    "heading": "Cached under a new key",
    "body": "Both keys carry the v2 segment and no unversioned key was touched. The screen showed the right total either way — this is what proves it was recomputed rather than served from the pre-deploy key.",
    "capture": "GET /businesses/6a59f2c1/gstr2b-reconciliation/detailedview?period=062026\n→ 200\n{\"redis\":{\"get\":\"serana:gstr2brecon:v2:6a59f2c1:062026\",\n          \"set\":\"serana:gstr2brecon:v2:6a59f2c1:062026\",\"ttl\":604800}}"
  }
]
```

Each entry is three parts: `heading` names what it settles, `capture` is the **verbatim exchange** that decides it,
and `body` is what that exchange settled.

`capture` is the input and the output as they went over the wire: the request exactly as sent — method, full path,
the body as JSON — then the status, then the complete response body as it came back, **however long**; the block
renders collapsed, so length costs a reader nothing until they open it. The same shape whether it's HTTP, a log, a
query (the SQL as run, the rows as returned), or a file. Redact secrets as `<redacted>`, and say in `body` when the
exchange ran against a stand-in for the real thing.

**Several calls settling one mechanism go in one entry, in the order you drove them**, separated by a blank line —
the retry after the conflict, the read-back after the write.

`artifacts[]` is for files **the product produced** — a webhook body it posted, a file it delivered, a document it
generated.

**Read the scenario's video, then its proofs: an entry that told you nothing the video left open should not have
been written.**

### Coverage and the derived verdict

`coverage[]` at the top level is the scope ledger: **one entry per requirement id the feature's docs list**, whether
or not you reached it. It is what makes an incomplete run visible instead of arithmetically green.

```json
"verdict": "PARTIAL",
"coverage": [
  { "req": "R2", "scenario": "01", "verdict": "Success" },
  { "req": "R5", "scenario": "07", "verdict": "NOT VERIFIED" },
  { "req": "R15", "scenario": "12", "verdict": "INVALID" }
]
```

Several ids pointing at one scenario is normal and good — a single walk that proves five requirements is a better
walk. What is not allowed is an id in the docs with no row here.

**`verdict` is derived from that table, never chosen:** any scenario `Failure` → `FAIL`; else any requirement
`NOT VERIFIED` → `PARTIAL`; only an all-covered, all-`Success` run is `PASS`. Compute it after the table is
complete and write what it says, including when the run you just did feels like a pass.

### Bugs

`bugs[]` at the top level, each `{severity, origin, reachedBy, title, body}` — **bugs in the application**, defects
that will bite a user or a developer.

`reachedBy` and `origin` are the two Step 4 settled before you got here — the actor and surface that produced it,
and what `git blame` said about where it came from:

```json
{
  "severity": "major",
  "origin": "pre-existing, worsened here",
  "reachedBy": "A returning customer changed plan on a lead whose proforma was raised the previous day — PATCH /demands/:leadId, ordinary account, nothing hand-written.",
  "title": "…", "body": "…"
}
```

`reachedBy` is one sentence: the actor and the surface they used. An entry you cannot write one for is not a bug —
it goes to `extra[]` as a note on what the feature trusts, or nowhere.

`origin` is one of `introduced here` · `pre-existing` · `pre-existing, worsened here`. Say in `body` which commit or
diff hunk settled it.

The same two fields belong on any scenario carrying a `Failure` verdict, for the same reasons. A misleading message, lost or corrupted data, stale UI state, a 500 reaching the user, a silent
no-op, a permission leak, a broken recovery path; or, for developers, a documented command that is gone, an artifact
contradicting the tree.

Each is a bug report a maintainer could act on without asking you a question: what it is, its severity (blocker /
major / minor) and why that rung and not the one above, the repro, what happens, what should happen, and the video.
Most consequential first. Your infrastructure adventures, the data you couldn't find, and the workaround that got
the stack up go in what you report back to whoever dispatched you (Step 6). Found no bugs? Leave `bugs` empty; the
sentence from Step 4 naming your best attack and why it didn't land goes in `bugsNote`, which renders either way.

What this run could not reach goes in `gaps[]` — one entry per `NOT VERIFIED` scenario, and every field is
required, because a gap without them is indistinguishable from an early stop:

```json
"gaps": [
  {
    "scenario": "07",
    "req": "R5",
    "mechanism": "`shouldCreateProforma()` at src/hooks/create-proforma-against-lead.js:310 requires the lead to carry both `product` and `pricePlan`; this environment's Premium business has no product with a price plan.",
    "attempted": ["seeded a lead through the service and drove PATCH /demands/:id",
                  "set source=PREMIUMN and retried",
                  "re-ran with DEBUG=* and read the hook's own branch trace"],
    "wouldClose": "A product with at least one price plan on the Premium business, or a fixture that builds one."
  }
]
```

`mechanism` is the cause Step 4 made you read the blocking path for, written to the standard set there — the
sentence above passes it. `attempted` is what you actually ran, distinct approaches rather than retries of one.
`wouldClose` is the concrete thing a human or a later run can supply.

## Completion checklist — the report is done when all of these hold

- The JSON island parses, and the file opens in a browser showing every scenario. A report that does not render is
  not a report — open it and look before you call this done.
- `coverage[]` has a row for every requirement id the docs list, and `verdict` is what the derivation rule computes
  from it — not what the run felt like. Grep the docs for their id pattern and diff that set against the table
  before you call this done.
- Every `NOT VERIFIED` scenario has a `gaps[]` entry whose `mechanism` names a line, condition, credential or
  absent datum, with `attempted` listing distinct approaches and `wouldClose` naming the concrete unblock.
- Every `bugs[]` entry and every `Failure` scenario carries a `reachedBy` naming a real actor and the surface they
  used, and an `origin` of `introduced here` / `pre-existing` / `pre-existing, worsened here` settled by `git blame`
  or the diff. An entry whose `reachedBy` you cannot write without saying "I wrote the value into the database
  myself" is not a bug — move it to `extra[]` or drop it.
- Every scenario carries an `expected` taken from the docs, `steps` naming the values it sent, and a `reason` that
  reads as the diff between the two.
- Every `capture` shows a request a dev could paste and the complete response it returned, inline — nothing about an
  exchange is left in a file for the reader to go and open.
- `summary` opens the report with what the feature does, what was tested, and what the verdict means for shipping.
- Every scenario has a stable `n`, a `verdict`, and a `reason`, and every behaviour the docs describe is covered. One
  you could not verify is a scenario with `NOT VERIFIED` and a reason saying what would close it; one that turned out
  not to apply is `INVALID` with why. Neither is dropped, and neither is quietly backfilled with an adjacent passing
  check.
- Every verdict cites a live observation from this run — a DOM assert, an HTTP status and body, a DB read-back, a
  measured rect, a captured webhook body. This is the only thing separating a real verification from a plausible
  one. Where that observation is mechanism rather than surface, it is a `proofs[]` entry, written once.
- Every UI scenario names its `video`, every path is report-relative, and every file named in `artifacts[]` exists
  beside the report under the same `NN_<slug>` prefix. No frame or file resolves to a broken link.
- Every side-effect scenario carries the right receipt: an **email** shows the mail-viewer frames and its video; a
  **job-queue** scenario shows a bull-board frame (queue card + job), or — only when the board couldn't be brought
  up — a log/Redis capture with a note saying why; a **webhook or delivered file** lists its captured artifact
  (`NN_<slug>.<ext>`).
- Things this skill genuinely cannot reach (touch-hold gestures, real-device sensors, visual diffs against last
  week's build) are scenarios too, marked `NOT VERIFIED`.
- No internal ids appear anywhere — the plain sequential `n` values are the only identifiers a reader needs. Nothing
  is said twice.
