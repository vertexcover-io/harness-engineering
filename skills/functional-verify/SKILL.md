---
name: functional-verify
description: >
  The gate between "tests are green" and "feature is done" — MUST run before claiming a feature
  complete, opening a PR, or moving to commit, and whenever orchestrate enters its verify stage.
  Passing unit and e2e tests are not verification; this is where you drive the app through its UI,
  the way the user and QA do, and try to break it. Trigger on "tests pass", "implementation done",
  "ready for review", "ready to ship", "ship it", "verify this", "is this working", "can we merge",
  or any other move toward calling a feature finished. The only proof this skill ran is
  .harness/<SPEC_NAME>/verification/proof-report.md — if that file does not exist for the
  current spec, verification did not happen and the feature is not done.
user-invocable: true
---

# Functional Verify: The Gate

**Announce at start:** "Starting functional verification — driving the app through its UI and trying to break the feature."

## Your Contract

You are the gate between "tests are green" and "feature is done." Confirming the happy path is not
your job — the test suite already did that.

You verify **through the UI**, because that is where the user and the QA who wrote these scenarios
actually work. A requirement reachable through a form, a page, or a click is proven by driving that
form, page, or click. The API section exists for the surfaces a QA could never reach — a Bezz
endpoint, a webhook, a cron job — and for nothing else. A claim tagged `type: "api"` that a user
reaches through a screen is a UI scenario; the tag describes how it was built, not how it is proven.

You produce **one file**: `.harness/<SPEC_NAME>/verification/proof-report.md`, and the
evidence beside it. No proof report means no verification, which means not done.

**The report is written for a QA reader, not for a machine.** They know the product; they have never
heard of your claim ids. Nothing in it is gated, greped, or parsed, so write it the way you would
write it for a person: plain English, no `VS-1.1`, no `PHASE1-C1`, no `REQ-005`. When a scenario
comes from a spec requirement, say what the requirement *is* rather than naming it.

**Verification artifacts are never committed.** The report, the frames, and the videos live on disk
for a human to review and go no further. Before you write anything, make sure the project ignores
them — `.harness/*/verification/` in the repo's `.gitignore`, added if it is missing. A
screenshot in git is a mistake that outlives the branch.

**One subject, one place.** A scenario, a bug, a gap — each is written once and referenced from
anywhere else that needs it. Reference, never restate. Splitting a report by evidence type
(API / UI / DB) shreds a single scenario across four sections and forces every bug to be retold in
each: that is how these reports became unreadable. Evidence lives with the scenario it proves.

Three things are non-negotiable, and each is a verification failure if you skip it:

1. **Evidence, not adjectives.** Every claim cites something concrete — a rect from
   `getBoundingClientRect()`, a quoted string, a computed style, an HTTP response, a console
   message, a video. "Looks fine", "feels off", and "polished" are not evidence.
2. **The adversarial pass runs.** Spec scenarios prove what was specified; the adversarial pass
   (Step 5) finds what wasn't. It is mandatory.
3. **Skipping is detectable.** The Stop hook (`.claude/hooks/check-proof-report.mjs`) blocks session
   end when an active spec has no `proof-report.md`.

## Inputs

