---
name: functional-verify
description: >
  Verify a feature actually works by driving it — the gate between "tests are green" and "feature is
  done" — MUST run before claiming a feature complete, opening a PR, or committing, and whenever
  orchestrate enters its verify stage. Passing unit and e2e tests are not verification. Trigger on
  "tests pass", "implementation done", "ready for review", "ready to ship", "ship it", "verify this",
  "is this working", "can we merge", or any other move toward calling a feature finished.
user-invocable: true
---

# Functional Verify: The Gate

Load the `writing-style` skill before you write `verification/proof-report.html`. Run its
ship-check before you call the feature verified.

**First action: read `orchestrate.config.json` at the repo root.** Every command and package path this skill uses comes from it, resolved per `skills/orchestrate/references/config.md`.

## Your Contract

You are the gate between "tests are green" and "feature is done". A behaviour reachable through a form, page, or
click is proven by driving it in a browser (Step 2). A behaviour with no screen — a webhook, a cron job, an API
contract, a DB row — is proven headlessly at the same evidentiary bar (Step 3). **A feature with no UI is verified
entirely in Step 3, at full scope**: "backend-only" describes where the evidence comes from, never how much of the
feature you verify. You produce **one file**, `verification/proof-report.html`, and the evidence beside it — except
where the caller's fix-and-re-verify rounds defer that file, in Step 6.

- **The report is for a QA reader.** A scenario answers four questions in plain English — what was tested, what went
  in, what should have happened, what did. One behaviour per scenario, so its expectation fits in the sentences.
- **One subject, one place** — a scenario, bug, or gap is written once and referenced elsewhere; evidence lives with
  the scenario it proves.

Three things are non-negotiable, each a verification failure if skipped:

1. **Evidence, not adjectives.** Every claim cites something concrete — a rect from `getBoundingClientRect()`, a
   quoted string, a computed style, an HTTP response, a video. **A visual finding is a claim like any other**: a
   divergence from a design, or a screen called broken, names the element and quotes the observation, or it is
   not reported.
2. **The adversarial pass runs** (Step 4), over the feature and over your own gaps.
3. **Every requirement is accounted for** (*Scope*, below).

When the feature's docs describe nothing a verification could drive, report "No functional verification scenarios —
skipping" and stop.

## Inputs

- **The feature's docs** in `.harness/<SPEC_NAME>/` — PRD, design, plan, whatever exists. Scenarios come
  from what those docs say the feature must do.
- **The designs** plan.md's `## Design References` names — what each screen was supposed to look like. Those
  images are the **baseline** for the screens they draw; `references/visual-verification.md` owns what a
  baseline is authoritative about and what it is not.
- **`orchestrate.config.json`'s `environments` block and the run's `ENVIRONMENT`** — how the stack starts, seeds
  and authenticates. Step 1 works its keys.
- **The project's stack skill** — the app facts verification turns on that no key carries (self-lying surfaces,
  toast duration, where a triggered email lands, what the stack shares). This lives in the **project's own skills**
  and `CLAUDE.md`. This skill mandates no dedicated file for it — only that Step 1's two unknowns come back
  answered.
- **The coder's e2e runner reports** at `.harness/<SPEC_NAME>/phase-*-e2e.json` — the raw JSON its
  runner wrote, listing every test that actually executed. Test titles carry a scenario id
  (`SC3: …`), not a requirement id, so read the report in two hops: title id → the phase file's
  matching scenario heading → the requirement ids that heading traces to (`**SC3 — …** · R2, EC1`).
  A requirement no executed scenario traces to was never covered end to end; one whose scenarios all
  sit under `### Unit` was covered at the wrong altitude. Nobody hands you that list — deriving it is
  this skill's job.
- **`ROUNDS_LEFT`** — how many fix-and-re-verify rounds the caller has left after this attempt. Above zero means a
  fix and another verification can still follow this one; zero means this is the last. **Absent, this is the only
  attempt**: write the report, build the videos, tear down. A human invoking this skill directly passes no counter.
- **What changed since the round before**, which Step 0 derives from the ledger rather than being told. A caller that
  has just fixed code may still pass `Changed files this round:`, the `git diff --name-only` of that fix commit —
  treat it as a hint that can only add work, never as the whole list. A first attempt carries none.
