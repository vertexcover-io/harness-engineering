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
   quoted string, a computed style, an HTTP response, a video.
2. **The adversarial pass runs** (Step 4), over the feature and over your own gaps.
3. **Every requirement is accounted for** (*Scope*, below).

When the feature's docs describe nothing a verification could drive, report "No functional verification scenarios —
skipping" and stop.

## Inputs

- **The feature's docs** in `.harness/<SPEC_NAME>/` — PRD, design, plan, whatever exists. Scenarios come
  from what those docs say the feature must do.
- **The designs** plan.md's `## Design References` names — what each screen was supposed to look like.
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

`status` is exactly one of those four words. It repeats the report's derived verdict — the caller
compares the two and treats a disagreement as a contract failure, because one of them was composed
rather than derived — or it is `BLOCKED` when you could not drive the feature at all: a stack that
would not come up, a tool that is not installed. **A blocking token belongs in `reason`, never in
`status`.** `BLOCKED:no-infra` is not a status the caller recognises; it halts the run as a broken
contract instead of as the block you meant to report. Write `"status": "BLOCKED"` with `reason`
opening on the token — `no-infra: …`, `no-agent-browser: …`, `no-ffmpeg: …`. `BLOCKED` halts the
caller on your `reason` and enters no fix round, so that one line has to name what was missing and
what you tried.

`gaps[]` carries one entry per `NOT VERIFIED` scenario and `bugs[]` one per bug, whatever the verdict.
The caller reads `gaps[]` as holes in the proof and never fixes them, carrying each `mechanism` into
its stage report. It dispatches a coder against every `bugs[]` entry whose `needsDecision` is
`false`, passing that entry's `scenario`, `cause` and `fix` verbatim, so those three fields have to
stand on their own without the report beside them.

**This `bugs[]` is the caller's shape** — `scenario`, `cause`, `fix`, `needsDecision` — not the
report's richer `bugs[]` of `severity`, `origin`, `reachedBy`, `title` and `body`
(`references/writing-the-report.md`); they share a name deliberately, one entry per bug in both.

**`needsDecision` is yours to set, and the caller cannot infer it.** It is `true` where the fix is a
product call rather than a code change: two requirements that contradict each other, or a "fix" that
would change behaviour somebody intended — the caller halts on it rather than answering it. It is
`false` where you can name a cause and a fix, and then a caller may fix it without asking anyone.
Guessing `false` on a judgement call is how intended behaviour gets quietly rewritten to make a
scenario pass.

## Step 0 — Read the Run Log

A caller that fixes and re-verifies dispatches this skill more than once against the same feature, and each
dispatch is a fresh agent with no memory of the last. `verification/run-log.jsonl` is that memory — a ledger of
finished scenarios: one JSON line appended each time a scenario finishes, **never rewritten**, the last line for a
scenario winning.

```json
{"ts":"ISO8601","round":1,"commits":{"<repo path>":"<sha>"},"requirements":["R2","EC1"],
 "scenario":{ the report's scenarios[] element verbatim — n, slug, short, title, verdict,
              url, expected, steps, reason, proofs, frames, video, artifacts, extra },
 "gap":{ the report's gaps[] element, present only when verdict is NOT VERIFIED }}
```

**A line carries the scenario's finished write-up, not a summary of it** — the same object Step 6 drops into the
report's `scenarios[]`, written when the scenario finishes and appended as it stands. A scenario's `verdict` is one of
`SUCCESS`, `FAILURE`, `NOT VERIFIED` or `INVALID`. A one-line summary cannot be reported at all: a scenario driven in
round 1 and carried to round 3 would reach the report with no `url`, no `expected`, no `steps` naming the values it
sent, no frame labels, and, for a headless scenario, no verbatim request and response — which the report's own rules
forbid leaving in a side file. So the ledger is both the evidence trail and the report's source of truth, which is what
Step 6 already treats it as. `requirements` sits outside the scenario object because the report's scenario element
carries no requirement ids (`coverage[]` maps them) and the changed-file rule below needs them. **`artifacts` lists the
files that exist as the line is appended** — the promoted frames at first, and the `.mp4` once Step 5 has built it,
which is why Step 5 appends a line of its own per scenario. **Bugs get no ledger home**: a bug's scenario never carries
a `SUCCESS` verdict, so it is always in the re-drive set and always has this round's own evidence behind it.

**No file means a first attempt**: nothing to carry, every scenario is driven. **A file means read it before anything
else.** For every scenario that already exists, the number, the slug, the requirement mapping and the last verdict
come from the ledger, and a scenario keeps its `NN_<slug>` for the life of the feature. The docs still define the full
requirement set — a requirement no scenario ever claimed is exactly what *Scope* exists to surface. Your `round` is
one above the highest the file carries, and `1` when there is no file.

