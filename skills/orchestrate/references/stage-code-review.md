# Code Review

`set-status code-review running` + `fire --event stage-started --stage code-review`. Resolve the review skill from [config.md](config.md)
and invoke it via `Skill` in this conversation. It dispatches its own reviewers, applies
fixes, and records them in the report; the quality gate runs after, so those edits are gated.
If the skill errors or cannot finish, stop and report the review failure and next action.

Pass:

- `<MODE_ARG>`
- `--plan <PLAN_PATH>`
- `--commits <BASE_BRANCH>..HEAD`
- `--output <HARNESS_DIR>/review/review.md`

For a resumed run, invoke once per `TARGETS[]` entry from its worktree, using its original
`plan` and `--commits <base_sha>..HEAD`. Write each report to the primary's
`review/review-<TARGET_ID>.md`, using the entry IDs from [resumed-runs.md](resumed-runs.md).

## Read the verdict

Match in this order: `REQUEST CHANGES`, `APPROVE WITH SUGGESTIONS`, `APPROVE`.
A missing or unreadable report, or an unrecognized verdict, stops the stage as `STAGE_CONTRACT_FAILED`.

- `APPROVE` or `APPROVE WITH SUGGESTIONS`: continue.
- `REQUEST CHANGES` with a documented standard violation cited to its source file and rule:
  halt, reporting that citation and the defect's `file:line`.
- `REQUEST CHANGES` with judgement-only defects: log a warning and proceed to verification.

Any resumed entry with a cited standard violation halts the run.
`write-report code-review`, then `set-status code-review done` +
`fire --event stage-completed --stage code-review --result pass|fail`, its `artifacts`
naming `review/review.md`.
