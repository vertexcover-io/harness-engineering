# Quality Gate

`set-status quality-gate running` + `fire --event stage-started --stage quality-gate`. Resolve this stage's skill and model from [config.md](config.md);
read [dispatch-preamble.md](dispatch-preamble.md).

The gate proves nothing regressed, by re-running the project's own checks against
`baseline.json`. It runs after code review so the fixes that stage applied are gated too.

## Dispatch

```text
[PREAMBLE]

Invoke <SKILL:quality-gate>. Pass:
- Mode argument: <MODE_ARG>
- Plan: <PLAN_PATH>
- Phase files: <PHASE_DIR>/phase-*.md
- Phase E2E reports: <HARNESS_DIR>/phase-*-e2e.json
- Baseline: <HARNESS_DIR>/baseline.json
- Feature/harness dir: <HARNESS_DIR>
- Stage: post-tdd
- Spec name: <SPEC_NAME>
- PACKAGES: <PACKAGES>
- ENVIRONMENT: <ENVIRONMENT>

Return the gate verdict and the report path.
```

On the implement route there are no phase files, but `implement` still writes `phase-1-e2e.json`
when it runs a suite. The E2E check reads that report when it exists, and reports `NOT_APPLICABLE`
only when no suite ran — this route skips code review, so the gate is the only thing still looking.
For a resumed run, one agent handles every `TARGETS[]` entry, gating each against its own
baseline. A failed entry fails the run.

## After return

Read the verdict from the gate report's markers, whose syntax the gate skill owns. Then
`write-report quality-gate` and `set-status quality-gate done` +
`fire --event stage-completed --stage quality-gate --result pass|fail`, its `artifacts`
naming `gate-report`.

## Halts

| Code | Meaning |
|---|---|
| Worker error or `BLOCKED` | report the evidence and the next action |
| Gate `BLOCKED` | report which check failed |
| Gate `STAGNATION` | do not retry. Report the stuck check, the repeated error signature, and that it needs a person |
| `CONFIG_STALE` | a declared command would not run; name its package and command |
| `STAGE_CONTRACT_FAILED` | the gate report is missing or unreadable, or carries no verdict marker |