- **The prior proof report a resumed run names per target** — read-only context for what an earlier run proved. The
  ledger beside it, not that report, is this run's memory; where there is no ledger beside it, this is a first attempt.
- **A level allocation is not a scope limit.** Where a doc assigns requirements to test levels — a test matrix, a
  "proven at unit level" column, a phase file claiming a scenario — it tells you where *tests* live. Read it for
  what the feature must do, and take your scope from *Scope* below. Passing unit and integration tests are the
  thing this skill exists to distrust; a requirement they cover is a requirement you verify.

## Scope: Account For Every Requirement

Before planning a single walk, enumerate the requirements, stories and edge cases the docs list, by their ids where
they have them. **That enumeration is this run's scope, and it becomes `coverage[]` in the report** — every id
mapped to the scenario that proves it and that scenario's verdict. An id with no entry is an incomplete report, not
a scoping decision.

**Scenario count is not the target**; an id with nothing behind it is what you are looking for.

**Name the holes, not just the walks.** The report's coverage table accounts for every id, so where a requirement
was proven only by a unit test, only by an API call, or not at all, say which and why — that gap list is what a
reviewer reads to decide whether the feature is really done.

## Output Layout

Everything this skill produces lives in the feature's `verification/` folder, flat:

```
.harness/<SPEC_NAME>/verification/
├── proof-report.html                        the deliverable
├── run-log.jsonl                            the run's memory across rounds (Step 0)
├── NN_<slug>.mp4                            one video per scenario (Step 5)
├── NN_<slug>.<ext>                          files the product produced: webhook bodies, downloads
└── screenshots/
    └── NN_<slug>__SS_<step>.png             every promoted frame, flat

.harness/<SPEC_NAME>/verify-staging/         scratch; frames land here first, and it is deleted at cleanup
```


**Name every scenario `NN_<slug>` before capturing anything.** `NN` is its stable two-digit number in the order you
will list them, and the scenario's `n` in the report; the slug is a phrase a QA would recognise
(`03_51_paise_gap_stays_partial`). That prefix goes on every artifact the scenario produces, so a reader learns from
a filename alone what was tested and where it belongs.

- A screenshot is `NN_<slug>__SS_<step>.png` — prefix, **double underscore**, zero-padded step number from `01`, and
  what the frame shows. Step 5 splits on that `__` to group a scenario's frames, so keep it to two underscores and
  outside the slug.
- Report links are **report-relative** — the report sits in `verification/`, so its video is `NN_<slug>.mp4` and its
  frames are under `screenshots/`.

## The Return Contract

**Every run ends with one JSON block** — the last thing you emit, whether it follows Step 6's prose
report-back or an early exit from Step 1 or Step 2. A pipeline caller reads these fields and never the
prose (`skills/orchestrate/references/stage-verify.md`), so a block that is missing, unparseable, or
carrying a `status` outside the four words below fails the stage on contract rather than on verdict.

```json
{
  "status": "PASS | PARTIAL | FAIL | BLOCKED",
  "reason": "one line, required unless PASS — what failed, or what stopped the run",
  "report": "verification/proof-report.html, or null when this attempt deferred it",
  "gaps": [{ "scenario": "07", "req": "R5", "mechanism": "what blocked it" }],
  "bugs": [{ "scenario": "03", "cause": "why it breaks", "fix": "the change that fixes it", "needsDecision": false }]
}
```

`status` is exactly one of those four words and repeats the report's derived verdict: the caller
compares the two and treats a disagreement as a contract failure. `BLOCKED` is the exception — you
could not drive the feature at all, a stack that would not come up, a tool that is not installed.
**`BLOCKED:no-infra` is not one of the four**, and annotating the status halts the run as a broken
contract instead of as the block you meant; the token opens `reason` instead — `no-infra: …`,
`no-agent-browser: …`, `no-ffmpeg: …`. `BLOCKED` enters no fix round, so that one line is all the
caller gets: what was missing, and what you tried.

`gaps[]` carries one entry per `NOT VERIFIED` scenario, `bugs[]` one per bug, whatever the verdict.
The caller never fixes a gap; it carries each `mechanism` into its stage report. It does dispatch a
coder against every `bugs[]` entry whose `needsDecision` is `false`, passing `scenario`, `cause` and
`fix` verbatim — so those three stand on their own, without the report beside them. **This is the
caller's `bugs[]`**, not the report's richer `severity` / `origin` / `reachedBy` / `title` / `body`
(`references/writing-the-report.md`); they share a name deliberately, one entry per bug in both.