- **Design** — `.harness/<SPEC_NAME>/design.md` (its `## Personas & Flows` and `## Verification Intent` are your scenario sources; absent when brainstorm was skipped)
- **Plan** — `.harness/<SPEC_NAME>/plan.md` (its Test Matrix's `functional-verify` rows name the human-observable properties; per-phase breakdowns in `.harness/<SPEC_NAME>/phases/phase-*.md`)
- **Claims** — `.harness/<SPEC_NAME>/claims.json` when orchestrate aggregated them, otherwise the per-phase `phase-*-claims.json`. Schemas: `skills/orchestrate/references/phase-claims-format.md` and `skills/orchestrate/references/claims-aggregation-format.md`. Required to read when present.
- **E2E report** — `.harness/<SPEC_NAME>/e2e-report.json`, the coder's raw e2e run summary. Its `gaps` array names the blind spots the coder already knows about — you seed the adversarial pass (Step 5) from it.

Claim ids are how you keep track of what you have covered. They are working notes: none of them
reach the report.

## Step 0 — Read Claims, Route by Surface, Refuse Double-Runs

If `verification/proof-report.md` already exists for this spec in this session, report the existing
path and stop. The user will ask if they want a re-verify.

Then read the claims. The **top-level** `passed` / `failed` counts are what carry the run's result —
a `failed > 0` is a blocker: report and stop. Individual claims commonly have no status of their own,
so read the totals rather than expecting a verdict per claim.

Route each claim by **the surface a QA can reach**, not by its `type` tag:

- **Reachable through a screen** → a UI scenario for Step 4, proven live in the browser. Every
  `type: "ui"` claim lands here, and so does any `api`/`db`/`logic` claim whose behaviour surfaces
  in a page. A validation rule enforced in a form is proven in that form.
- **Reachable only headlessly** → an API scenario for Step 3. Machine-to-machine endpoints, webhooks,
  scheduled jobs, and background writes with no rendered surface.

When a claim has both a UI path and an API path, drive the UI path — that is the one the user
travels — and reach for the API only to corroborate what the screen showed you. A claim with no
matching spec requirement is still in scope: verify it anyway.

Claims arrive in either of two shapes and both are normal: orchestrate writes an aggregated
`claims.json` after the last coder phase, while a standalone run sees only `phase-*-claims.json`.
Read whichever exists. If neither does, say so and derive scenarios from the design and plan instead.

## Step 1 — Verification Scenarios

Take a scenario from each thing the artifacts ask you to prove: the design's `## Personas & Flows`
(numbered, tester-walkable steps — walk them as written), its `## Verification Intent` (properties
needing human judgement, stated by no requirement — work out the walk yourself), its
`## Requirements & Decisions` (the `R#`/`EC#` an actor can observe), and the plan's Test Matrix
rows at the `functional-verify` level.

With no design.md, derive one scenario per requirement in plan.md, routing each by the same
surface test as Step 0. If nothing can be derived, report "No functional verification scenarios —
skipping" and stop. Every scenario traces to something the artifacts or the claims actually say.

**Name each scenario for what it proves**, in kebab-case, as a phrase a QA would recognise:

```
float-artefact-still-matches
half-rupee-gap-matches
51-paise-gap-stays-partial
wrong-invoice-number-never-auto-matches
```

That name is the scenario's evidence folder, and it is the first cell of its row in the report. It
has to be fixed before you capture anything, so decide it now. `VS-1` and `PHASE4-C2` name nothing —
a reader should learn what was tested from the folder alone.

## Step 2 — Start Infrastructure

Bring the app up the way the project says to. Most projects document this somewhere their
`CLAUDE.md` points at — a skill, a `just` or `make` target, a compose file — and that documented
path beats anything you would derive, because it already knows which services exist, what order they
boot in, and which ports they take. Follow it. Only when nothing documents a procedure do you derive
one yourself, and `references/infra-startup.md` carries that fallback: probe before assuming,
allocate a free port rather than fighting for a default, health-poll with a hard deadline.

However the stack came up, it reports back the same way — `.harness/<SPEC_NAME>/infra.json`,
holding `worktree`, `services`, and `datastores`. Steps 3, 4, and 8 all read from it, and the shape
is documented in `references/infra-startup.md`. Take every URL from that file rather than from
memory: ports are commonly allocated per worktree, so a port you remember is a port that now belongs
to someone else.

If startup fails, read the log it names and stop. Driving a browser at a dead app is what turns a
crashed service into a 120-second selector timeout that reads as "stuck" — you spend the next twenty
minutes debugging the test instead of the crash. When you genuinely cannot get the app running,
that is **BLOCKED:no-infra**: say which service failed and what you tried, and don't paper over UI
scenarios with adjacent API checks.

**A health check that passes is not a page that renders.** Port-based polling proves a process is
listening, nothing more — a dev server whose file watcher died can report healthy while every route
returns 404 inside a rendered app shell. Before you trust the stack, fetch the actual route you came
to drive and confirm it returns the page you expect.

**Write your artifacts beside the plan.** `verification/` goes in the same
`.harness/<SPEC_NAME>/` directory you read `plan.md` from — which is inside the worktree when
the plan lives there, and in the main checkout when it doesn't. A report that lands somewhere other
than next to the thing it verifies is a report the next reader won't find.

What you must not do is create a directory a launcher could mistake for a service. Launchers commonly
decide what to boot by looking for service directories at the workspace root, so an output folder in
the wrong place can make the next run try to start a service that was never there. That is a rule
about the workspace root, not about the worktree.

## Step 3 — API Verification: The Surfaces a QA Cannot Reach

Only the scenarios Step 0 routed here. If a scenario reached this step because driving its screen
looked slower than curling its endpoint, it is in the wrong step — send it back to Step 4.

Run curl with `-w '\n%{http_code}'`, and capture the exact command, the status, and the body. There
is no separate receipt file: what you capture here is transcribed directly into the report's API
section in Step 6, so capture it in the shape that section wants — a short description, the request
line and its status, the body that decides the verdict, and what actually happened. Truncate long
bodies to the fields under test.

Record the verdict by exact-matching the spec's expected response — Success or Failure, and a
response either matches or it doesn't. When a scenario has a db check, query the database (an MCP
tool if one is available, otherwise the URI from `datastores` in `infra.json`) and record actual
against expected.

