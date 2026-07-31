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
- **Project verification knowledge** — the app facts verification turns on (login, self-lying surfaces, toast
  duration, where a triggered email lands, shared datastores) live in the **project's own skills** and `CLAUDE.md`.
  Read them first; this skill mandates no dedicated file for them.
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

## Step 1 — Start Infrastructure

Bring the app up the project's documented way. Look first for a **custom skill that starts the services / infra /
stack** (one its `CLAUDE.md` names); if none exists, derive the procedure from `CLAUDE.md` and the codebase — a
`just`/`make` target, a compose file, a `dev`/`start` script.

**Start every service a scenario needs before you drive that scenario** — the backend the feature calls, and any
sink a side effect lands in: a queue board, a mail viewer. That sink may be a **separate service the normal stack-up
doesn't launch** (a project fact); an email is proven by screenshotting the message in its viewer, so the mail
viewer is infrastructure, not an optional extra. If you genuinely cannot start something, exit
**BLOCKED:no-infra**: name the service and what you tried.

**Always start your own instance.** If a service already looks up on its usual port, leave it alone and start fresh
on a free port you allocate — a running server is likely another worktree's. You start it, so you tear it down
(Step 7). Hold the URLs you started on for the rest of this session.

**Infrastructure includes state, and building it is your job.** Seeding records, creating accounts, provisioning a
plan, aging a timestamp, populating a lookup the feature reads — the preconditions a scenario needs are yours to
manufacture, through the product's own APIs where they exist and directly in the datastore where they don't.
Absent test data is a task, not a blocker. You created it, so you remove it (Step 7); never mutate or delete a
record you did not create.

A seeded record **stands in for what the real source would produce**, so its shape and values must be ones that
source can actually emit — a plausible address where a provider would return one, a real plan where the product
would have written one. A value invented to see what breaks tests the datastore, not the feature.

Confirm the stack by fetching the actual route you came to drive and checking it returns the page you expect. If
startup fails, read the named log and stop.

## Step 2 — UI Verification: Film the Whole Life of the Scenario

Read the feature's docs and **take a scenario from each behaviour they say the feature must have**. Where a doc
hands you an outcome without a walk, work out the walk yourself. Number and name each one as in *Output Layout*
before you capture anything.

Drive a real browser through the `agent-browser` CLI — this is where every UI scenario is proven live. Check the
binary first: if `agent-browser` isn't on PATH, stop with **BLOCKED:no-agent-browser**, name the scenarios you
couldn't prove, and print `npm i -g agent-browser && agent-browser install`.

Open the UI service you started in Step 1 and hold **one session** for every scenario. Read
`references/driving-the-browser.md` before your first `open` — batching, the `eval` laws, and the capture loop are
all there.

The invariant governing the whole step: **a frame is evidence only once its assert passed and your own eyes
confirmed it shows what you think.** Read at the moment you shoot — frames lag renders. **Done when every UI
scenario has a `NN_<slug>` set of frames in `screenshots/` that tells its whole story, each frame backed by a
passing assert and your own eyes.**

## Step 3 — API, DB & Side-Effects: Proving What Has No Screen

What has no screen to drive lands here — and **when the feature has no UI at all, this step is the whole
verification and carries the whole scope** from *Scope* above. Read `references/headless-verification.md` before
your first request: it holds the shape of a headless walk, and the traps that make one look green when the code
under test never ran.

Run curl with `-w '\n%{http_code}'` and keep the **verbatim exchange**, which a dev re-runs to check you: it goes
**inline and whole** into a `proofs[]` entry (shape in `references/writing-the-report.md`) rather than into a file.
Record the verdict by exact-matching the expected response the design or plan describes. For a db check, query the
database (an MCP tool, else the connection string from the stack you started in Step 1) and keep that exchange the
same way.

**A triggered side effect is a claim too.** When a walk fires something out of band — email, SMS, webhook,
delivered file — prove it at its sink (a project fact) with a **hard deadline** on the poll:

- **Email** — open the mail viewer and screenshot the received message, the same filmable evidence Step 2 produces.
  Its frames carry the scenario's `NN_<slug>` prefix like any other.
- **A job queue (BullMQ/Bull)** — drive the bull-board and screenshot the queue and the job. Genuinely try to bring
  the board up; it may be a separate service you started in Step 1. If it truly can't come up, capture Redis or the
  logs instead and say in the scenario what the board was and what you tried. The technique and its false-negative
  traps are in `references/queue-dashboard.md`.
- **Webhooks and delivered files** — keep the artifact as `verification/NN_<slug>.<ext>`, listed in the scenario's
  `artifacts[]`.

When the project says the effect is deliberately neutralized here, prove the enqueue instead and say so. When it
documents no sink for an effect the feature clearly produces, the scenario is `NOT VERIFIED`.

## Step 4 — Adversarial Pass (MANDATORY — Role Swap)

> **STOP. You are no longer the verifier — you are the critic.** You are graded on bugs discovered, not agreement
> with the prior verdicts.

**Write the attack scenarios from the feature you just watched being built.** You spent a whole pass inside it: you
know which surfaces are fragile, what state it carries between screens, and what the happy path stepped around.
Those observations are the source — the regressions and critical paths this particular build implies. Re-read the
design and plan for what the feature touches beyond what you drove, and leave your draft report closed; it biases
you toward what you already wrote.

