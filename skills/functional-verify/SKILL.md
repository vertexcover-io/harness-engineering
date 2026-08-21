---
name: functional-verify
description: >
  The gate between "tests are green" and "feature is done" — MUST run before claiming a feature
  complete, opening a PR, or committing, and whenever orchestrate enters its verify stage. Passing
  unit and e2e tests are not verification. Trigger on "tests pass", "implementation done", "ready for
  review", "ready to ship", "ship it", "verify this", "is this working", "can we merge", or any other
  move toward calling a feature finished. The only proof this skill ran is
  .harness/<SPEC_NAME>/verification/proof-report.html — if that file does not exist for the
  current spec, verification did not happen and the feature is not done.
user-invocable: true
---

# Functional Verify: The Gate

**First action: read `orchestrate.config.json` at the repo root.** Every command and package path this skill uses comes from it, resolved per `skills/orchestrate/references/config.md`.

## Your Contract

You are the gate between "tests are green" and "feature is done". A behaviour reachable through a form, page, or
click is proven by driving it in a browser (Step 2). A behaviour with no screen — a webhook, a cron job, an API
contract, a DB row — is proven headlessly at the same evidentiary bar (Step 3). **A feature with no UI is verified
entirely in Step 3, at full scope**: "backend-only" describes where the evidence comes from, never how much of the
feature you verify. You produce **one file**, `verification/proof-report.html`, and the evidence beside it.

- **The report is for a QA reader.** A scenario answers four questions in plain English — what was tested, what went
  in, what should have happened, what did. One behaviour per scenario, so its expectation fits in the sentences.
- **One subject, one place** — a scenario, bug, or gap is written once and referenced elsewhere; evidence lives with
  the scenario it proves.

Three things are non-negotiable, each a verification failure if skipped:

1. **Evidence, not adjectives.** Every claim cites something concrete — a rect from `getBoundingClientRect()`, a
   quoted string, a computed style, an HTTP response, a video.
2. **The adversarial pass runs** (Step 4), over the feature and over your own gaps.
3. **Every requirement is accounted for** (*Scope*, below). Coverage is a field in the report, not a judgement you
   make about how much of the feature deserves verifying.

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
- **A level allocation is not a scope limit.** Where a doc assigns requirements to test levels — a test matrix, a
  "proven at unit level" column, a phase file claiming a scenario — it tells you where *tests* live. Read it for
  what the feature must do, and take your scope from *Scope* below. Passing unit and integration tests are the
  thing this skill exists to distrust; a requirement they cover is a requirement you verify.

## Scope: Account For Every Requirement

Before planning a single walk, enumerate the requirements, stories and edge cases the docs list, by their ids where
they have them. **That enumeration is this run's scope, and it becomes `coverage[]` in the report** — every id
mapped to the scenario that proves it and that scenario's verdict. An id with no entry is an incomplete report, not
a scoping decision.

One walk often proves several requirements at once, and should. **Scenario count is not the target**; an id with
nothing behind it is what you are looking for.

## Output Layout

Everything this skill produces lives in the feature's `verification/` folder, flat:

```
.harness/<SPEC_NAME>/verification/
├── proof-report.html                        the deliverable
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

## Step 1 — Get a Stack

**Where `orchestrate.config.json` carries an `environments` block, it declares how this project starts.** Run the
steps the run's `ENVIRONMENT` names — `skills/orchestrate/references/config.md` owns how each key resolves.
**With no block**, bring-up belongs to the project's **stack skill** (among its own skills, or one `CLAUDE.md`
names), else to the codebase. Follow that skill for procedure, never for proof: the evidence bar here does not move
to match a project's conventions.

**Take the base URL from the entry's own command** and hold it for the session — a URL assembled from an assumed
port is the wrong stack.

**Step 1 is done when the route you came to drive returns the page you expect**, every service a scenario needs is
up — including the sink a side effect lands in, often a separate service the stack-up does not launch — and two
questions no config key expresses are answered:

1. **What this stack shares** with parallel runs, and what is isolated.
2. **Where each out-of-band effect lands** — email, queue, webhook — and how to read that sink.

Both belong to the stack skill, and both are expensive to discover halfway through a walk. If a service genuinely
will not start, exit **BLOCKED:no-infra** naming it and what you tried.

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
reaches gets its own scenario. Number and name each as in *Output Layout* before you capture anything.

Drive a real browser through the `agent-browser` CLI — this is where every UI scenario is proven live. If the binary
isn't on PATH, stop with **BLOCKED:no-agent-browser**, name the scenarios you couldn't prove, and print
`npm i -g agent-browser && agent-browser install`.

Open the stack's UI URL and hold **one session** for every scenario. The browser proves the behaviour under test,
not the setup that reached it — a fixture you find missing mid-walk is seeded the Step 1 way and the walk
re-driven. Read `references/driving-the-browser.md` before your first `open` — batching, the `eval` laws, the
capture loop and the phone replay are all there.

**Every flow on the surface the change landed on is replayed on a phone**, as its own numbered scenario in the same
session. Whether this app is meant to work on a phone at all is a project fact like any other.

**Where a design defines the screen you just drove, compare your frame against it.** Open the file plan.md's
`## Design References` names and read the built screen against it on placement and order, labels and copy, and
every state the design draws. Comparison by eye is the bar; state what matched and what did not in that scenario's
`reason`. A mismatch a user would be wrong-footed by is a bug and routes through Step 4; cosmetic drift is a note
in `extra[]`. A screen nobody drew is not a failure.

