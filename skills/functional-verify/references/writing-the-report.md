# Writing the Proof Report

**Read this when:** grading scenarios, assembling videos (Step 5), or writing the report (Step 6). Everything here
is done once the browser is closed; the driving and capture craft is in `driving-the-browser.md`.

**In here:**

- Grading — two tracks
- Building the videos (Step 5)
- The report format
- Completion checklist — the report is done when all of these hold

## Grading — two tracks

Grade each scenario on two tracks; they answer different questions and flow to different places.

The **documented check** answers the question you were given: do these frames show the behaviour the docs describe?
The verdict is `SUCCESS` or `FAILURE`, and it cites concrete evidence — a measured rect, a quoted string, a computed
style, a network response. Layout claims cite a measurement. This becomes the scenario's `verdict` and `reason`.

The **open visual review** asks what's wrong regardless of what was asked for: alignment, contrast, clipping,
overlap, a broken empty state, copy issues. Run it on every scenario, including the ones that passed cleanly. Treat
`truncate` and `line-clamp` on a primary headline as a bug to justify, not a default to accept. Anything real you
find here is a bug, and Step 4 owns it.

## Building the videos (Step 5)

The videos are **assembled, not captured**: ffmpeg builds each one from the promoted frames in `screenshots/`. One
video per scenario, grouped by the `NN_<slug>` prefix before the `__`, written beside the report. `SKILL.md`'s Step 5
carries the command that builds them and prints the per-scenario `ok` line.

The script builds every scenario's video and reports one line each. **A `FAILED` line fails the step** — including
one that names a **stretched** frame, which the script catches itself by comparing each source frame's aspect ratio
with the crop window cropdetect found in the video it built. The settings and the reasons for them live in the
script.

**Keep the frames** — they are the only machine-readable evidence, and a re-grade or second look needs the PNGs. If
a merge fails, name the scenario and move on; its frames still prove it.

## The report format

**The scenarios come from `verification/run-log.jsonl`, last line per scenario, not from what you remember driving.**
On a feature that has been through a fix round, most scenarios were driven by an earlier round's agent, and that line
is all there is of them. It carries the finished write-up rather than a summary of it: the line's `scenario` object is
the `scenarios[]` element itself, so a carried-over scenario is transcribed into the report rather than reconstructed.
Its `url`, `expected`, `steps`, `reason`, `proofs`, frames and labels are the ones the round that drove it wrote, and
the `requirements` beside it are what `coverage[]` maps to that scenario. The one field the terminal round fills in is
`video`, once it has built the videos. A carried-over `NOT VERIFIED` scenario's `gaps[]` entry comes from the line's
`gap` object the same way. So a carried-over scenario reads no differently from one you drove yourself.

**The one thing a ledger line cannot give you is the host.** `Base URL` is a `fields[]` row for the whole run, and the
paths in a carried-over scenario were driven against whatever host that round had. Write the host this attempt drove,
and where an earlier round drove a different one — a restarted stack landing on another port — say so in that row,
because a reader reopening an old path against the new host is the one way this report misleads.

Copy `references/proof-report-template.html` to `verification/proof-report.html` and **fill its JSON island — the
`<script type="application/json" id="report-data">` block. Change nothing else in the file.** You write data, not
markup; the template renders it. Its header comment is the field-by-field guide, and it stays in the file you ship.

The report opens on the first scenario; there is no prose preamble. The run's context lives in `drivenOn` and
`fields[]`, behind the bar's run details, and the derived `verdict` is the badge in the bar.

```json
{
  "title": "GSTR-2B monetary match",
  "drivenOn": "The reconciliation report at `/app/<business>/reports/gstr2breconciliation`, June 2026.",
  "fields": [{ "label": "Base URL", "value": "http://localhost:3000" }],
  "scenarios": [
    {
      "n": "01",
      "slug": "01_float_artefact_still_matches",
      "short": "Float artefact matches",
      "title": "An invoice whose tax total carries a floating-point artefact still reconciles against the supplier's filed entry",
      "verdict": "SUCCESS",
      "url": "/app/6a59f2c1/reports/gstr2breconciliation?period=062026",
      "expected": "An invoice whose books total is `7127.200000000001` and whose filed entry is `7127.20` reads **Complete Match**, both sides rendering ₹7,127.20.",
      "reason": "Books stored `7127.200000000001`; both sides render ₹7,127.20 and the pair reads **Complete Match**.",
      "steps": ["Open the June 2026 reconciliation report",
                { "text": "Switch to Detailed View",
                  "url": "/app/6a59f2c1/reports/gstr2breconciliation/detailedview?period=062026" },
                "Find invoice `INV-4417`, books ₹7,127.200000000001 against filed ₹7,127.20"],
      "video": "01_float_artefact_still_matches.mp4",
      "frames": [{ "src": "screenshots/01_float_artefact_still_matches__01_report_open.png",
                   "label": "June report, detailed view" }]
    }
  ]
}
```