**`needsDecision` is yours to set; the caller cannot infer it.** `true` where the fix is a product
call rather than a code change — two requirements that contradict, a "fix" that would change
behaviour somebody intended — and the caller halts instead of answering it. `false` where you can
name a cause and a fix. Guessing `false` on a judgement call is how intended behaviour gets quietly
rewritten to make a scenario pass.

## Step 0 — Read the Run Log

Each dispatch of this skill is a fresh agent. `verification/run-log.jsonl` is its memory across fix-and-re-verify
rounds: a ledger of finished scenarios, one JSON line appended each time a scenario finishes, **never rewritten**, the
last line per scenario winning.

**A ledger line** — the shape Steps 2, 3, 4 and 5 append in:

```json
{"ts":"ISO8601","round":1,"commits":{"<repo path>":"<sha>"},"requirements":["R2","EC1"],
 "scenario":{ the report's scenarios[] element verbatim — n, slug, short, title, verdict, url, expected, steps,
              reason, proofs, frames, video, visualMatch, artifacts, extra },
 "gap":{ the report's gaps[] element, present only when verdict is NOT VERIFIED }}
```

- `scenario` is the finished write-up as it stands when the scenario finishes — the same object Step 6 drops into the
  report — written only by the round that drove it, never a summary.
- `verdict` is one of `SUCCESS`, `FAILURE`, `NOT VERIFIED` or `INVALID`.
- `requirements` sits outside the scenario object: the report's scenario element carries no requirement ids.
- `artifacts` lists the files that exist as the line is appended — the promoted frames at first, the `.mp4` once
  Step 5 has built it and appended its own line.
- `gap` rides with a `NOT VERIFIED` scenario so its `mechanism`, `attempted` and `wouldClose` survive an attempt that
  is blocked before it reaches that scenario again.
- Bugs get no ledger home of their own: a bug's scenario is never `SUCCESS`, so it is always re-driven.

**First, read it — before anything else:**

1. **No file is a first attempt**: `round` is `1`, nothing carries, every scenario is driven. Skip the rest of this
   step.
2. **`round` is one above the highest the file carries.**
3. **Every scenario in the file keeps its `NN_<slug>`, requirement mapping and last verdict** from its last line.
4. **The docs still define the full requirement set.** A requirement no scenario ever claimed is what *Scope* exists
   to surface, and the ledger cannot tell you about it.

**Then work out what changed since each scenario was driven.** Its line records the commit per repo; ask git what
differs between those commits and now:

1. **Across every repo in play** — the packages the dispatch names and the `packages` block of
   `orchestrate.config.json`, each resolved to its own git root.
2. **Plus anything uncommitted in the working tree** — a human fix nobody committed appears in no commit diff.
3. **A repo you cannot resolve, or a recorded commit unreachable after a rebase or an amend, means re-drive
   everything**: wasteful, never wrong.
4. **Union in `Changed files this round:` where the caller passed it** — a hint that only adds work.
5. **Map each changed file to the requirements it serves from the plan and the phase files**, never from how the name
   reads. A file you cannot trace with confidence puts every scenario it might serve back in the set.

**Then derive the re-drive set:**

1. every scenario whose last verdict is `FAILURE` or `NOT VERIFIED`;
2. every scenario whose requirements a changed file serves;
3. every phone replay whose desktop scenario is in the set — the replay is its own `NN_<slug>` with its own line, and
   it follows the scenario it replays;
4. **never an `INVALID` scenario**, whatever changed.

**Done when:**

- the re-drive set is named, and every scenario in it keeps its `NN_<slug>` — Step 2 clears its old artifacts before
  it is driven;
- every scenario outside the set stands on its ledger line and artifacts as they are, for Step 6 to report unchanged;
- `round` is fixed for every line this attempt appends.

## Step 1 — Get a Stack

