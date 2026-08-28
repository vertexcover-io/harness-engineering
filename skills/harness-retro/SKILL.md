---
name: harness-retro
description: >
  Audit a finished harness pipeline run and report the harness defects it exposed. Reads the
  run's session transcripts, finds what broke, and writes one ranked report for the people who
  build the harness. Use this skill whenever a pipeline run ends or aborts, and whenever the
  user says "retro", "retro this run", "post-mortem", "what went wrong in that run", "why did
  the harness stop", or gives you a session transcript path. Ranks correctness risk above time
  cost: a defect that would ship silently in --auto outranks one that wasted an hour.
---

# Harness retro

You audit the **harness**, not the feature. The feature's code is evidence only. It tells you
what a stage did or missed.

You write one file, `report.md`. Your reader builds the harness. Your reader has never heard of
the task, the repo, or the product. Every issue must stand alone for that reader.

## Run this in a sub-agent

Dispatch the retro as its own agent, always. Two reasons.

- **Fresh context is the point.** An auditor that carries the run's own reasoning inherits the
  run's blind spots. It agrees with the decisions it is meant to question.
- **You are mining a file you are still writing.** The retro reads the session transcript. Run it
  inline and the transcript grows under you. As a sub-agent, the parent's transcript is complete
  through the moment of dispatch.

The pipeline calls this skill at the end of a run. A human calls it later. Neither needs to know
the transcript path.

## Three rules

1. **Run the scripts, read the output.** Transcripts are megabytes of JSONL. `scripts/extract.py`
   turns them into nine small files. Read those. Opening a transcript with `Read` destroys your
   context and gains you nothing.
2. **Cite every claim.** Write `main.jsonl:1234` for the main transcript and `agent-ID.jsonl:558` for a
   sub-agent. Delete a claim you cannot cite. Label an estimate as an estimate.
3. **Check the present before you recommend.** The repo and the harness moved on after the run.
   Read the current skill file and the current repo state first. When the current version already
   fixes the defect, keep the issue and say so in the **Fix** field.

## Step 0 — Extract

```bash
SKILL="${CLAUDE_PLUGIN_ROOT}/skills/harness-retro"
OUT=SCRATCH_DIR/retro
python3 "$SKILL/scripts/extract.py" --out "$OUT" --tz Asia/Kolkata
```

The script finds its own inputs. With no arguments it takes the project's newest session and the
`subagents/` directory beside it. Override with `--session ID`, `--main PATH`, `--project DIR`.
Set `--tz` to the timezone the report will use; times print in that zone everywhere.

It writes nine files and prints a summary. Read `00-summary.txt` first.

| File | Holds |
|------|-------|
| `00-summary.txt` | Counts, run span, deaths, top error families. Your first read |
| `01-spine.txt` | Every human message, `TYPED` or `QUEUED`, in order |
| `02-assistant.txt` | Every assistant prose block |
| `03-tool-calls.txt` | One line per tool call |
| `04-tool-errors.txt` | Failed results joined to the call that caused them |
| `05-ask-user.txt` | Each question with its answer |
| `06-subagents.txt` | Per agent: job, span, tool counts, errors, final message, death flag |
| `07-timeline.txt` | Stage boundaries and every gap over 5 minutes |
| `08-incidents.txt` | Interrupts, permission blocks, API faults, hook stops, PR links |

`QUEUED` in `01-spine.txt` means the human typed while the agent was working. Corrections live
there. A spine built from plain user records alone has holes exactly where the corrections are.

Then build two things by hand from these files.

1. **Agent tree** — from `06-subagents.txt`, assign each agent to a pipeline stage.
2. **Stage table** — from `07-timeline.txt`, give every stage a start, an end, and a duration.

Done when: every stage in the table has a start and an end, and every sub-agent belongs to one.

## Other inputs

Ask for whichever the user did not supply.

- **Harness skills directory** — the current version under
  `~/.claude/plugins/cache/harness/harness/VERSION/skills/`. Fixes point at these paths.
- **The project repo** — read-only. Use it to check whether a defect still exists.
- **Pull request numbers** — optional. Human review comments on the PR show what the pipeline's
  own review stages missed.

Sub-agent transcripts are found automatically. When none exist you lose most `CAUGHT` findings.
Say so in the report.