**`url` is the path the scenario opened on** — the path with its query string, never the host:
`/app/6a59f2c1/reports/gstr2breconciliation?period=062026`. The host is one `fields[]` row, `Base URL`, written once
for the whole run, because it changes with the stack while the path is the thing under test. One path per scenario:
where a step is what moved the browser, write that step as `{text, url}` and its path renders under it, so a reader
following the walk sees where each move landed and no path is written twice. **Redact what the query carries** — this
report is read and shared beyond this run, and a driven URL routinely carries a live credential: an SSO `?code=`, a
`?token=`, a pre-signed `X-Amz-Signature`, an `?email=`. Keep the parameters that select what was under test
(`?period=062026`), write the value of any auth or identity parameter as `<redacted>`, and record the path alone for a
scenario reached through a callback or pre-signed URL. A session token is not what makes a screen reproducible.

**Write `expected` from the docs before you drive it** — one or two sentences naming the outcome and the values it
turns on. It is the bar the run is graded against, and `reason` is the diff between it and what you saw. A scenario
whose `expected` could only have been written afterwards has graded itself.

`steps` is the walk you actually drove, one plain sentence each, **each naming the value it sent** — "POST the client
as `{clientId:"v-crm-1", name:"Verify Acme"}`" rather than "POST the client" — so a dev re-runs the walk from the
report alone. They summarise the flow rather than mapping onto frames. `reason` is what decided the verdict — the
rendered string, the measured value, the status code.

Three shapes are fixed, because they are what makes two reports comparable: **`expected` renders above the walk**,
**`steps` renders numbered in order**, and
**`video` + `frames[]` render as Visual proof**, the video leading with the screenshots folded behind a toggle.
Everything else is prose you shape yourself. When something fits none of the sections, put it in `extra[]` —
`{heading, body, capture}`, all optional, no imposed shape.

### Proofs

The frame proves the **surface**; a `proofs[]` entry proves the **mechanism** underneath it. A scenario earns one
when it has one of two things a video cannot carry:

- **No surface** — it never renders anywhere. A cache key, a queue write, a webhook body, a row written by a job.
- **The mechanism behind a surface that did render** — the frame shows the outcome, the block shows it was reached
  the way it was supposed to be. The intermediate call proving the right branch was taken; the query proving the
  total was recomputed rather than served stale; the response behind a table that looks correct either way.

Where a frame already carries the surface — the board, the modal count, the toast, the received email — the entry
carries the mechanism under it. **Where there is no frame, the exchange is the whole evidence, so it goes in whole.**

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