**Attacks come from actors, not from fields.** Before writing probes, list the surfaces this feature reads and mark
each with who can write it: the user, another tenant, an operator, a third-party system, or the product itself.
Probes come from the first three, and from the fourth only through its **real** failure modes — unreachable, slow,
timing out, 500, not-found, a field absent, a record stale. Read the integration's own contract to decide what that
service can actually emit.

A value only a third-party system writes is attacked by making that system behave badly in a way it can, never by
writing into its store a value it would never return. The same holds for any field the product populates from
somewhere else — a derived total, a computed status, an id it issues.

Attack surfaces worth a scenario each, where they apply: boundary and malformed values **in the fields an actor
fills** — empty, max-length+1, wrong type, unicode, `<script>`, negative, far-future dates, entered where the
product accepts them · interrupted sequences (cancel mid-flow, double-submit,
back-during-save, reload, two tabs on one form) · the rest of the surface the change landed on — one new field on a
settings page means exercising every other field there · error recovery, and whether state is left stale in UI, DB,
or cache · status accuracy on cancellations, timeouts, and partial failures (the classic: a "Saved" toast on a 500)
· permissions — the same action as another role, an expired session, a missing token, since the UI's rules are not
the API's · concurrency: two writers, read-during-write, lock conflicts.

Find out what the stack shares before writing concurrency or stale-data scenarios — worktrees commonly get their own
ports while sharing one database and search index, which is what makes those scenarios honest rather than
theoretical. Name fixtures uniquely regardless.

Drive probes exactly as in Step 2 — same session, same `NN_<slug>` prefix, same frames, same Read; a probe with no
screen follows Step 3. Then route each result by **provenance**:

- It probed a behaviour the docs describe — a boundary on a validation rule, an error path. That is evidence for
  **that scenario**, not a scenario of its own. **Expect most probes to land here.**
- It probed something nobody asked about and found a real bug — its own scenario, and an entry in `bugs[]`. Before
  writing that entry, settle two things about it. **Who reached it**: name the actor and the surface they used, in
  one sentence. If the only route was writing a value into a store the product fills from somewhere else, there is
  no actor to name — it is a corrupted database, not a defect, and it belongs in `extra[]` as a note on what the
  feature trusts, or nowhere. **Where it came from**: run `git blame` and `git diff` on the lines that decide the
  behaviour and say whether this change introduced it, or it predates the change, or it predates the change and
  this work made its consequences worse. A maintainer's first question is whether to revert; answer it in the
  report rather than in their head.
- It probed something nobody asked about and the feature held — it appears only in the sentence naming your best
  attack.

A rejection you provoked is the feature working: a 400 on bad input is evidence for whichever scenario owns that
rule. A behaviour the docs deliberately exclude is expected, not a bug — though it still needs a decision if another
artifact of the same feature contradicts it.

**Then turn on your own gaps.** Every scenario you are about to mark `NOT VERIFIED` is a claim, and it gets
attacked like one: what would make it reachable, and is the cause you wrote the real one or the first wall you hit?
Read the blocking code path until you can name the line, the condition, the missing credential, or the absent
datum. "The gate didn't fire" is a symptom; "condition X at `file:line` requires Y, which this environment has no
way to supply" is a cause. A gap that survives this is real. One that doesn't was an early stop — go verify it.

**Name the attack you most expected to land and say why it didn't.** And **film every bug by re-running its
repro** — you can't capture a bug prospectively, so once a probe lands, write its steps and drive them again as its
own scenario, filming the whole thing. **Done when every bug has an entry that reproduces from its own steps, names
the actor who reached it and whether this change introduced it; and every `NOT VERIFIED` has been attacked and
names its blocking mechanism.**

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
`verification/` path and its videos; and **the environment findings** — every config value that was wrong, service
that would not boot, datastore that lied, fixture you had to build, command that was documented and gone. Write
those as durable facts a later run can act on, not as an account of your afternoon: without them the next
verification pays the same cost from scratch.

## Step 7 — Publish, Then Clean Up

Publish so a reviewer finds the evidence without hunting through a worktree. Two homes, both **best-effort — they
never fail the verification**; both implementations are in `references/publish.md`:

- **The feature's tracker** — three attachments: the proof report, a zip of the whole `verification/` folder (so its
  relative links resolve once unzipped), and each video. Which tracker and how a branch maps to a ticket are project
  facts. When the config says `none`, is absent, or its token is unset, skip in one line.
- **Claude Sessions** — the report and videos, so they show in the Sessions Artifacts tab. Use the injected
  `SESSION_ID` (orchestrate exports it) verbatim; on a standalone run, derive it from the newest transcript under
  the cwd. Not installed / not authenticated → skip in one line.

Then close the session (`agent-browser --session <SPEC_NAME> close`) and shut down the stack you started in Step 1
the project's way — anything already running when you arrived stays running, and **never kill a server you didn't
start**. Leave `verification/` in place, uncommitted — it is the deliverable, for a human to read. Delete the
staging dir (`.harness/<SPEC_NAME>/verify-staging/`).