**Then derive what this attempt re-drives**: every scenario whose last verdict is `FAILURE` or `NOT VERIFIED`, plus
every scenario whose requirements touch a file that has changed since its line was written. **`INVALID` is not
re-driven, whatever changed** — the scenario turned out not to apply, so re-driving it every round costs a walk and
could never change its verdict. A `NOT VERIFIED` scenario is re-driven like any other non-`SUCCESS` one, and its
`gap` object rides in its ledger line,
so the `mechanism`, `attempted` and `wouldClose` an earlier round wrote survive an attempt that is blocked before it
reaches that scenario again.

**What changed is yours to work out, not the caller's to tell you.** Each ledger line records the commit per repo the
scenario was driven at, so ask git what has changed between those commits and now:

- **Across every repo in play** — the packages the dispatch names and the `packages` block of
  `orchestrate.config.json`, each resolved to its own git root. A fix can span repos, and a diff taken in one repo
  looks exactly like a complete one.
- **Plus anything uncommitted in the working tree**, since a human fix nobody committed appears in no commit diff.
- Where a repo cannot be resolved, or its recorded commit is unreachable because of a rebase or an amend, **re-drive
  everything**: wasteful, never wrong.

Where the caller also passes `Changed files this round:`, treat it as a hint that can only add work and re-drive the
union of it and what you derived. **Which requirement a changed file serves is read out of the plan and the phase
files, never guessed from how the name reads, and a file you cannot trace to a requirement with confidence puts its
scenarios back in the set** — a needless re-drive costs one walk, while a scenario wrongly carried over ships a break
with a `SUCCESS` beside it. **The set is yours to derive; the caller does not dictate it.**

**A phone replay follows the scenario it replays.** The replay is its own `NN_<slug>` with its own ledger line, so
when its desktop scenario is re-driven it is re-driven too — otherwise the report shows a fresh desktop video beside a
phone video of the screen as it was before the fix.

A scenario outside the set is not driven again: its ledger line and its artifacts stand as they are, and Step 6
reports it from them unchanged. A scenario inside it keeps its number and slug but **does not overwrite its own
artifacts** — last round's frames and produced files survive alongside the new ones, so they are deleted before it is
driven again (Step 2).

## Step 1 — Get a Stack

**Where `orchestrate.config.json` carries an `environments` block, it declares how this project starts.** Run the
steps the run's `ENVIRONMENT` names — `skills/orchestrate/references/config.md` owns how each key resolves.
**With no block**, bring-up belongs to the project's **stack skill** (among its own skills, or one `CLAUDE.md`
names), else to the codebase. Follow that skill for procedure, never for proof: the evidence bar here does not move
to match a project's conventions.

**A later round usually arrives to a stack that is already up**, left running by the attempt before it (Step 7), with
its fixtures still seeded: check the route before you bring anything up, and start only what is missing.

**Take the base URL from the entry's own command** and hold it for the session — a URL assembled from an assumed
port is the wrong stack.

**Step 1 is done when the route you came to drive returns the page you expect**, every service a scenario needs is
up — including the sink a side effect lands in, often a separate service the stack-up does not launch — and two
questions no config key expresses are answered:

1. **What this stack shares** with parallel runs, and what is isolated.
2. **Where each out-of-band effect lands** — email, queue, webhook — and how to read that sink.

Both belong to the stack skill, and both are expensive to discover halfway through a walk. If a service genuinely
will not start, stop here and emit *The Return Contract*'s block as your whole return: `"status": "BLOCKED"`,
`report` as `null`, and a `reason` opening `no-infra:` that names the service and what you tried. There is no report
and no prose report-back to write — nothing was driven.

**A scenario's fixtures exist before it is driven**, seeded and authenticated ahead of the first walk. Beyond what
the environment's `seed` step covers, write them **through the product's own API** — the one path that also
populates every index, cache and search layer the product later reads through — dropping to the datastore only
where the API cannot express what you need. Name each uniquely and touch only what you created, since a shared
datastore makes a careless write someone else's problem; remove yours at cleanup (Step 7). A seeded record stands
in for what the real source would have produced, so a value invented to see what breaks tests the datastore, not
the feature.

## Step 2 — UI Verification: Film the Whole Life of the Scenario

**Cover the feature in the fewest complete flows that reach every behaviour its docs claim.** A flow is one user's
journey end to end — prefer one crossing five behaviours to five scenarios proving one each. A behaviour no flow
reaches gets its own scenario. Number and name each as in *Output Layout* before you capture anything — or keep the
number and slug the ledger already gave it, where Step 0 found one.