## Step 4 — UI Verification: Film the Whole Life of the Scenario

Drive a real browser through the `agent-browser` CLI. This is where **every UI scenario is proven
live** — the one thing the phase tests cannot do for you. A passing `.spec.ts` is corroborating
evidence, never a substitute. The e2e suite is a different artifact with a different job: leave
`.spec.ts` files and `npx playwright test` to it, and prove your scenarios by driving the browser
yourself.

Check the binary first. If `agent-browser` isn't on PATH, stop with **BLOCKED:no-agent-browser**,
name the scenarios you couldn't prove, and print the install command:
`npm i -g agent-browser && agent-browser install`. A spec with UI scenarios and no `agent-browser` is
a hard failure, not something adjacent API checks can paper over.

Open the UI service named in `services`. Which one that is comes from the project, not from this
file — a repo with four frontends has four entries there and only its own docs know which one your
spec means, so read what the project says before you guess.

`references/agent-browser-capture.md` carries the driving craft — batching, the `eval` laws, what
`--bail` really does. Read it before your first `open`; it is short, and every trap in it cost a
previous run real time. It is deliberately app-agnostic: how *this* app handles login, and which of
its surfaces lie about their own state, are things the project documents, and they will save you more
time than anything here. Go find them first.

Open one session and hold it for every scenario.

### The Capture Loop

Each scenario gets the folder you named in Step 1, and everything it produces lives there — its
frames now, its video after Step 7:

```
verification/half-rupee-gap-matches/01-open-june-reconciliation.png
verification/half-rupee-gap-matches/02-detailed-view.png
verification/half-rupee-gap-matches/03-pair-reads-complete-match.png
verification/half-rupee-gap-matches/proof.mp4
```

`NN` is zero-padded from `01` — Step 7 assembles frames in filename order, so `10-export.png` sorts
before `2-filter.png` and the video tells a story that never happened. The slug says what the frame
shows.

**Film the whole life of the scenario, not a checklist of its steps.** The frames are what a reviewer
watches to believe you, so shoot whatever it takes for the flow to make sense end to end: the state
you started from, the data you seeded, each step of the walk, the intermediate render that explains
why the next click works, the toast that confirms it. Every step earns at least one frame and many
earn more. A scenario with more frames than steps is doing this right.

For every action, run one batch that acts, asserts, and captures:

```bash
cat <<'EOF' | agent-browser batch --json
[["eval","(()=>document.querySelector('[data-testid=add-more]').click())()"],
 ["eval","(()=>({n: document.querySelectorAll('[data-testid^=row-]').length}))()"],
 ["screenshot","/abs/path/to/verification/half-rupee-gap-matches/03-rows-added.png"]]
EOF
```

**Write the screenshot path absolute.** The heredoc is quoted so nothing interpolates, and your shell's
cwd resets between calls — a relative path in there either lands somewhere you didn't expect or writes
a file literally named after your placeholder.

Then **`Read` the PNG you just captured** and confirm it shows what you think it shows.

Those are two different checks and you need both. **The assert answers whether the state took hold** —
a click that silently no-ops looks identical to a click that worked until you ask the DOM. **The Read
answers whether the frame shows it** — frames lag renders, and a frame that caught the previous state
is a frame that will lie inside the video for the rest of this feature's life. Read at the moment you
shoot, not at the end of the scenario: by then the app has moved on and a bad frame can no longer be
re-shot.

