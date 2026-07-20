# Dashboard Report Formats

Use these formats when the orchestrator or sub-agents write dashboard reports via `dag-update write-report`.
Each format corresponds to a pipeline stage.

Usage: `/usr/bin/env bash '<DAG_SCRIPT>' write-report <node-id> '<markdown following the format below>'`

## Coder Phase Report

```
# Phase N: <name>

## Summary
2-3 sentences on what was accomplished.

## Files Changed
- `path/to/file.ts` — created/modified (what changed)

## Tests
- X tests added, all passing
- Coverage: X%

## Key Decisions
- Decision and reasoning

## Issues Encountered
- Issue and resolution (or "None")
```

## Code Review Report (Review #N)

```
# Code Review #N

## Verdict: <APPROVE|APPROVE WITH SUGGESTIONS|REQUEST CHANGES>

## Summary
<2-3 sentence assessment>

## Defects Found
- Critical: <count>
- Important: <count>
- Minor: <count>

## Details
<key findings with file:line references>
```

## Fix Report (Fix #N)

```
# Fix #N

## Defects Addressed
- **<defect title>** (`file:line`) — <what was fixed>

## Files Modified
- `path/to/file` — <what changed>

## Tests
- All passing: yes/no
- New tests added: <count or "none">
```

## Verification Report

```
# Functional Verification

## Verdict: <PASSED|FAILED>

Full report + evidence: `.harness/features/<SPEC_NAME>/verification/proof-report.md`

## Scenarios

| What is to be tested | Success/Failure | Reason/Details | Reference |
|---|---|---|---|
| Signing in lands the user on their dashboard | Success | Landed on /dashboard, session cookie set | `verification/login-redirects-to-dashboard/proof.mp4` |
| A session that expires mid-save does not report success | Failure | "Saved" toast shown on a 401. Major. | `verification/expired-session-reports-saved/proof.mp4` |
| Creating a user persists the row | Success | 201; DB count 1 as expected | see proof-report |

## Infrastructure
- **Started:** `npm run dev` (PID 12345), `docker compose up -d`
- **Cleaned up:** yes
```

This is the dashboard summary, not a second report: the scenario rows mirror `proof-report.md` so a
reader sees the verdict at a glance, and every piece of evidence stays in the report itself.

## Quality Gate Report

```
# Quality Gate

## Verdict: PASS/BLOCKED/STAGNATION

## Checks
| # | Check | Baseline | Current | Verdict |
|---|-------|----------|---------|---------|
| 1 | Type check | 0 errors | X errors | PASS/FAIL |
| 2 | Lint | X warnings | Y warnings | PASS/FAIL |
| 3 | Tests + behavior coverage | — | X/Y matrix rows covered | PASS/FAIL |
| 4 | Coverage (diagnostic) | X% | Y% | INFO |
| 5 | Scope compliance | — | in-plan / out-of-plan | PASS/FAIL |
| 6 | Plan compliance | — | X/Y scenarios evidenced | PASS/FAIL |
| 7 | Ignore comment audit | — | N new | PASS/FAIL |
| 8 | Smoke test | — | run / none defined | PASS/INFO |
| 9 | E2E report | — | X passed, 0 failed | PASS/FAIL |
| 10 | Mutation spot-check | — | X/Y mutants killed | PASS/FAIL |

## Failures
- Details of any failures (or "None")
```

## Sync Docs Report

```
# Sync Docs

## Documents Updated
- `path/to/doc.md` — what changed

## Documents Created
- `path/to/new-doc.md` — what it covers
```

## Learnings Report

```
# Learnings

## Friction Points
- What caused delays or confusion

## Patterns Documented
- `path/to/learning.md` — what it covers

## Recommendations
- Suggestions for future runs (or "None — clean run")
```

## Commit & PR Report

```
# Commit & PR

## Commits
- `abc1234` — commit message 1
- `def5678` — commit message 2

## Pull Request
- URL: <PR_URL>
- Title: <PR title>
- Branch: <branch> → main
```