## Step 1 — Run the detectors

Work every detector. The first eight are already answered by Step 0's files; you read them, you
do not re-derive them. The last four you run yourself. Record two numbers per detector: hits
found, and hits that became issues. The report appendix needs both.

A detector hit is a **lead** — a record worth reading, not yet a defect. Step 2 turns each lead
into an issue or a written drop.

| # | Detector | Where | Signal |
|---|----------|-------|--------|
| D1 | Unsolicited human text | `01-spine.txt` | A message that is not the kickoff and not an answer to a pending question. Every `QUEUED` message is one by definition. **Every post-gate message is an issue** — see The line |
| D2 | Question audit | `05-ask-user.txt` | Every question asked after the plan gate is an issue. Before it, flag answers that correct rather than select |
| D2b | Document was unreadable | `01-spine.txt` | A human message asking what a document meant — "explain this", "not clear", "what does this mean", "rewrite this". The document failed. Pre-gate trigger 1 |
| D2c | Repeated instruction | `01-spine.txt` | The same ask from the human two or more times, or the same ground covered twice. Pre-gate triggers 2 and 3 |
| D3 | Error clusters | `04-tool-errors.txt`, `00-summary.txt` | Three or more failures in one command family is a lead |
| D4 | Stalls | `07-timeline.txt` | Every gap over 5 minutes, pre-marked with a bracket checklist. Apply the bracket rule below |
| D5 | Permission blocks | `08-incidents.txt` | `preventedContinuation`, hook errors, `toolDenialKind` |
| D6 | Interruptions | `08-incidents.txt` | `interruptedMessageId`, `isAbortedMidStream` |
| D7 | Agent deaths | `06-subagents.txt` | A `*** DIED ON A PLATFORM LIMIT ***` flag. That agent died mid-job |
| D8 | API and tool faults | `08-incidents.txt` | `isApiErrorMessage`, `apiErrorStatus` |
| D9 | Retry loops | `03-tool-calls.txt` | The same command family re-run three or more times, whether or not it errored |
| D10 | Review harvest | sub-agent transcripts | The review files reviewers wrote. Read their `Write` inputs; the worktree may be deleted |
| D11 | Claim versus catch | `06-subagents.txt` + D10 | Each coder agent's final message against what review later said about the same files |
| D12 | PR comments (optional) | `gh pr view N --json comments,reviews` | Human comments show what the pipeline's review stages missed |

Recipes for D9 to D12 are in
[`references/transcript-schema.md`](references/transcript-schema.md).

**The bracket rule for D4.** A gap is not a stall until you prove it. Check what sat on each
side of the gap.

- A gap in the main transcript while a sub-agent was running is **normal**. The orchestrator was
  waiting for its own worker. Open that agent's transcript and confirm activity.
- A gap before a human message is **blocked time**. Which kind depends on the line — see below.
- A gap with no running sub-agent and no pending question is a **stall**. Only this one is a
  defect on its own.

Skipping the bracket rule turns a healthy run into fake stalls, and the report loses trust.

**Blocked time** is the sum of gaps where the agent asked and the human had not yet answered.
Nothing else counts. Report it per stage and for the whole run, split at the line.

Done when: every detector has run, and every gap over 5 minutes carries one of the three bracket
labels.

## The line

Find the plan gate: the last human approval before the first coder dispatch. Everything after it
is post-gate.

The pipeline's contract is that it runs from the plan gate to the PR with no stopping, no
pausing, and no questions. So the two halves of a run mean opposite things.

| Where | A human message means |
|-------|-----------------------|
| Before the line | The design is being decided. Most messages are expected. Measure the wait, and file an issue against the four triggers below |
| **After the line** | **The contract broke.** File an issue every time, no exceptions |

### Pre-gate triggers

Deciding the design takes conversation, so a human message before the line is not a defect on its
own. These four are.

**The human asked what a document meant.** "Explain this", "what does this mean", "not clear",
"rewrite this" — against a plan, a design, a checkpoint summary, or any prose the pipeline wrote.
The document failed. A reader who has to ask got a document that did not do its job, and the
question proves it. File it against the stage that wrote the document. Quote the sentence the
human could not read.

**The human asked for the same thing more than once.** The agent did not act the first time, or
acted on a different reading of it. Either way the instruction was already given. Count the asks
and cite each one.