Drive a real browser through the `agent-browser` CLI — this is where every UI scenario is proven live. **Check both
binaries no UI scenario can finish without before you drive anything**: `agent-browser`, and `ffmpeg`, which Step 5
needs to build the video every UI scenario must name. Check `ffmpeg` even on a round that will skip Step 5, because the
run needs it on whichever attempt turns out to be its last, and finding it missing after three rounds of driving is
worse than failing now. Either one missing stops the run on *The Return Contract*'s block — `"status": "BLOCKED"`,
`report` as `null`, and a `reason` opening `no-agent-browser:` or `no-ffmpeg:` that names what is absent — with the
scenarios you could not prove in `gaps[]`, each against the requirement it carried. For a missing `agent-browser`,
print `npm i -g agent-browser && agent-browser install`. For a missing `ffmpeg`, name it and stop.

Open the stack's UI URL and hold **one session** for every scenario. The browser proves the behaviour under test,
not the setup that reached it — a fixture you find missing mid-walk is seeded the Step 1 way and the walk
re-driven. Read `references/driving-the-browser.md` before your first `open` — batching, the `eval` laws, the
capture loop and the phone replay are all there.

**Re-driving a scenario Step 0 put back in the set? Delete its promoted frames before the first batch, and the files
it produced with them** — a download, a webhook body, its `NN_<slug>.<ext>` — or last round's artifact survives and
gets cited as this round's evidence. Both rules, and what leaks into the rebuilt video without them, sit beside the
capture loop in that same file.

**Record the path each scenario opened on, and the path any step moved the browser to** — with the query, never the
host, and with auth and identity values redacted; the shape and the reasons are in `references/writing-the-report.md`.
A path reached by clicking comes back in the assert batch you already run, never a batch of its own.

**Every flow on the surface the change landed on is replayed on a phone**, as its own numbered scenario in the same
session. Whether this app is meant to work on a phone at all is a project fact like any other.

**Where a design defines the screen you just drove, compare your frame against it.** Open the file plan.md's
`## Design References` names and read the built screen against it on placement and order, labels and copy, and
every state the design draws. Comparison by eye is the bar; state what matched and what did not in that scenario's
`reason`. A mismatch a user would be wrong-footed by is a bug and routes through Step 4; cosmetic drift is a note
in `extra[]`. A screen nobody drew is not a failure.

**Write the scenario up the moment it finishes and append that as its ledger line**, in Step 0's shape, whatever the
verdict — one line per scenario per round, appended and never edited.

**A frame is evidence only once its assert passed and your own eyes confirmed it shows what you think** — read at
the moment you shoot, since frames lag renders. **Done when every behaviour the docs claim is reached by some flow,
driven this round or carried from the ledger; every UI scenario names the path it opened on; every UI scenario's
`NN_<slug>` frames in `screenshots/` tell its whole story; every screen a design defines carries its comparison in
`reason`; and every flow on the surface the change landed on has a phone replay driven to its closing assert, whatever
it returned.**

## Step 3 — API, DB & Side-Effects: Proving What Has No Screen

What has no screen to drive lands here. Read `references/headless-verification.md` before your first request: it holds
the shape of a headless walk, and the traps that make one look green when the code under test never ran.

A headless scenario names its path the same way: the request path it drove is its `url`. Run curl with
`-w '\n%{http_code}'` and keep the **verbatim exchange**, which a dev re-runs to check you: it goes
**inline and whole** into a `proofs[]` entry (shape in `references/writing-the-report.md`) rather than into a file.
Record the verdict by exact-matching the expected response the design or plan describes. Read the written state back
through the product's own API and quote the fields; where the database is directly reachable (an MCP tool, else the
connection string the stack exposes), quote the stored row too and keep that exchange the same way.

**A triggered side effect is a claim too.** When a walk fires something out of band — email, SMS, webhook,
delivered file — prove it at its sink, which the stack skill names, with a **hard deadline** on the poll:

- **Email** — open the mail viewer and screenshot the received message, the same filmable evidence Step 2 produces.
  Its frames carry the scenario's `NN_<slug>` prefix like any other.
- **A job queue** — read the job out of the queue's own storage and keep that exchange **inline and whole** in a
  `proofs[]` entry, dated by the log line the worker wrote picking it up. Where that storage is, how the queues are
  named and which log holds the worker are project facts the stack skill names. **An empty read is not a pass** — a
  state holding no jobs and a queue that never existed come back as the same nothing, so establish the queue is
  there before believing any count off it.
