# Verify

`set-status verify running` + `fire --event stage-started --stage verify`. Resolve this stage's skill and model from [config.md](config.md);
read [dispatch-preamble.md](dispatch-preamble.md).

Verification proves the feature does what was asked, by driving it. The gate stage that follows
proves nothing regressed. Neither reads the other's output.

## Dispatch

```text
[PREAMBLE]

Invoke <SKILL:verify>. Pass:
- Mode argument: <MODE_ARG>
- Task: <TASK_CONTEXT>
- Design record: <DESIGN_PATH, omit when planning produced none>
- Plan: <PLAN_PATH>
- Phase files: <PHASE_DIR>/phase-*.md
- Phase E2E reports: <HARNESS_DIR>/phase-*-e2e.json
- Verification output: <HARNESS_DIR>/verification/
- Feature/harness dir: <HARNESS_DIR>
- Spec name: <SPEC_NAME>
- PACKAGES: <PACKAGES>
- ENVIRONMENT: <ENVIRONMENT>
- Auto-fix rounds left after this attempt: <ROUNDS_LEFT>
- Changed files this round (optional hint, omit on the first attempt): <CHANGED_FILES>

Return the verification verdict and every bug it reports, ending with the JSON block its Step 6
defines.
```

`ROUNDS_LEFT` is 3 on the first attempt and one fewer per auto-fix round. It decides nothing here;
it tells the agent whether its report is owed yet, per the rounds below.

For the implement route, pass the recon findings and task instead of the design, plan and phase
files that route never produced. For a resumed run, trace each entry's affected requirements using
`skills/rework/references/blast-radius.md` before dispatch, and give the agent every `TARGETS[]`
entry with its own plan, prior proof report, traced ids and environment. A failed entry fails the run.

## After return

1. Before trusting the verdict, check what the attempt owed. Note whether
   `<HARNESS_DIR>/verification/proof-report.html` exists before each dispatch, and its timestamp —
   each entry's own path for a resumed run, where a prior report is an input rather than this
   attempt's output.
   - An attempt that owed a report must have left one newer than that. Its absence, or the old
     file unchanged, is `MISSING_VERIFICATION_ARTIFACTS` and halts: a verdict without the artifact
     means the work was skipped, or the agent never reached the step that writes it. Then fire
     `artifact-created` with kind `proof-report`, per [events.md](events.md).
   - A deferred attempt — `FAIL` with a round left — owes no report, so require instead that it
     drove something. Note the line count of `<HARNESS_DIR>/verification/run-log.jsonl` — the
     append-only ledger the verify agent adds one line to per finished scenario — before each
     dispatch, and require it to have grown: a round that drove nothing appends nothing, and no round
     rewrites or deletes what an earlier one wrote. At least one scenario artifact under
     `verification/` is the second signal. Neither is the same halt, because a bug list no run
     produced is fiction to fix against.
2. Read the return's JSON block, never its prose. `status` is `PASS`, `PARTIAL`, `FAIL` or
   `BLOCKED`; a block missing, unparseable, or carrying any other `status` is
   `STAGE_CONTRACT_FAILED`. Where a report exists, its own derived `verdict` is the record and must
   agree with `status` — a disagreement is `STAGE_CONTRACT_FAILED` too, because one of the two was
   composed rather than derived.
   - `BLOCKED` — halt with `reason`. No code fix reaches a stack that will not start.
   - `PASS` — continue.
   - `PARTIAL` — `gaps[]` holds one entry per `NOT VERIFIED` scenario: a hole in the proof, not a
     defect in the code, so never auto-fix it. With one or two entries and the rest passing,
     continue and carry each entry's `mechanism` into the stage report, so the unproven surface
     stays visible downstream. More than two halts — that is too much of the feature taken on
     trust.
   - `FAIL` — run the auto-fix rounds below before halting.
3. Give every `bugs[]` entry exactly one disposition in this stage's report: `fixed` with the fix,
   or `accepted` with the reason. A bug with neither is `UNDISPOSITIONED_BUG` — nobody classified
   it, so it is unfinished work rather than an accepted risk. An entry with `needsDecision: true`
   halts here whatever else passed; a product question is not ours to answer.
4. `write-report verify`, then `set-status verify done` +
   `fire --event stage-completed --stage verify --result pass`, its `artifacts` naming
   `proof-report` and `verification`.

## Auto-fix rounds

A `FAIL` whose bugs name their own cause and fix is work, not a question — the verify agent wrote
that fix down itself. Do it and re-prove it before spending a human on it.

At most **three rounds**, each one fix pass plus one re-verification:

1. Take every `bugs[]` entry with `needsDecision: false`; each carries its own `scenario`, `cause`
   and `fix`. If no entry qualifies, halt now — there is nothing a coder can act on.
2. Dispatch the coder skill as [stage-coder.md](stage-coder.md) dispatches it, with
   `IMPLEMENT_MODE=pipeline-review-fix` and one feedback item per entry, carrying its `scenario`,
   `cause` and `fix` verbatim. That mode commits its own fixes, so each round lands as its own
   commit. A worker error or `BLOCKED` halts the round.
3. Re-dispatch verify with a decremented `ROUNDS_LEFT`. You may pass `Changed files this round:`
   listing what that round's fix commit touched, as a convenience; the first attempt has nothing to
   list, since nothing has been fixed yet. The verify agent derives its own list across every repo
   in play and adds whatever you send to it, so a hint can only add work and sending none costs
   nothing. This stage is the wrong place to compute it anyway: it sees one commit in one repo, and
   a fix can span several. What to re-drive is the verify agent's call and not this stage's. Read
   the new verdict by step 2 above.

Only the terminal attempt writes the report, whatever its verdict — the attempt that passes, that
proceeds on `PARTIAL`, or that exhausts the rounds. One report describes the feature as it finally
stands, instead of a series describing code that no longer exists, and no superseded report can be
mistaken for this attempt's proof.

`PASS`, or a `PARTIAL` that proceeds, continues the pipeline. A `FAIL` after the last round halts
and hands over every round's fixes, what still fails, and why. The quality gate runs after this
stage, so these edits are gated like any others.

Name in the stage report which bugs were auto-fixed and in which round; such a bug is `fixed`,
with its round.

## Halts

| Code | Meaning |
|---|---|
| Worker error or `BLOCKED` | report the evidence and the next action; no code fix reaches it, so it never enters a round |
| `FAIL` after three auto-fix rounds | name the scenarios still failing, and what each round changed |
| `FAIL` with no fixable bug | every bug needs a decision, or none names a cause and a fix |
| `PARTIAL` with more than two `NOT VERIFIED` | list every gap and the mechanism blocking it |
| `MISSING_VERIFICATION_ARTIFACTS` | the terminal attempt left no new `proof-report.html`, or a deferred one captured no evidence |
| A `bugs[]` entry with `needsDecision: true` | a product question, not a code fix |
| `UNDISPOSITIONED_BUG` | a reported bug carries neither disposition in the stage report |
| `STAGE_CONTRACT_FAILED` | no JSON block, an unreadable one, an unknown `status`, or a `status` the report's own verdict contradicts |