**The same ground is covered twice.** Two rounds on one decision means the first round did not
land the question or did not record the answer.

**A question had an answer already in the repo.** The agent asked for something a file, a config,
or the git history already said.

**Every post-gate human message is an issue.** Not because the human was slow, and not because
the question was unreasonable. Because in `--auto` nobody is there to answer it. Whatever that
message corrected, `--auto` ships wrong.

Class it `BLOCKED` and default it to `major`. Lower it to `minor` only when you can show the run
would have produced correct output had the message never arrived. A one-word style correction
still means a design token never reached the coder, so it stays `major`.

This holds for a question the agent asked, a correction the human volunteered, and an interrupt.
Three shapes, one defect: something reached the coder wrong, and only a human standing there
caught it.

**The `QUEUED` label is the cheapest signal in the retro.** A queued message is one the human
typed while the agent was working. Post-gate, that is someone watching output go wrong in real
time. Read every post-gate `QUEUED` message before anything else in the run.

`extract.py` marks the line for you. It takes the last write to a `plan.*` artifact, prints it as
`GATE`, and tags every later message `POST-GATE` in `01-spine.txt` and in the summary. When it
cannot find one it says so; set the line yourself with `--gate-line N` and re-run.

Done when: every post-gate human message has an issue, or a written reason why it does not,
and every pre-gate message has been checked against the four triggers.


## Step 2 — Walk the leads

Take the leads in run order. For each lead, pull the 10 records before it and the 10 records
after it. Answer four questions from the transcript: what was the agent doing, what happened,
what happened next, and what did it cost. Never trust a lead's one-line summary.

Drop a lead that dissolves under inspection. An expected probe is not an error. A legitimate poll
is not a retry loop. Count the drops for the appendix.

Run these four walks even when no detector fired on them.

**The spine walk.** Take each unsolicited human message. Ask what the pipeline had just produced,
and what the human changed. A human message that redirects the approach *after the gates already
passed it* is the most valuable finding in the retro. That message is exactly what `--auto` would
have shipped.

**The handoff walk.** Take each stage boundary. Name one fact stage N ended with: a decision, a
constraint, a file it found, a command that worked. Then check whether stage N+1 re-derived that
fact or got it wrong. Both skills can do their jobs correctly while the handoff between them drops the fact. No
single skill's own retro finds this.

**The requirement walk.** The run's documents form a chain: ticket, then PRD, then design, then
plan, then phase files, then review, then verification. Pull the `Write` payload of each document
from the main transcript. List the acceptance bullets in the PRD. For each bullet, pick a
distinctive phrase of three to six words. Search that phrase across every later document and
across the raw main transcript. A bullet that appears in the PRD, vanishes from the design and
the plan, and returns in a human message is a confirmed handoff drop. Cite every link of the chain.

**The verification-honesty walk.** Take the verify stage. Ask what it *claimed* to check, then
ask what it *actually drove*. Search its commands and narrative for
`monkey-patch|window\._store|page\.route|mock|inject|hardcode|stub`. A scenario proven against
injected data did not test its data path. A verdict copied from a test run is not a verdict. In
`--auto` the verify stage is the ship gate, so a dishonest method here is always major.

Two more checks are cheap and often pay.

- **Vacuous artifacts.** Search each artifact that gates a stage for `TODO`, `{{`, or angle-
  bracket placeholders. An artifact that exists but holds a template means the gate passed on
  nothing.
- **Asserted facts in dispatch prompts.** Pull each `Agent` dispatch prompt in full. Find claims
  about the environment, such as "the server is running" or "the baseline is green". Compare each
  claim against the sub-agent's first ten minutes. A claim the sub-agent had to disprove is a
  handoff failure. The dispatcher asserted instead of checking.

Done when: every lead is an issue or a recorded drop, and all four walks produced a written note
even when the note says "nothing found".

## Step 3 — Classify

Give every issue one class, one fix type, and one severity.

### Class — who caught it

| Class | Meaning |
|-------|---------|
| `MISSED` | No gate, no reviewer, and no human ever caught it. The retro is the first thing to see it |
| `BLOCKED` | The run stopped. The human had to fix, unblock, correct, or redirect |
| `SLOW` | The agent recovered on its own, but burned real time doing it |
| `CAUGHT` | The agent made a mistake and a review stage cleaned it up |