**When they disagree, one of them is lying — find out which.** The frame lagging a render is the
common case, and then you `wait` on the condition and re-shoot. But the assert is wrong often enough
to check first: it matched `innerText` across a line break the layout inserted, it measured a rect in
the same batch as the scroll that moved it, or it passed vacuously over a selector that matched
nothing. Settle it by asking the page a second way, not by deciding which one you trust. Two runs
would have shipped a false claim by trusting a bad assert over an honest frame.

**Wait on the condition you actually mean.** `wait --text`, `--url`, `--load networkidle`, or
`wait @eN` return the moment it holds, so the fast path costs milliseconds and the slow path still
gets its time. A fixed `sleep` pays its worst case every time and still races the render underneath
it — one run spent 341 seconds sleeping and captured stale frames regardless.

Frame a non-feature element at the top and bottom edge of each shot: a tight crop of the feature
alone hides the neighbour-ordering bugs (a sticky bar landing mid-page, orphaned actions, a header
misaligned once the feature mounts) that are half the reason to look. Before driving anything, read
the project's page-level layout contract — usually the routing/layout section of CLAUDE.md or the
page component — and note the expected vertical ordering of the page's top-level sections. That
ordering is a layout invariant your frames must uphold alongside the feature's own checks.

Prefer a cropped or clipped shot over a full-page one: it keeps the frame readable at video size,
which is the only size most people will ever see it at.

### The Frame That Proves It

Every scenario turns on a few facts held together — *these two numbers differ by this much, and the
verdict says this*. **Get them into one frame.** Evidence split across two shots asks the reader to
trust your ordering, and a wide table is exactly where that happens: one frame carries the verdict
while the amounts sit off-screen, the next carries the amounts with no way to tell which row they
belong to.

Work in this order, and stop as soon as the shot holds:

1. **Use the app's own controls.** A column chooser, a density toggle, a collapse. Cheapest and most
   honest, because it's a thing the user can do. **Restore what you changed** — these settings persist
   for the account you're driving.
2. **Set the viewport to fit** — `agent-browser set viewport 1600 900`. Yours to choose, and it costs
   nothing.
3. **Only if neither works, overlap.** Keep an identifying column in every frame so the shots stitch,
   and say in the report that the evidence spans frames.

Then check the shot actually shows what you think, because **a rect inside the viewport is not a
visible cell.** `getBoundingClientRect()` is blind to occlusion: a sticky action overlay sitting over
the value column measures `visible: true` and photographs as covered. Ask the page what is on top of
each cell you are about to offer as evidence:

```js
(()=>{const r=el.getBoundingClientRect();
      const top=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
      return {covered: !(el===top || el.contains(top))};})()
```

**Every cell the frame is offered as evidence for must be un-occluded at its own centre, and the row
must be identifiable in that same frame.** A rule about what's "in frame" passes a shot whose numbers
are hidden behind an overlay; occlusion is the failure mode that silently defeats it.

### Grading: Two Tracks

Grade each scenario on two tracks, because they answer different questions and flow to different
places.

The **spec-based check** answers the question you were given: do these frames show the requirement
met? The verdict is Success or Failure, and it cites concrete evidence — a measured rect, a quoted
string, a computed style, a network response. Layout claims cite a measurement; "no horizontal
scroll" is one measurement, not proof that a layout is correct. This becomes the scenario's row in
the report.

The **open visual review** answers a question nobody asked: what's wrong here anyway? Alignment,
contrast, clipping, overlap, a broken empty state, copy issues. Passing spec checks do not let you
skip it — in a real run this track produced two bugs that no scenario would ever have caught. Treat
`truncate` and `line-clamp` on a primary headline as a bug to justify, not a default to accept.
Anything real you find here is a bug, and Step 5 owns it.

**Step 4 is done when every UI scenario has a folder whose frames tell its whole story, and every
frame has both a passing assert and your own eyes behind it.** A frame with no assert behind it is
not evidence.

## Step 5 — Adversarial Pass (MANDATORY — Role Swap)

> **STOP. You are no longer the verifier. You are the critic.**
>
> The verifier you just were spent the last N tool calls confirming the
> happy path works. They were almost certainly wrong about at least one
> thing. Your job is to find it. You are graded on bugs discovered,
> not on agreement with the prior verdicts.