**Bring up what the run's `ENVIRONMENT` names.** Where `orchestrate.config.json` carries an `environments` block, run
that entry's steps — `skills/orchestrate/references/config.md` owns how each key resolves. With no block, bring-up
belongs to the project's stack skill (among its own skills, or one `CLAUDE.md` names), else to the codebase. Follow
that skill for procedure, never for proof. A later round usually arrives to a stack the attempt before it left running
(Step 7), fixtures still seeded: check the route before you bring anything up, and start only what is missing. Take
the base URL from the entry's own command — never from an assumed port — and hold it for the session; it is the
report's `Base URL` row (`references/writing-the-report.md`).

**Then answer the two questions no config key expresses**, from the stack skill, before the first walk:

1. **What this stack shares** with parallel runs, and what is isolated.
2. **Where each out-of-band effect lands** — email, queue, webhook — and how to read that sink.

**Then seed.** Every scenario's fixtures exist, and its session is authenticated, before it is driven. Beyond what
the environment's `seed` step covers, write fixtures through the product's own API — the one path that also fills
every index, cache and search layer the product later reads through — and drop to the datastore only where the API
cannot express what you need. Name each uniquely and touch only what you created; Step 7 removes them. A seeded
record stands in for what the real source would have produced — a value invented to see what breaks tests the
datastore, not the feature.

**A service that genuinely will not start ends the run here.** Emit *The Return Contract*'s block as your whole
return — `"status": "BLOCKED"`, `report` as `null`, a `reason` opening `no-infra:` that names the service and what
you tried — and nothing else: no report, no prose report-back.

**Done when:**

- the route you came to drive returns the page you expect;
- every service a scenario needs is up — including the sink a side effect lands in, often a separate service the
  stack-up does not launch;
- the base URL is held for the session;
- both questions above are answered;
- every scenario's fixtures are seeded and its session authenticated.

## Step 2 — UI Verification: Film the Whole Life of the Scenario

Every behaviour reachable through a screen is proven here, by driving a real browser through the `agent-browser`
CLI and filming what it did. The craft — batching, the `eval` laws, the capture loop, the phone device — is in
`references/driving-the-browser.md`; read it before your first `open`. This step is the order things happen in.

**Before the first walk**

- **Check both binaries no UI scenario can finish without**: `agent-browser`, and `ffmpeg`, which Step 5 needs on
  whichever attempt turns out to be the last — so check it even on a round that will skip Step 5. Either one
  missing stops the run on *The Return Contract*'s block: `"status": "BLOCKED"`, `report` as `null`, a `reason`
  opening `no-agent-browser:` or `no-ffmpeg:`, and every scenario you could not prove in `gaps[]` against the
  requirement it carried. For a missing `agent-browser`, print `npm i -g agent-browser && agent-browser install`.
- **Plan the fewest complete flows that reach every behaviour the docs claim.** A flow is one user's journey end to
  end — prefer one crossing five behaviours to five scenarios proving one each. A behaviour no flow reaches gets its
  own scenario.
- **Name and number every scenario** as in *Output Layout* before you capture anything — or keep the `NN_<slug>`
  the ledger already gave it, where Step 0 found one.
- **Open the stack's UI URL and hold one session** for every scenario in the run.

**Each scenario, in this order**

1. **Re-driving one Step 0 put back in the set? Clear last round's artifacts first** — its promoted frames, and the
   files it produced (a download, a webhook body, its `NN_<slug>.<ext>`) — or last round's artifact survives and
   gets cited as this round's evidence. What leaks into the rebuilt video without this sits beside the capture loop
   in `references/driving-the-browser.md`.
2. **Drive it, recording its paths.** The browser proves the behaviour under test, not the setup that reached it —
   a fixture you find missing mid-walk is seeded the Step 1 way and the walk re-driven. Record the path the
   scenario opened on and any path a step moved to: query kept, host dropped, auth and identity values redacted
   (shape and reasons in `references/writing-the-report.md`). A path reached by clicking comes back in the assert
   batch you already run, never a batch of its own.
3. **Confirm every frame.** A frame is evidence only once its assert passed **and** your own eyes confirmed it shows
   what you think — read it at the moment you shoot, since frames lag renders.
4. **Read the frames.** `references/visual-verification.md` is the one pass that does it, and the scenario's
   `visualMatch` is what it produces. It drives nothing: the frames are shot and the session is still open.
5. **Write it up and append its ledger line**, in Step 0's shape, whatever the verdict — one line per scenario per
   round, appended and never edited.

**A phone replay is a scenario.** Every flow on the surface the change landed on is driven again on a phone, as its
own numbered scenario in the same session, through steps 1–5 like any other. Whether this app is meant to work on a
phone at all is a project fact like any other.