`MISSED` is the class that matters most. Remove the human from the run and `BLOCKED` becomes a
silent failure, while `MISSED` does not change at all. `MISSED` is a direct list of what `--auto`
ships wrong.

Two filters keep the class list honest.

- **Report a `MISSED` issue only when it is major.** A cosmetic defect nobody caught is noise.
- **Apply the one-off test to every `CAUGHT` issue.** Name the skill rule that would have
  prevented it. When you cannot name one, keep the issue and mark it `no action — one-off`. Be
  strict. `CAUGHT` is where noise creeps in. A caught mistake is also proof the gate works, so
  say that too.

A method that does not prove what its report claims is `MISSED`, even when its conclusion happens
to be right. The method ships to the next run; the lucky conclusion does not.

### Fix type — where the fix lives

| Fix type | The fix goes in |
|----------|-----------------|
| `harness-setup` | Pipeline machinery: worktree creation, stage dispatch, config resolution, the version gate |
| `skill-gap` | A stage's `SKILL.md` lacked a rule or a check. Name the rule |
| `handoff` | The fact existed in stage N and never reached stage N+1. No single skill is at fault |
| `missing-context` | Project knowledge the agent needed, that nobody ever wrote down |
| `stale-context` | Project knowledge that existed and was wrong. The fix is a deletion, not a new doc |
| `repo-setup` | The target repo's own bootstrap: `.gitignore`, generated files, dependency install |
| `test-setup` | The test runner's configuration: setup files, fixtures, the browser driver |
| `seed-data` | Test records the run needed and did not have |
| `infra-setup` | Services, datastores, ports, and environment the app needs to run |
| `tooling` | The shell or CLI itself: a command that failed silently, a missing subcommand, a quoting trap |
| `capacity` | Platform limits: session caps, rate limits, context exhaustion. Nothing was misconfigured; the platform ran out |
| `policy` | The agent broke a standing rule the user had already given, such as committing without approval |
| `spec-source` | Ambiguity or error in the ticket or the design. No harness change fixes it. Recommend a process change, never a skill patch |

Give one fix type per issue. Use the root cause's type, not the symptom's. When an issue fits
none, propose a new type in the report and say why.

### Severity — correctness first, time second

| Severity | Rule |
|----------|------|
| `major` | Under `--auto` this ships wrong behaviour or a wrong verdict. Or the pipeline halted and could not recover. Or it cost 30 minutes or more |
| `minor` | Bounded cost, no path to wrong behaviour, under 30 minutes |

A human catching the defect this time does not lower its severity. Justify every severity in one
sentence, and put the correctness risk first.

### One root cause, one issue

Several incidents often share one root cause. Six human messages correcting the same broken
surface are one issue, not six. Write one issue and list the incidents inside it. Counting
symptoms buries the cause the report exists to expose.

### Generalization

Every issue states its pattern, not its instance. Test it: delete every project noun from the
sentence. When nothing survives, it is not a generalization yet.

- Generalizes: "The agent announced a conclusion before the command that would verify it had run."
- Does not: "The agent thought the header lived in the jupiter repo."

Done when: every issue has a class, a fix type, a severity with a one-sentence reason, and a
generalization that survives the noun test.

## Step 4 — Write the report

Write one file, `report.md`, beside your scratch directory.

### How to write

Load the `writing-style` skill and follow it. It owns the voice, the report rules, and the
ship-check you run before delivering.

Two of its rules decide whether this report is usable, so they are worth repeating here.

**Controlled vocabulary stays exact.** `Severity` is `major` or `minor`. `Class` is `MISSED`,
`BLOCKED`, `SLOW` or `CAUGHT`. `Fix type` is one of the fourteen types in Step 3. Never soften them
into friendlier words, and never rename a field. Gloss both coded columns under the problems table.

**Do not print the detectors.** They are how you found the issues, not something the reader needs.
A detector that found something has already produced an issue.

Order issues by severity first, then by class in the order `MISSED`, `BLOCKED`, `SLOW`, `CAUGHT`.
Do not cap the issue count. Every issue earns its place with evidence.

### Report structure

**1. Header**

Open with the facts table. No prose preamble above it. Keep the field names short and ordinary —
they are labels, not sentences.

