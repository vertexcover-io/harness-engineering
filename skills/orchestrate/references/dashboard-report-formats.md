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

## Scenarios

| # | Type | Description | Verdict |
|---|------|-------------|---------|
| 1 | api | POST /users → 201 + DB entry | PASSED |
| 2 | ui  | Login flow redirects to dashboard | PASSED |

## API Evidence

### VS-1: POST /users
**Command:** `curl -s -X POST http://localhost:3000/api/users -H 'Content-Type: application/json' -d '{...}'`
**Status:** 201
**Body (truncated):**
\```json
{...}
\```
**DB check:** `SELECT COUNT(*) FROM users WHERE email='test@example.com'` → 1 (expected: 1) PASSED

## UI Evidence

### VS-2: Login flow
**Route:** /login
**Screenshots:**
- [Step 1: Login form](verification/screenshots/vs-2-step1.png)
- [Step 2: After redirect](verification/screenshots/vs-2-step2.png)

## Infrastructure
- **Started:** `npm run dev` (PID 12345), `docker compose up -d`
- **Cleaned up:** yes
```

## Quality Gate Report

```
# Quality Gate

## Verdict: PASS/BLOCKED/STAGNATION

## Metrics Comparison
| Metric | Baseline | Current | Status |
|--------|----------|---------|--------|
| Type check | 0 errors | X errors | PASS/FAIL |
| Lint | X warnings | Y warnings | PASS/FAIL |
| Tests | X passed | Y passed | PASS/FAIL |
| Coverage | X% | Y% | PASS/FAIL |

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