- **Webhooks and delivered files** — keep the artifact as `verification/NN_<slug>.<ext>`, listed in the scenario's
  `artifacts[]`.

When the project says the effect is deliberately neutralized here, prove the enqueue instead and say so. When this
stack has no sink for an effect the feature clearly produces, the scenario is `NOT VERIFIED` naming that sink.

A headless scenario closes the way a UI one does: **write it up when it finishes and append that as its ledger line**,
in Step 0's shape — `proofs[]` and all, since that verbatim exchange is what a later round would otherwise lose.

**Done when every requirement this step carries is named by some headless scenario, driven this round or carried from
the ledger; every scenario captured its trigger and its read-back verbatim in `proofs[]`; every scenario says which of
`references/headless-verification.md`'s three guards proved the code under test ran — a discriminating value, a
negative control, or a branch trace from the logs; and every out-of-band effect a walk fired is either quoted at its
sink or `NOT VERIFIED` naming that sink.**

## Step 4 — Adversarial Pass (MANDATORY — Role Swap)

> **STOP. You are the critic now, not the verifier.** You are graded on defects found, not on agreeing with the
> verdicts above.

**The attack list covers the scenarios this round re-drove, plus whatever the changed files touch**: the errors and
warnings you passed over, the state the feature carries between screens, and the branches the happy path never
entered. Re-read the design and plan for what the change touches beyond what you drove, including the rest of the
surface it landed on — one new field on a settings page puts every other field on that page in scope. An attack an
earlier round already ran against code this round did not change needs no repeat. Leave your draft report closed while
you write the list; it anchors you to what you already concluded.

**Attacks come from actors, not from fields.** Before writing probes, list the surfaces this feature reads and mark
each one with who can write it:

- **The user, another tenant, or an operator.** These write through the product's own interfaces, so anything they
  can enter is fair game for a probe.
- **A third-party system** — a payment provider, a webhook sender, a sync job. Attack it only by making it behave
  badly in a way it actually can: unreachable, slow, timing out, 500, not-found, a field absent, a record stale.
  Read that integration's contract to decide which of those it can emit. Writing a value into its store that it
  would never return proves nothing, because no actor can produce that state.
- **The product itself** — a derived total, a computed status, an id it issues. No actor writes these directly, so
  attack them through the inputs they are derived from and check the result.

Drive probes exactly as in Step 2, same session and same `NN_<slug>` prefix; a probe with no screen follows
Step 3. Route each result by provenance:

- **It probed a behaviour the docs describe** — a boundary on a validation rule, an error path. Evidence for
  **that scenario**, not a scenario of its own. Most probes land here.
- **It found a defect nobody asked about** — its own scenario, plus a `bugs[]` entry naming the actor who reached
  it and the surface they used, and stating whether this change introduced it, predates it, or predates it and got
  worse here. Run `git blame` and `git diff` on the lines that decide the behaviour: a maintainer's first question
  is whether to revert. If no actor can be named, the state is unreachable in production and belongs in `extra[]`
  as a note on what the feature trusts.
- **It found nothing** — it appears only in the sentence naming your best attack.

A rejection you provoked is the feature working: a 400 on bad input is evidence for whichever scenario owns that
rule, and a behaviour the docs deliberately exclude is expected rather than broken.

**Apply the same pass to your own gaps.** Every scenario you are about to mark `NOT VERIFIED` is a claim and gets
attacked like one. Read the blocking code path until you can name the line. "The gate didn't fire" is a symptom;
"condition X at `file:line` requires Y, which this environment cannot supply" is a cause. A gap that survives is
real; one that does not was an early stop, so go verify it.

**Film every bug by re-running its repro**: once a probe lands, write its steps and drive them again as its own
scenario. **Name the attack you most expected to land in this round's pass and say why it did not.**

A scenario this step adds — a filmed bug repro, a gap you attacked and kept — **is written up and appended as its
own ledger line too**.

**Done when every bug reproduces from its own steps, names the actor who reached it and whether this change
introduced it, and carries its film; and every `NOT VERIFIED` names the line that blocks it.**

## Step 5 — Build the Videos

**Only the attempt that writes the report builds videos.** A deferred attempt (Step 6) skips this step whole: with no
report to point at them, its videos are attached to nothing, and the attempt that does write the report re-encodes
them from the same frames anyway. On a deferred round, append your ledger lines, leave the promoted frames in
`screenshots/`, and stop — no ffmpeg runs.

The terminal attempt builds every scenario in one pass, whichever round drove it. Assemble one video per scenario from
the promoted frames in `screenshots/` by running the bundled script over the verification directory:

```bash
node --experimental-strip-types \
  "${CLAUDE_PLUGIN_ROOT}/skills/functional-verify/scripts/build-videos.ts" \
  /abs/path/to/.harness/<SPEC_NAME>/verification
```

It globs every prefix under `screenshots/`, so nothing has to be named or excluded. It prints `ok NN_<slug>.mp4
crop=…` per scenario, or `FAILED NN_<slug>` with the reason, and exits non-zero if any failed. **Read every line** —
a scenario with no `ok` line has no video for its `video` field to name. Build **before** the report so the videos
it points at already exist. What the settings mean, and what the `crop` value has to look like on a phone replay, are
in `references/writing-the-report.md`.

**Then append a ledger line per scenario that built**, its `.mp4` now named in the scenario's `video` and listed in
its `artifacts`, everything else about the scenario unchanged — **including the `round` and `commits` of the line it
supersedes**, which are copied across rather than restamped, so the ledger keeps recording which round actually drove
each scenario instead of crediting them all to the last one. The video exists as of this line, so the last line per
scenario, which is what Step 6 reads, names it.

## Step 6 — Write the Proof Report, Then Report Back

Copy `references/proof-report-template.html` to `verification/proof-report.html` and fill its JSON island. The
field-by-field contract, the derivation of the overall verdict — derived, never chosen — and the completion
checklist are in `references/writing-the-report.md`. **Done when every bullet of that checklist holds.**

**Assemble the scenarios from `run-log.jsonl`, last line per scenario, rather than from your recollection of the
walk** — how that reads in the report is in `references/writing-the-report.md`.

**`bugs[]` carries only what is still broken as you write.** A bug an earlier round found and a fix has since closed
gets no entry and no note anywhere in the report: its scenario passes now, and that is the whole record.

**One case defers the report.** When `ROUNDS_LEFT` is above zero *and* your derived verdict is `FAIL`, write no
report: the code is about to change, so a report on it would describe a feature that no longer exists, and the caller
reads your returned verdict instead.
Leave every promoted frame in place and every ledger line appended — that evidence is what shows the round drove
something, and it is what the next round reads — and say in your return that the report is deferred. Step 5 is skipped
on this attempt for the same reason the report is.
Every other case writes it, `FAIL` included: a `PASS`, a `PARTIAL`, and the final attempt whatever it found.

Then **report back to whoever dispatched you** — everything the report excludes belongs here: the derived verdict
and the verdict per scenario; whether the feature works; every bug and what needs a decision rather than a fix; the
`verification/` path and its videos; **the stack you drove** — how it was brought up and at which commit, so a
reader knows exactly which code this verdict covers; and **the environment findings** — every config value that was
wrong, service that would not boot, datastore that lied, fixture you had to build, command that was documented and
gone. Write
those as durable facts a later run can act on, not as an account of your afternoon: without them the next
verification pays the same cost from scratch.

**End the return with the JSON block *The Return Contract* defines**, so a pipeline caller reads fields instead of
parsing prose. The prose above it stays — a person invoking this skill directly is reading that, not this. `status`
is the verdict you derived, and `report` is `null` on the one attempt that defers the report.

## Step 7 — Clean Up

Close the session (`agent-browser --session "$AGENT_BROWSER_SESSION" close`, the session
`references/driving-the-browser.md` exported before the first `open` — closing a name nothing drove prints
`✓ Browser closed`, exits 0, and releases nothing) on every attempt.

**Tear everything else down unless this attempt deferred its report** — the same one condition Step 6 turns on: a
`FAIL` with `ROUNDS_LEFT` above zero. Then a fix and another verification are coming, so **leave the stack up and the
fixtures in place**, because tearing them down makes the next round pay the whole bring-up and the whole seeding
again. Say in your return that you left them, and which ones. Every other attempt is the last one — nothing follows it
to release what it leaves running.

So on every attempt that wrote a report, remove the fixtures you created and **release the stack**: the teardown step
of the environment you brought up, else the way the stack skill says. **Release only what you brought up** — anything
already running when you arrived stays running. Delete the staging dir (`.harness/<SPEC_NAME>/verify-staging/`) there
too. A deferred attempt keeps it, which costs nothing: the caller counts an artifact under `verification/` or
`verify-staging/` either way, and what actually shows a deferred round drove something is the promoted frames and the
ledger lines Step 6 leaves in place — staging holds only retakes, dead ends and missed clicks.

Leave `verification/` in place, uncommitted — it is the deliverable, for a human to read. **`run-log.jsonl` is never
deleted, on any attempt**: it is what the next round reads in Step 0 and what the final report is assembled from, so
deleting it costs the feature every scenario an earlier round proved.