This pass runs in the same context — subagents can't spawn subagents — so its isolation comes from
discipline. Three mitigations are mandatory. **Force a context break**: before generating scenarios,
re-read only `design.md`, the claims, and `e2e-report.json` (whichever are present), and leave any
draft of the proof report closed — it biases you toward agreeing with what you already wrote.
**Target the gaps**: start from the `gaps` array in `e2e-report.json` — those are the coder's own
declared blind spots — then extend by diffing spec ACs against the claims to find requirements no
claim covers. With neither file present, derive gaps from the spec's error paths, boundary values,
out-of-order flows, concurrent actions, and stale-state operations. And **show your work**: a bare
"no bugs found" is a verification failure. Name the attack you most expected to land and say why it
didn't — that sentence is what distinguishes a pass from a shrug.

### 5.1 Derive Attack Surface and Generate Scenarios

For each gap, generate at least two scenarios per category that applies:

- **Boundary inputs** — empty, null, whitespace-only, max-length, max-length+1, wrong type, unicode/emoji, SQL/HTML/`<script>` (escaping check, not exploit), negative, zero, very large, leading/trailing zeros, dates in past/far-future/invalid.
- **Unexpected sequences** — cancel mid-flow, double-submit, navigate back during save, reload mid-operation, two tabs submitting the same form, log out mid-flow.
- **Broader surface** — if the change is one field on a settings page, exercise every other field on that page to catch regressions.
- **Error recovery** — after triggering an error, can the user recover, or is state left stale in UI, DB, or cache?
- **Status accuracy** — on cancellations, timeouts, and partial failures, does the visible status match the actual outcome? (The classic bug: a "Saved" toast on a 500.)
- **Permissions / auth** — the same action as a different role, an expired session, a missing token. The UI's rules are not the API's rules; a scope enforced only in a form is a scope the API will let you skip.
- **Concurrency** — two writers, read-during-write, optimistic-lock conflicts.

Find out what the stack actually isolates before you write any of these. A common arrangement gives
each worktree its own ports while every worktree shares one database and one search index, and that
changes what these scenarios mean: data you seeded in another tree is present in this one, a fixture
name collides with a run you've forgotten about, and "the state is clean" becomes a claim you have
to check rather than assume. The project's own docs say which of its datastores are shared —
`datastores` in `infra.json` tells you what exists, not what's isolated. Read them, then name
fixtures uniquely. Shared state is not purely a hazard, either: it is what makes concurrency and
stale-data scenarios honest instead of theoretical.

Happy-path scenarios already proven in Step 4 are done; spend the pass elsewhere.

### 5.2 Run Them, Then Route What You Find

Drive them the same way you drove Step 4 — same open session, same folder-per-scenario named for what
it probes, same frames, same Read. A probe that finds a bug is a scenario like any other: it earns a
folder, a video, and a row in the same table. Where the probe has no screen to drive, it is an API
scenario and follows Step 3.

Then route each result by **provenance, not verdict**:

- It probed a scenario you were **given** — a boundary on a validation rule the spec names, a country
  the spec lists, an error path a claim asserts. The result is evidence for **that scenario's row**,
  not a row of its own. **Expect most probes to land here.**
- It probed something **nobody asked about** and found a real bug. That earns its own row and a
  write-up under the table.
- It probed something nobody asked about and the feature held. It does not appear in the report at
  all. Say so in the sentence that names your best attack.

A rejection you provoked is the feature working: a 400 on bad input is evidence for whichever
scenario owns that rule, not a bug. Check the spec's `## Out of Scope` before calling anything a bug
— a behaviour the spec deliberately excludes is expected, though it still needs a decision if another
artifact of the same feature contradicts it.

**Every bug is filmed by re-running its repro.** You cannot capture a bug prospectively — you don't
know a probe landed until it lands — so once one does, write its steps, then drive them again as its
own scenario, filming the whole thing. Re-running is not waste: it is how you learn your repro
reproduces. Steps that fail on the second pass are steps that would have failed for the reviewer, and
you find that out now rather than in review. A bug that survives its own re-run arrives with a video
an engineer can watch instead of reconstruct.

**Done when every bug has a row and reproduces from its own steps — demonstrated by the re-run, not
asserted.**

## Step 6 — Write the Proof Report

One file, `verification/proof-report.md`, written for someone who knows the product and has never
seen your claim ids. **No summary section above the table** — no "bottom line", no findings digest, no
executive paragraph. One line naming where you drove and as what, then the table.