**Done when:**

- every behaviour the docs claim is reached by some flow, driven this round or carried from the ledger;
- every UI scenario names the path it opened on;
- every UI scenario's `NN_<slug>` frames in `screenshots/` tell its whole story;
- every UI scenario carries a `visualMatch` — a derived fidelity, or the named absence of a baseline — with each of
  the six questions evidenced or called clean;
- every flow on the surface the change landed on has a phone replay driven to its closing assert, whatever it
  returned.

## Step 3 — API, DB & Side-Effects: Proving What Has No Screen

Every behaviour with no screen to drive is proven here, and a feature with no UI is proven here whole, having never
entered Step 2. The craft — the four parts of a headless walk, the three guards that prove the code under test ran,
the traps that make a walk look green when it never did — is in `references/headless-verification.md`; read it before
your first request. This step is the order things happen in.

**Before the first request**

- **Plan and name the scenarios as Step 2's *Before the first walk* does** — the fewest complete walks that reach
  every behaviour, each named `NN_<slug>` or keeping the one the ledger gave it. A feature with no UI never enters
  Step 2, so that planning happens here.
- **Know where each effect lands before a walk fires it.** Step 1 answered which sink every out-of-band effect
  reaches and how to read it; a walk that discovers its sink halfway through is a walk you drive twice.

**Each scenario, in this order**

1. **Re-driving one Step 0 put back in the set? Clear the files it produced last round** — its `NN_<slug>.<ext>`
   webhook body or download — as Step 2 clears a UI scenario's frames, and for the same reason.
2. **Fire the trigger and keep the exchange whole.** The request path it drove is the scenario's `url`, written as
   `references/writing-the-report.md` says. The exact command, status and body go **inline and whole** into one
   `proofs[]` entry (shape there too), never into a file.
3. **Read the written state back** the reference's way: through the product's own API, quoting the fields, and where
   the datastore is directly reachable (an MCP tool, else the connection string the stack exposes) the stored row too.
   That read-back is a `proofs[]` entry of the same kind.
4. **Name the guard.** Say in the proof which of the reference's three — a discriminating value, a negative control,
   a branch trace — proved the code under test ran, and show it.
5. **Prove every effect the walk fired at its sink, polling to a hard deadline:**
   - **Email** — open the mail viewer and screenshot the received message: the same filmable evidence Step 2
     produces, frames and all.
   - **A job queue** — read the job out of the queue's own storage into a `proofs[]` entry naming the queue, the job
     id and the state it was found in, dated by the worker's log line picking it up. **An empty read is not a pass**:
     establish the queue exists before believing a count off it.
   - **Webhooks and delivered files** — keep the artifact as `verification/NN_<slug>.<ext>`, listed in `artifacts[]`.

   Where the project says the effect is deliberately neutralized in this stack, prove the enqueue instead and say so.
   Where the stack has no sink for an effect the feature clearly produces, the scenario is `NOT VERIFIED` naming that
   sink.
6. **Record the verdict** by exact-matching what came back against the response the design or plan describes.
7. **Write it up and append its ledger line**, in Step 0's shape with `proofs[]` included, whatever the verdict.

**Done when:**

- every requirement this step carries is named by some headless scenario, driven this round or carried from the
  ledger;
- every headless scenario names the path it drove as its `url` and holds its trigger and read-back whole in
  `proofs[]`;
- every headless scenario names which of the three guards proved the code under test ran;
- every out-of-band effect a walk fired is quoted at its sink or `NOT VERIFIED` naming that sink.

## Step 4 — Adversarial Pass (MANDATORY — Role Swap)

> **STOP. You are the critic now, not the verifier.** You are graded on defects found, not on agreeing with the
> verdicts above.

**Write the attack list before you drive anything, with your draft report closed.**

1. **Scope it to what this round touched**: the scenarios Step 0 put back in the set, plus whatever the changed files
   reach. Re-read the design and plan for what the change touches beyond what you drove, including the rest of the
   surface it landed on — one new field on a settings page puts every other field on that page in scope. An attack an
   earlier round already ran against code this round did not change needs no repeat.
