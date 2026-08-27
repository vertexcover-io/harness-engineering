---
name: harness-retro
description: "Audit a finished pipeline run and report the harness defects it exposed. Mines the run's session transcripts for what broke and writes one ranked report for the people who build the harness. Runs as orchestrate Stage 7, after the PR. Also use it whenever a run ends or aborts and the user says retro, post-mortem, what went wrong in that run, why did the harness stop, or hands over a session transcript path. Ranks correctness risk above time cost: a defect that would ship silently in --auto outranks one that wasted an hour."
---

# Harness retro

You audit the **harness**, not the feature. The feature's code is evidence only. It tells you
what a stage did or missed.

You write one file, `report.md`. Your reader builds the harness. Your reader has never heard of
the task, the repo, or the product. Every issue must stand alone for that reader.

## Definitions

Use these words for these meanings, every time.

- **Run** — the one pipeline execution you audit.
- **Stage** — one step of the pipeline, such as setup, plan, coder, review, or verify.
- **Gate** — a check that can stop the run. A review pass and a user approval are both gates.
- **Seam** — the boundary between stage N and stage N+1.
- **Detector** — one mechanical check for suspicious records.
- **Lead** — one detector hit. A lead is not yet an issue.
- **Issue** — a confirmed defect that goes in the report.
- **Spine** — the ordered list of every message the human typed during the run.

## Run this in a sub-agent

Dispatch the retro as its own agent, always. Two reasons.

- **Fresh context is the point.** An auditor that carries the run's own reasoning inherits the
  run's blind spots. It agrees with the decisions it is meant to question.
- **You are mining a file you are still writing.** The retro reads the session transcript. Run it
  inline and the transcript grows under you. As a sub-agent, the parent's transcript is complete
  through the moment of dispatch.

Orchestrate calls this skill as Stage 7, after the PR exists. A human calls it later. Neither
needs to know the transcript path.

**Stage 7 never fails the pipeline.** The PR is already open by the time the retro runs. A retro
that cannot complete prints one line saying why and exits clean.

## Three rules

1. **Run the scripts, read the output.** Transcripts are megabytes of JSONL. `scripts/extract.py`
   turns them into nine small files. Read those. Opening a transcript with `Read` destroys your
   context and gains you nothing.
2. **Cite every claim.** Write `main:1234` for the main transcript and `agent-ID:558` for a
   sub-agent. Delete a claim you cannot cite. Label an estimate as an estimate.
3. **Check the present before you recommend.** The repo and the harness moved on after the run.
   Read the current skill file and the current repo state first. When the current version already
   fixes the defect, keep the issue and say so in the **Fix** field.

## Step 0 — Extract

```bash
SKILL="${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/skills/harness-retro"
OUT='.harness/<SPEC_NAME>/retro'
python3 "$SKILL/scripts/extract.py" --out "$OUT" --session "$SESSION_ID" --project "$LAUNCH_DIR"
```

The script finds its own inputs. With no `--session` and no `--main` it takes the project's newest
session and the `subagents/` directory beside it. Stage 7 passes the `SESSION_ID` orchestrate
captured during Initialization, and `--project` is the **launch directory**, not the worktree —
transcripts live under the directory the run started in. Add `--tz ZONE` to print every time in
one timezone.

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

- **Harness skills directory** — `${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/skills/`, or the
  version under `~/.claude/plugins/cache/harness/harness/VERSION/skills/`. Fixes name these paths.
  Read `manifest.json` in `.harness/<SPEC_NAME>/` for the version the run actually used.
- **The project repo** — read-only. Use it to check whether a defect still exists.
- **Pull request numbers** — from `manifest.json` (`pr_number`) in a pipeline run. Human review
  comments on the PR show what the pipeline's own review stages missed.

Sub-agent transcripts are found automatically. When none exist you lose most `CAUGHT` findings.
Say so in the report.

## Step 1 — Run the detectors

Work every detector. The first eight are already answered by Step 0's files; you read them, you
do not re-derive them. The last four you run yourself. Record two numbers per detector: hits
found, and hits that became issues. The report appendix needs both.

| # | Detector | Where | Signal |
|---|----------|-------|--------|
| D1 | Unsolicited human text | `01-spine.txt` | A message that is not the kickoff and not an answer to a pending question. Every `QUEUED` message is one by definition |
| D2 | Question audit | `05-ask-user.txt` | Flag questions asked after plan approval. Flag answers that correct rather than select |
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

- A gap before a human message is **blocked time**. The agent waited for the human.
- A gap in the main transcript while a sub-agent was running is **normal**. The orchestrator was
  waiting for its own worker. Open that agent's transcript and confirm activity.