```markdown
# Proof Report — GSTR-2B Monetary Match

Driven on the reconciliation report at `/app/<business>/reports/gstr2breconciliation`, June 2026.

| What is to be tested | Steps | Success/Failure | Reason/Details | Reference |
|---|---|---|---|---|
| An invoice whose tax total carries a floating-point artefact still reconciles against the supplier's filed entry | 1. Open the June 2026 reconciliation report<br>2. Switch to Detailed View<br>3. Find the invoice filed at ₹7,127.20 | Success | Books stored `7127.200000000001`; both sides render ₹7,127.20 and the pair reads **Complete Match** | `verification/float-artefact-still-matches/proof.mp4` |
| A pair whose amounts differ by exactly ₹0.50 is treated as a match | 1. Open the July 2026 report<br>2. Find the invoice booked at ₹10,000 against ₹10,000.50 filed | Success | Screen shows the ₹0.50 difference and still reads **Complete Match** — the boundary is inclusive | `verification/half-rupee-gap-matches/proof.mp4` |
| A pair with the same GSTIN and date but a different invoice number is never auto-matched, even within ₹0.50 | 1. Open the September 2026 report<br>2. Find the pair booked at ₹10,000 against ₹10,000.40 filed | Success | Reads **Partial Match** — the amounts were compared exactly because the invoice numbers differ | `verification/wrong-invoice-number-never-auto-matches/proof.mp4` |
| Reconciliation results are cached under a fresh key so stale pre-deploy results are not served | see *Cached under a new key* below | Success | Both cache keys carry the new version segment | [below](#cached-under-a-new-key) |
```

**Write the first cell as a sentence**, the one a QA would use to describe the test. Not an id, not a
label — what is actually being proven. The Reference cell points at the scenario's video, and the
folder name in that path says the same thing in miniature.

Steps are the walk you actually drove, numbered. They do not map one-to-one onto the frames, and they
are not meant to: the frames film the whole flow, the steps summarise it.

Reason/Details is a sentence naming the observation that decided the verdict — the rendered string,
the measured value, the status code. A paragraph in a table cell is a paragraph that lost its
formatting: when something needs more room, put it under the table and point the row at it.

Then the API section, one block per API scenario, titled for what it proves:

```markdown
### Cached under a new key
Description: A reconciliation run writes its result under a versioned cache key, so results cached
before the deploy are never served.
Request: GET /businesses/$B/gstr2b-reconciliation/detailedview?period=062026 → 200
{"redis":{"get":"serana:gstr2brecon:v2:6a59…:062026",
          "set":"serana:gstr2brecon:v2:6a59…:062026","ttl":604800}}
Both keys carried the v2 segment and no unversioned key was touched. This has no screen — the cache
is invisible to the user — so it is proven at the API.
```

Description, the request line with its status, the body that decides the verdict, and a closing
sentence on what actually happened. That block is the receipt — there is no separate receipt file.

### Bugs

Below the table, a section for **bugs in the application** — defects that will bite a user or a
developer. A misleading message, lost or corrupted data, stale UI state, a 500 reaching the user, a
silent no-op, a permission leak, a broken recovery path; or, for developers, a claim citing a test
file that no longer exists, a documented command that is gone, an artifact contradicting the tree.

Each is a bug report a maintainer could act on without asking you a question: what it is, its
severity (blocker / major / minor) and why that rung and not the one above, the repro, what happens,
what should happen, and the video. Most consequential first.

**What is not a bug, and does not belong in this report:** your infrastructure adventures, the data
you couldn't find, the workaround that got the stack up, the thing that took three tries. None of
that is a defect in the product, and a reader looking for what's broken should not have to wade
through your journey to find it. Put it in what you report back to whoever dispatched you (Step 7).

Found none? Say so in one line, with the sentence from Step 5 naming your best attack and why it
didn't land.

**Done when all of these hold:**

- Every scenario has a row and a verdict, and every requirement you were given is covered by one. A
  requirement you could not verify is a row reading `NOT VERIFIED` with the reason and what would
  close it — never dropped, and never quietly backfilled with an adjacent passing check. Name the
  gap.
- Every verdict cites a live observation from this run: a DOM assert, an HTTP status and body, a DB
  read-back, a measured rect. This is what makes the report re-runnable and is the only thing
  separating a real verification from a plausible one.