2. **Attack from actors, not fields.** List the surfaces the feature reads and mark each with who can write it:
   - **The user, another tenant, or an operator** write through the product's own interfaces, so anything they can
     enter is a probe.
   - **A third-party system** — a payment provider, a webhook sender, a sync job — is attacked only by making it
     behave badly in a way it actually can: unreachable, slow, timing out, 500, not-found, a field absent, a record
     stale. Read that integration's contract to decide which of those it can emit. A value written into its store
     that it would never return proves nothing.
   - **The product itself** — a derived total, a computed status, an id it issues — is attacked through the inputs
     it derives from, then read back.
3. **Three attacks are owed on every run**, over and above what the actors suggest:
   - the errors and warnings you passed over, the state the feature carries between screens, and the branches the
     happy path never entered;
   - **on every UI surface, content longer than the fixture** — a long name, a long label, a number with more
     digits. `references/visual-verification.md` leaves this one to Step 4 because it is driven, not read;
   - **on every screen the frame pass called clean**, the divergence you most expected to find there — the state
     nobody built, the label that overflows on a real name. A fidelity near 100 that nobody tried to break is a claim
     like any other; drive the attack and record what ruled the divergence out.

**Drive each probe as in Step 2** — same session, same `NN_<slug>` prefix; a probe with no screen follows Step 3.
Route what it returns by provenance:

- **It probed a behaviour the docs describe** — a boundary on a validation rule, an error path, a rejection you
  provoked. Evidence for **that scenario**, not a scenario of its own: a 400 on bad input is the feature working, and
  a behaviour the docs deliberately exclude is expected rather than broken.
- **It found a defect nobody asked about.** Write its steps and drive them again as **its own filmed scenario**, plus a
  `bugs[]` entry that settles the two facts `references/writing-the-report.md` will ask for: `reachedBy` — the actor
  who reached it and the surface they used — and `origin` — introduced here, pre-existing, or pre-existing and
  worsened here, settled by `git blame` and `git diff` on the lines that decide the behaviour. If no actor can be
  named, the state is unreachable in production: a note in `extra[]` on what the feature trusts, not a bug.
- **It found nothing.** It appears only in the closing sentence below.

**Attack your own gaps the same way.** Every scenario you are about to mark `NOT VERIFIED` is a claim. Read the
blocking code path until you can name the line: "the gate didn't fire" is a symptom; "condition X at `file:line`
requires Y, which this environment cannot supply" is a cause. A gap that survives is real; one that does not was an
early stop, so go verify it.

**Close the pass** with one sentence naming the attack you most expected to land this round and why it did not — it
becomes the report's `bugsNote`. Every scenario this step added — a filmed bug repro, a gap you attacked and kept —
is written up and appended as its own ledger line, in Step 0's shape.

**Done when:**

- every surface in the attack list has been probed by each actor that can write it, and every UI surface took the
  longer-than-fixture attack;
- every bug reproduces from its own steps, is filmed as its own scenario, and carries `reachedBy` and an `origin`
  settled by `git blame` or the diff;
- every `NOT VERIFIED` names the line, condition or absent datum that blocks it;
- the best-attack sentence is written, and each screen the frame pass called clean names the divergence it ruled out.

## Step 5 — Build the Videos

**Only the attempt that writes the report runs this step, and it runs before Step 6.** The one attempt that defers
its report — Step 6's case, a derived `FAIL` with `ROUNDS_LEFT` above zero — stops after Step 4: no ffmpeg runs, and
the promoted frames stay in `screenshots/` for the round that will build from them. Every other attempt builds every
scenario in one pass, the carried-over ones included: the videos are assembled from the promoted frames, not
captured, and `references/writing-the-report.md` owns what the settings do and what a hand-run rebuild has to keep.

1. **Run the bundled script over the verification directory.** It globs every `NN_<slug>` prefix under
   `screenshots/` and writes one `NN_<slug>.mp4` beside the report:

   ```bash
   node --experimental-strip-types \
     "${CLAUDE_PLUGIN_ROOT}/skills/functional-verify/scripts/build-videos.ts" \
     /abs/path/to/.harness/<SPEC_NAME>/verification
   ```

2. **Read every line it prints.** Each scenario gets `ok NN_<slug>.mp4 crop=…` or `FAILED NN_<slug> — <reason>`, and
   the exit is non-zero if any failed. A scenario with no `ok` line has no video: its `video` stays unset, and its
   frames still prove it.