- A gap with no running sub-agent and no pending question is a **stall**. Only this one counts.

Skipping the bracket rule turns a healthy run into fake stalls, and the report loses trust.

**Blocked time.** Blocked time is the sum of gaps where the agent asked and the human had not yet
answered. Nothing else counts. Report it per stage and for the whole run.

Done when: every detector has run, and every gap over 5 minutes carries one of the three bracket
labels.

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

**The seam walk.** Take each stage boundary. Name one fact stage N ended with: a decision, a
constraint, a file it found, a command that worked. Then check whether stage N+1 re-derived that
fact or got it wrong. Both skills can do their jobs correctly while the seam drops the fact. No
single skill's own retro finds this.

**The requirement walk.** The run's documents form a chain: ticket, then PRD, then design, then
plan, then phase files, then review, then verification. Pull the `Write` payload of each document
from the main transcript. List the acceptance bullets in the PRD. For each bullet, pick a
distinctive phrase of three to six words. Search that phrase across every later document and
across the raw main transcript. A bullet that appears in the PRD, vanishes from the design and
the plan, and returns in a human message is a confirmed seam drop. Cite every link of the chain.

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
  seam failure. The dispatcher asserted instead of checking.

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

Write one file, `report.md`, beside the extractions — `.harness/<SPEC_NAME>/retro/report.md` in a
pipeline run. `.harness/` is gitignored, so the report never reaches the PR.

Write the report prose in Simplified Technical English, the same style this skill uses. Use the
active voice. Keep sentences to 20 words or fewer. Give one idea per sentence. Keep paragraphs to
6 sentences or fewer. Explain a technical term the first time you use it, then reuse that term.
The style rules control prose only. Keep every path, command, number, and quoted output exact.

Order issues by severity first, then by class in the order `MISSED`, `BLOCKED`, `SLOW`, `CAUGHT`.
Do not cap the issue count. Every issue earns its place with evidence.

### Report structure

**1. Header**

| Field | Value |
|-------|-------|
| Session id | the id only |
| Task | ticket id and title |
| Kickoff | the run mode, then the human's first instruction in one line |
| Harness version | the version only |
| Started at | local time, with the timezone named |
| Total time | human-readable, such as `31h 12m` |
| Blocked time | human-readable. Waiting on the human only |

Close the header with the line that makes every citation usable:

```markdown
Citations read `main:1234`. To open one:
`python3 SKILL_DIR/scripts/cite.py MAIN.jsonl 1234 --context 5 --tz Asia/Kolkata`
Extractions are in `OUT/`.
```

Write the real paths, not the placeholders. A line number nobody can open is not evidence.

**2. Stage timeline**

| Stage | Start | Total time | Blocked time | Issues |
|-------|-------|-----------|--------------|--------|

**3. Issues at a glance**

One row per issue, in report order. This table is how a reader decides what to read.

| # | Issue | Severity | Class | Fix type | Stage | Cost |
|---|-------|----------|-------|----------|-------|------|

**4. Issues**

One block per issue. Keep the field order.

```markdown
### I3 — Verifier proved the fix against data it injected itself

- **Severity:** major
- **Class:** MISSED
- **Fix type:** skill-gap
- **Stage:** functional-verify
- **Missed by:** no gate reads the verifier's method, only its verdict
- **When:** 14:22 → 14:51 IST (29m)

**Description**
Two to five plain sentences. Say what the agent was trying to do. Say what it did instead.
Quote the human or the agent where the words carry the point.

**Proof**
The verbatim command, message, or output in a fenced block. Trim it, never paraphrase it. Cap
it near 15 lines. Cite the source: `main:1234 @ 14:22 IST`.

**Cause**
The root cause in one paragraph. Not the proximate error.

**Fix**
The file to change and the rule to add. Use the current version's path. Say when the current
version already fixed it.

**Generalizes to**
The task-agnostic pattern, and the kind of ticket that hits it again.
```

The **Missed by** field is mandatory on every `MISSED` and `BLOCKED` issue. Name the gate that
should have caught the defect, and say why it did not. A defect that reached the human passed
*through* every gate on the way, and the gate it beat is the gate to fix.

**5. Appendix**

- Detector table: hits found and hits kept, per detector. Name the detectors that produced only
  noise.
- What the transcripts could not answer, and why. Missing sub-agent capture, truncated output,
  and state that lived only on a dashboard all belong here.
- What a live incident log would have caught that this post-hoc mining could not.

Done when: every issue carries all six header fields plus the five prose fields; every `MISSED`
and `BLOCKED` issue names the gate that missed it; every `CAUGHT` issue carries a one-off verdict;
the at-a-glance table has one row per issue; and a reader who never saw the task can follow every
issue without opening a transcript.