`capture` goes in **however long it runs** — the block renders collapsed, so length costs a reader nothing until they
open it — and it keeps the same shape whether it is HTTP, a log, a query (the SQL as run, the rows as returned), or a
file. Redact secrets as `<redacted>`, and say in `body` when the exchange ran against a stand-in for the real thing.

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
  { "req": "R2", "scenario": "01", "verdict": "SUCCESS" },
  { "req": "R5", "scenario": "07", "verdict": "NOT VERIFIED" },
  { "req": "R15", "scenario": "12", "verdict": "INVALID" }
]
```

Several ids pointing at one scenario is normal and good — a single walk that proves five requirements is a better
walk. One id proven by more than one walk — a desktop scenario and its phone replay — stays **one row** whose
`scenario` names them both (`"01, 09"`), carrying `FAILURE` if either failed and `NOT VERIFIED` if either went
unproven. What is not allowed is an id in the docs with no row here.

**`verdict` is derived from that table, never chosen:** any scenario `FAILURE` → `FAIL`; else any requirement
`NOT VERIFIED` → `PARTIAL`; only an all-covered, all-`SUCCESS` run is `PASS`. Compute it after the table is
complete and write what it says, including when the run you just did feels like a pass.

### Bugs

`bugs[]` at the top level is **bugs in the application** — defects that will bite a user or a developer: a misleading
message, lost or corrupted data, stale UI state, a 500 reaching the user, a silent no-op, a permission leak, a broken
recovery path; or, for developers, a documented command that is gone, an artifact contradicting the tree.

`scenario` is the `n` of the scenario that reproduces it — the Step 4 walk you filmed for this bug. It is what
carries the reader from the Bugs pane to the expectation, the observed behaviour and the video, so the entry never
restates them.

**A bug an earlier round fixed gets no entry and no note**: `bugs[]` carries only what is still broken when the report
is written, so a round-1 bug that round 2 fixed leaves a passing scenario and no trace of itself, because every entry
is backed by a scenario that reproduces it now.

`reachedBy` and `origin` are the two Step 4 settled before you got here — the actor and surface that produced it,
and what `git blame` said about where it came from:

```json
{
  "severity": "major",
  "origin": "pre-existing, worsened here",
  "reachedBy": "A returning customer changed plan on a lead whose proforma was raised the previous day — PATCH /demands/:leadId, ordinary account, nothing hand-written.",
  "scenario": "09",
  "title": "…", "body": "…"
}
```

`reachedBy` is one sentence: the actor and the surface they used. An entry you cannot write one for is not a bug —
it goes to `extra[]` as a note on what the feature trusts, or nowhere. Say in `body` which commit or diff hunk settled
`origin`.

The same two facts belong on any scenario carrying a `FAILURE` verdict, for the same reasons. A scenario has no fields
of its own for them, so they go in its `reason` — one sentence naming the actor and surface, one naming what `git
blame` settled.

Each is a bug report a maintainer could act on without asking you a question: what it is, its severity (blocker /
major / minor) and why that rung and not the one above, and the repro. What should have happened and what did are
already the scenario's `expected` and `reason`, so the entry names that scenario in `scenario` rather than
restating them — and the reader reaches its video from there. Most consequential first. Your infrastructure
adventures, the data you couldn't find, and the workaround that got the stack up go in what you report back to
whoever dispatched you (Step 6). Found no bugs? Leave `bugs` empty; the sentence from Step 4 naming your best
attack and why it didn't land goes in `bugsNote`, which renders either way.

What this run could not reach goes in `gaps[]` — one entry per `NOT VERIFIED` scenario, every field filled:

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

- The JSON island parses, and the file opens in a browser showing every scenario — open it and look before you call
  this done.
- `coverage[]` has a row for every requirement id the docs list, and `verdict` is what the derivation rule computes
  from it. Grep the docs for their id pattern and diff that set against the table before you call this done.
- Every `NOT VERIFIED` scenario has a `gaps[]` entry whose `mechanism` names a line, condition, credential or
  absent datum, with `attempted` listing distinct approaches and `wouldClose` naming the concrete unblock.
- Every `bugs[]` entry carries a `reachedBy` naming a real actor and the surface they used, and an `origin` of
  `introduced here` / `pre-existing` / `pre-existing, worsened here` settled by `git blame` or the diff. Every
  `FAILURE` scenario carries both in its `reason`.
- Every `bugs[]` entry names in `scenario` the `n` of the scenario that reproduces it, and that scenario exists with
  the `expected` and `reason` the entry leans on.
- Every scenario carries an `expected` taken from the docs, `steps` naming the values it sent, and a `reason` that
  reads as the diff between the two.
- `fields[]` carries a `Base URL` row; every scenario that drove a page or a request carries the `url` it opened on,
  path and query and no host; and every step that moved the browser to another path carries that path.
- No `url` in the report carries a live credential: an auth or identity parameter's value reads `<redacted>`, and a
  path reached through a callback or a pre-signed URL records no query at all.
- Every `capture` shows a request a dev could paste and the complete response it returned, inline — nothing about an
  exchange is left in a file for the reader to go and open.
- Every scenario has a stable `n`, a `verdict`, and a `reason`, and every behaviour the docs describe is covered. One
  you could not verify is a scenario with `NOT VERIFIED` and a reason saying what would close it; one that turned out
  not to apply is `INVALID` with why. Neither is dropped, and neither is quietly backfilled with an adjacent passing
  check.
- Every verdict cites a live observation from this run — a DOM assert, an HTTP status and body, a DB read-back, a
  measured rect, a captured webhook body. Where that observation is mechanism rather than surface, it is a `proofs[]`
  entry, written once.
- Every UI scenario names its `video`, every path is report-relative, and every file named in `artifacts[]` exists
  beside the report under the same `NN_<slug>` prefix. No frame or file resolves to a broken link.
- Every side-effect scenario carries the receipt its sink produces: an **email** shows the mail-viewer frames and
  its video; a **job-queue** scenario quotes the read from the queue's storage, naming the queue, the job id and the
  state it was found in; a **webhook or delivered file** lists its captured
  artifact (`NN_<slug>.<ext>`). An effect this stack has no sink for is `NOT VERIFIED` with that sink named.
- Things this skill genuinely cannot reach (touch-hold gestures, real-device sensors, visual diffs against last
  week's build) are scenarios too, marked `NOT VERIFIED`.
- No internal ids appear anywhere — the plain sequential `n` values are the only identifiers a reader needs. Nothing
  is said twice.