3. **Check every phone replay's `crop` yourself.** The value has to read as a portrait picture inside the bars
   (`crop=320:720:478:0`-shaped); the full canvas width on a portrait frame means the frame was stretched, which is a
   failure whatever the script printed — `references/writing-the-report.md` has the numbers.
4. **Append a ledger line per scenario that built**, in Step 0's shape: the `.mp4` now in `video` and in `artifacts`,
   every other field as the line it supersedes had it, **`round` and `commits` copied across, never restamped** — the
   line records which round drove the scenario, not which round encoded it.

**Done when:**

- every scenario the script printed `ok` for has its `.mp4` beside the report, and no scenario names a video it does
  not have;
- every phone replay's `crop` shows a portrait picture, not the canvas width;
- the last ledger line per built scenario names its `video`, with the `round` and `commits` of the round that drove
  it.

## Step 6 — Write the Proof Report, Then Report Back

**Derive before you write.** The scenarios come from `run-log.jsonl`, last line per scenario, never from your
recollection of the walk — a carried-over scenario is transcribed, not reconstructed (how that reads is in
`references/writing-the-report.md`). Map every requirement id to its scenario in `coverage[]` and compute `verdict`
by the rule there: derived, never chosen.

**One case defers the report: `ROUNDS_LEFT` above zero *and* a derived `FAIL`.** It is the same decision Step 5
already turned on, so on that attempt nothing is written here — the promoted frames and ledger lines Step 5 left are
the round's whole output. Every other attempt writes the report, a terminal `FAIL` included.

**Writing it:**

1. Copy `references/proof-report-template.html` to `verification/proof-report.html` and fill its JSON island; the
   field-by-field contract is `references/writing-the-report.md`.
2. `bugs[]` carries only what is still broken as you write — a bug an earlier round found and a fix has since closed
   gets no entry and no note anywhere in the report.
3. Walk the reference's completion checklist; the report is done when every bullet holds.

**Report back once Step 7 has closed the session and released or kept the stack** — the return is written once, and
it has to say what Step 7 did. Everything the report excludes belongs here, written as durable facts a later run can
act on rather than an account of your afternoon:

- the derived verdict, the verdict per scenario, and whether the feature works;
- every bug, and which need a decision rather than a fix;
- the `verification/` path and its videos — or that this attempt deferred the report;
- the stack you drove: how it was brought up and at which commit;
- the environment findings: every config value that was wrong, service that would not boot, datastore that lied,
  fixture you had to build, command that was documented and gone;
- what Step 7 left running and which fixtures it kept.

**End the return with the JSON block *The Return Contract* defines.** The prose stays above it.

**Done when:**

- `verification/proof-report.html` exists and every bullet of the completion checklist holds — or this attempt
  deferred it and the return says so;
- the return covers the six items above;
- the return ends with the contract's JSON block.

## Step 7 — Clean Up

Close the browser on every attempt: `agent-browser --session "$AGENT_BROWSER_SESSION" close`, naming the session
`references/driving-the-browser.md` exported before the first `open` — that file says why a close naming anything
else exits 0 and releases nothing.

**The one deferred attempt** — Step 6's case, a `FAIL` with `ROUNDS_LEFT` above zero — **leaves the stack up, the
fixtures in place, and the staging dir where it is.** A fix and another verification follow, and Step 1 of that round
starts from what you left; Step 6's report-back names what was kept.

**Every other attempt is the last one**, and releases what it leaves running, in this order:

1. **Remove the fixtures you created** (Step 1) — yours only, since the datastore may be shared.
2. **Release the stack** — the teardown step the environment's entry declares, where it declares one (a project
   names its own stack steps, `skills/orchestrate/references/config.md`), else the way the stack skill says. Release
   only what you brought up; anything already running when you arrived stays running.
3. **Delete the staging dir**, `.harness/<SPEC_NAME>/verify-staging/`.

No attempt touches `verification/`: it stays in place, uncommitted, for a human to read. **`run-log.jsonl` in
particular is never deleted** — it is what the next round reads in Step 0 and what the final report is assembled from.

**Done when:**

- the browser session the run exported is closed;
- a terminal attempt has removed its fixtures, released only what it brought up, and deleted `verify-staging/`;
- `verification/` and `run-log.jsonl` are as Step 6 left them.