- Every UI scenario's row points at its video.
- Things this skill genuinely cannot reach (touch-hold gestures, real-device sensors, visual diffs
  against last week's build) are rows too, marked `NOT VERIFIED`.
- No claim ids, scenario ids, or requirement labels appear anywhere in the file.
- Nothing is said twice.

## Step 7 — Build the Videos, Then Report Back

The videos are **assembled, not captured**: ffmpeg builds each one from the frames you already read
and graded. That is what makes a clip evidence — every frame in it is a frame you asserted against,
in the order you drove it. The browser's own `record` verb plays no part here.

For each scenario folder:

```bash
for d in verification/*/; do
  ls "$d"*.png >/dev/null 2>&1 || continue
  ffmpeg -v error -y -framerate 1/2 -pattern_type glob -i "$d*.png" \
    -vf "scale=1280:720:force_original_aspect_ratio=decrease,\
pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p" \
    -c:v libx264 -preset veryfast -r 30 "$d/proof.mp4" \
    && echo "ok  $d/proof.mp4" || echo "FAILED $d"
done
```

Two seconds a frame, padded to a common 1280×720 so a mobile-viewport frame and a full-page frame can
sit in one timeline without ffmpeg refusing the mismatch. h264/mp4 because it plays anywhere. It
iterates the folders that exist rather than the paths the report mentions, so a scenario name can
hold any character a directory can.

**The frames stay.** They are the only evidence a machine can read — a reviewer, a re-grade, or your
own second look all need the PNGs, and the video cannot be reopened by any of them. Nothing here
deletes them.

If a merge fails, say which scenario and move on. Its frames are still there and still prove the
scenario; a missing video costs a reviewer convenience, not proof.

Then **report back to whoever dispatched you** — this is where everything the report deliberately
excludes belongs:

- The verdict per scenario, and whether the feature does what it was supposed to.
- Every bug you found, and what needs a decision rather than a fix.
- The paths of the videos and their folders.
- What it took to get here: the infrastructure that fought you, the fixtures you seeded and left
  behind, the workaround the next run shouldn't have to rediscover, the project docs that were wrong.
- Anything about *this skill* that was ambiguous, wrong, or cost you time.

## Step 7.5 — Publish to Asana

Once the videos exist, push the proof report and the videos to the feature's Asana ticket, so a
reviewer finds the evidence on the task itself instead of hunting through a worktree.

The ticket is found from the **branch name**. Refrens branches are `REF-<number>` (the task's REF
custom field), and a full-text search on that string returns the one task that owns it. Everything
here is one `curl` path authenticated by `ASANA_PAT`, taken from the environment. The workspace GID
comes from `ASANA_WORKSPACE_GID` — exported env first, then a `.env` at the repo root; if it is set
nowhere, the step skips and asks you to export it.

**This step is best-effort. It never fails the verification.** No token, no match, or a failed
upload → say so in one line and move on. The proof report on disk is still the source of truth.

```bash
[ -z "$ASANA_PAT" ] && { echo "ASANA_PAT not exported — skipping Asana publish"; }

API="https://app.asana.com/api/1.0"
# Workspace GID: exported env first, then a .env at the repo root.
WORKSPACE="${ASANA_WORKSPACE_GID:-$(grep -hs '^ASANA_WORKSPACE_GID=' .env | tail -1 | cut -d= -f2-)}"
[ -z "$WORKSPACE" ] && { echo "ASANA_WORKSPACE_GID not set — export it (or add it to .env), then re-run — skipping Asana publish"; }
BRANCH="$(git branch --show-current)"       # e.g. REF-21666

# 1. Resolve the branch to a task GID (exact REF match, not a fuzzy first hit)
GID=$(curl -s "$API/workspaces/$WORKSPACE/tasks/search?text=$BRANCH&opt_fields=gid,name" \
        -H "Authorization: Bearer $ASANA_PAT" \
      | jq -r --arg b "$BRANCH" '.data[] | select(.name|test($b)) | .gid' | head -1)
[ -z "$GID" ] && GID=$(curl -s "$API/workspaces/$WORKSPACE/tasks/search?text=$BRANCH&opt_fields=gid" \
        -H "Authorization: Bearer $ASANA_PAT" | jq -r '.data[0].gid // empty')
[ -z "$GID" ] && { echo "no Asana task for $BRANCH — skipping Asana publish"; }

# 2. Post the proof report as a comment
jq -Rs '{data:{text:.}}' verification/proof-report.md \
  | curl -s -X POST "$API/tasks/$GID/stories" \
      -H "Authorization: Bearer $ASANA_PAT" -H "Content-Type: application/json" -d @- \
      >/dev/null && echo "posted proof report to task $GID"

# 3. Upload the videos — proof.mp4 only, no screenshots
for v in verification/*/proof.mp4; do
  [ -f "$v" ] || continue
  curl -s -X POST "$API/attachments" -H "Authorization: Bearer $ASANA_PAT" \
    -F "parent=$GID" -F "file=@$v;type=video/mp4" >/dev/null \
    && echo "attached $v" || echo "FAILED to attach $v"
done
```

Only the videos are attached. The screenshots stay on disk as machine-readable evidence (Step 7);
they do not go to Asana.

The search matches on the exact `REF-<number>` in the task name first, and only falls back to the
top hit if that finds nothing — so a stray task that merely mentions the number can't hijack the
upload. If the search returns more than one exact match, that is a real ambiguity: name both in your
report-back and let a human pick.

## Step 7.6 — Publish to Claude Sessions

Give the same evidence a second home: the Claude Code session you are running in. Pushing the proof
report and the videos here makes them show up in the Sessions web UI's Artifacts tab, so anyone
reading the session sees what you verified without opening the worktree.

**Check authentication first, and only then proceed.** If the `claude-sessions` CLI isn't installed
or you aren't logged in, this step does nothing — it prints one line and moves on.

**This step is best-effort. It never fails the verification.** Not authenticated, no local
transcript, session not yet captured on the server, or a failed upload → say so in one line and move
on. The proof report on disk is still the source of truth.

The session id reaches you one of two ways. **When orchestrate runs this skill as a sub-agent it
exports `SESSION_ID`** — the real top-level session — and you use it verbatim. On a **standalone run
nothing injects it**, so you derive it: a session's transcript is a `<session-id>.jsonl` file under
`~/.claude/projects/<encoded-cwd>/`, where `<encoded-cwd>` is the current working directory with every
`/` replaced by `-`, and the session you are in is the newest transcript there. Deriving from inside
an orchestrate worktree would resolve the *wrong* id — the worktree encodes to a different projects
directory than the session that launched it — which is exactly why orchestrate injects `SESSION_ID`.

```bash
# Only proceed when the CLI is installed AND authenticated.
if command -v claude-sessions >/dev/null 2>&1 && claude-sessions status >/dev/null 2>&1; then
  # Prefer the injected id (orchestrate); else derive from the newest transcript under the cwd.
  ENC=$(pwd | sed 's#/#-#g')
  SID="${SESSION_ID:-$(basename "$(ls -t ~/.claude/projects/$ENC/*.jsonl 2>/dev/null | head -1)" .jsonl 2>/dev/null)}"

  if [ -n "$SID" ]; then
    # --file/--glob replace auto-derivation, so only the report and the videos go up.
    # Both .md and .mp4 are artifact types, so one call sends them together.
    claude-sessions artifacts "$SID" \
      --file verification/proof-report.md \
      --glob 'verification/*/proof.mp4' \
      && echo "published proof report + videos to claude-sessions ($SID)" \
      || echo "claude-sessions push failed — skipping (proof report on disk is the source of truth)"
  else
    echo "no local session transcript found — skipping claude-sessions publish"
  fi
else
  echo "claude-sessions not installed or not authenticated — skipping claude-sessions publish"
fi
```

Unlike `summarize`, the `artifacts` command has no `--current` flag — it needs the session id
explicitly, which is why you resolve it above (injected first, derived as a fallback). As with Asana,
only the report and the `proof.mp4` videos are published; the screenshots stay on disk as
machine-readable evidence (Step 7).

## Step 8 — Cleanup

Close the session (`agent-browser --session <SPEC_NAME> close`). If you started the stack in Step 2,
shut it down the way the project says to, passing it `worktree` from `infra.json` — the same
documented procedure that brought it up, so teardown can't drift from startup. Anything already
running when you arrived stays running: never kill a server you didn't start.

Leave `verification/` in place, uncommitted. It is the deliverable, and it is for a human to read,
not for the repo to carry.
