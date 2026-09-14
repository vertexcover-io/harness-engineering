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

Return the verification verdict and every bug it reports.
```

For the implement route, pass the recon findings and task instead of the design, plan and phase
files that route never produced. For a resumed run, trace each entry's affected requirements using
`skills/rework/references/blast-radius.md` before dispatch, and give the agent every `TARGETS[]`
entry with its own plan, prior proof report, traced ids and environment. A failed entry fails the run.

## After return

1. Before trusting the verdict, check `<HARNESS_DIR>/verification/proof-report.html` exists — each
   entry's own path for a resumed run. Its absence is `MISSING_VERIFICATION_ARTIFACTS` and the
   verdict is `FAILED` whatever the agent said, because a pass without the artifact means the work
   was skipped. Then fire `artifact-created` with kind `proof-report`, per [events.md](events.md).
2. Give every reported bug exactly one disposition in this stage's report: `fixed` with the fix, or
   `accepted` with the reason. A bug with neither is `UNDISPOSITIONED_BUG` — nobody classified it,
   so it is unfinished work rather than an accepted risk. Dispositions never override a `FAILED`
   verdict.
3. `write-report verify`, then `set-status verify done` +
   `fire --event stage-completed --stage verify --result pass`, its `artifacts` naming
   `proof-report` and `verification`.

## Halts

| Code | Meaning |
|---|---|
| Worker error or `BLOCKED` | report the evidence and the next action |
| verification `FAILED` | the feature does not do what was asked; name the scenarios that failed |
| `MISSING_VERIFICATION_ARTIFACTS` | `proof-report.html` is absent |
| `UNDISPOSITIONED_BUG` | a reported bug carries neither disposition |
| `STAGE_CONTRACT_FAILED` | no verdict came back, or one that is not `PASSED` / `FAILED` |