| Field | Value |
|-------|-------|
| Session id | the id only |
| Task | ticket id and title |
| Kickoff | the run mode, then the human's first instruction in one line |
| Harness | the version only |
| Started | local time, with the timezone named |
| Total time | human-readable, such as `31h 12m` |
| Waiting on human | human-readable. Blocked time only |
| Waiting after the line | human-readable, and the message count. This number should be `0m` |
| Issues | `N major, M minor` |
| Result | shipped or not, then every PR as an embedded markdown link |

Then the glosses a stranger needs to read anything below: the repos or services in one line each,
what a `main.jsonl:1234` citation is, and — if the run and the audit used different machines or harness
versions — one sentence saying so, or every version claim reads as impossible.

Then **"If you only do N things"** — two to four bullets, each naming an issue id, each an
instruction rather than a description. "Fix I1 first, it is one change." "Do not merge until I3 is
settled."

**2. Timeline**

| Step | Started | Took | Waiting on human | Issues |
|-------|-------|-----------|--------------|--------|

Name each step in plain words — "write the code, part 2 of 4" beats "coder phase 2". Add a line
under the table only if one gap dominates the total, and only to say which.

**3. Problems**

One row per issue, in report order. This table is how a reader decides what to read.

| # | Problem | Severity | Class | Fix type | Stage | Cost |
|---|-------|----------|-------|----------|-------|------|

The **Problem** cell is one plain sentence a stranger understands, not a label.

Gloss both coded columns under the table: one line for the four `Class` codes, one for the fix
types. Compact, separated by `·` — a reminder, not a legend.

**4. Detail**

One block per issue, under a one-word heading such as `## Detail`. Keep the field names, the field order, and the field values exactly as below.

```markdown
### I3 — The verifier proved the fix against data it fed in itself

- **Severity:** major
- **Class:** MISSED
- **Fix type:** skill-gap
- **Stage:** functional-verify
- **Missed by:** no gate reads the verifier's method, only its verdict
- **When:** 14:22 → 14:51 IST (29m)

**What**
Start with the background the reader needs — what this stage does, what the tool is for. Then
what the agent was trying to do, then what it did instead. Then why that matters. Quote the human
or the agent where their words carry the point. Length is whatever it takes to be understood,
usually three to eight sentences.

**Evidence**
The verbatim command, message, or output in a fenced block. Trim it, never paraphrase it. Cap it
near 15 lines. Cite the source: `main.jsonl:1234 @ 14:22 IST`. Add a short line above or below saying
what the reader should notice in it.

**Why**
The root cause in plain words. Not the proximate error. If two things went wrong at once, say so
and name both.

**Fix**
The file to change and the rule to add, in that order. Use the current version's path. Say when
the current version already fixed it.
```

The **Missed by** field is mandatory on every `MISSED` and `BLOCKED` issue. Name the gate that
should have caught the defect, and say why it did not. A defect that reached the human passed
*through* every gate on the way, and the gate it beat is the gate to fix.

**5. Notes**

Short. It is not a second report — everything an issue owns stays in that issue's block.

- **What I worked from**: the transcript paths, your extraction directory, and the `cite.py`
  command that opens any citation.
- **What else I noticed**: a fact a walk turned up that is true and worth knowing, but is not a
  defect — so no issue block holds it. One or two at most. If it is already an issue, it does not
  go here.
- **What the recordings could not tell me**: every question the transcripts left open, and why.
  Missing sub-agent capture, unrecorded approvals, state that lived only on a dashboard.

Do **not** print the detector table or a walk-by-walk narrative. Detectors are your method, not the
reader's concern, and a walk that produced a real finding already produced an issue. If a number in
such a table would contradict the issue blocks, it damages the report more than it proves rigour.

Done when: every issue carries all six header fields with their exact vocabulary, plus **What**,
**Evidence**, **Why** and **Fix**; the report opens with the facts table and ends that section in
instructions, not a recap; every `MISSED` and `BLOCKED` issue names the gate that missed it; every
`CAUGHT` issue carries a one-off verdict; the problems table has one row per issue with a class and
a fix-type gloss under it; every duration appears with the same value everywhere it is mentioned;
and a reader who never saw the task can follow every issue without opening a transcript.