**A frame is evidence only once its assert passed and your own eyes confirmed it shows what you think** — read at
the moment you shoot, since frames lag renders. **Done when every behaviour the docs claim is reached by some flow;
every UI scenario's `NN_<slug>` frames in `screenshots/` tell its whole story; every screen a design defines
carries its comparison in `reason`; and every flow on the surface the change landed on has a phone replay driven
to its closing assert, whatever it returned.**

## Step 3 — API, DB & Side-Effects: Proving What Has No Screen

What has no screen to drive lands here — and **when the feature has no UI at all, this step is the whole
verification and carries the whole scope** from *Scope* above. Read `references/headless-verification.md` before
your first request: it holds the shape of a headless walk, and the traps that make one look green when the code
under test never ran.

Run curl with `-w '\n%{http_code}'` and keep the **verbatim exchange**, which a dev re-runs to check you: it goes
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

## Step 4 — Adversarial Pass (MANDATORY — Role Swap)

> **STOP. You are the critic now, not the verifier.** You are graded on defects found, not on agreeing with the
> verdicts above.

**The attack list comes from the walks you just drove**: the errors and warnings you passed over, the state the
feature carries between screens, and the branches the happy path never entered. Re-read the design and plan for
what the change touches beyond what you drove, including the rest of the surface it landed on — one new field on a
settings page puts every other field on that page in scope. Leave your draft report closed while you write the
list; it anchors you to what you already concluded.

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

**Film every bug by re-running its repro**: a bug cannot be captured before it is found, so once a probe lands,
write its steps and drive them again as its own scenario. **Name the attack you most expected to land and say why
it did not.**

**Done when every bug reproduces from its own steps, names the actor who reached it and whether this change
introduced it, and carries its film; and every `NOT VERIFIED` names the line that blocks it.**

## Step 5 — Build the Videos

Assemble one video per scenario from the promoted frames in `screenshots/` — the ffmpeg command is in
`references/writing-the-report.md`. Build them **before** the report so the videos it points at already exist.

## Step 6 — Write the Proof Report, Then Report Back

Copy `references/proof-report-template.html` to `verification/proof-report.html` and fill its JSON island. The
field-by-field contract, the derivation of the overall verdict, and the completion checklist are in
`references/writing-the-report.md`. **The overall verdict is derived, not chosen** — a feature's headline promise
left unproven is not a pass because the scenarios around it passed. **Done when every bullet of that checklist
holds.**

Then **report back to whoever dispatched you** — everything the report excludes belongs here: the derived verdict
and the verdict per scenario; whether the feature works; every bug and what needs a decision rather than a fix; the
`verification/` path and its videos; **the stack you drove** — how it was brought up and at which commit, so a
reader knows exactly which code this verdict covers; and **the environment findings** — every config value that was
wrong, service that would not boot, datastore that lied, fixture you had to build, command that was documented and
gone. Write
those as durable facts a later run can act on, not as an account of your afternoon: without them the next
verification pays the same cost from scratch.

## Step 7 — Publish, Then Clean Up

Publish so a reviewer finds the evidence without hunting through a worktree. Two homes, both **best-effort — they
never fail the verification**; both implementations are in `references/publish.md`:

- **The feature's tracker** — one attachment: a zip of the whole `verification/` folder, so the report, its frames
  and its videos all resolve once unzipped. That zip is the whole delivery; the ticket keeps the PR link, design and
  plan a human put there. Which tracker and how a branch maps to a ticket are project facts. When the config says
  `none`, is absent, or its token is unset, skip in one line.
- **Claude Sessions** — the report and videos, so they show in the Sessions Artifacts tab. Use the injected
  `SESSION_ID` (orchestrate exports it) verbatim; on a standalone run, derive it from the newest transcript under
  the cwd. Not installed / not authenticated → skip in one line.

Then close the session (`agent-browser --session <SPEC_NAME> close`), remove the fixtures you created, and
**release the stack**: the teardown step of the environment you brought up, else the way the stack skill says.
Anything already running when you arrived stays running, and **release only what you brought up**.

Leave `verification/` in place, uncommitted — it is the deliverable, for a human to read. Delete the staging dir
(`.harness/<SPEC_NAME>/verify-staging/`).
