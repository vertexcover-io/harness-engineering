# Claims Aggregation Format & UI-Proof Gate

After every coder phase has produced `.harness/<SPEC_NAME>/phase-<N>-claims.json` (see `skills/tdd/references/phase-claims-format.md` for the per-phase shape), orchestrate aggregates them into a single `.harness/<SPEC_NAME>/claims.json` that functional-verify consumes.

## Aggregated `claims.json` schema

```jsonc
{
  "spec": "web-search-settings",
  "aggregated_at": "2026-05-20T18:14:02Z",
  "executed": 38,                     // sum across phases
  "passed":   38,
  "failed":    0,
  "phases":   [3, 5, 7],              // phases that contributed a report
  "e2e_runs": [                       // one entry per phase report — runner evidence
    {
      "phase": 7,
      "runner": "playwright",
      "report_path": ".harness/web-search-settings/phase-7-playwright.json",
      "command": "pnpm test:e2e --reporter=json",
      "executed": 12,
      "passed":   12,
      "failed":    0,
      "started_at":  "2026-05-20T18:11:02Z",
      "finished_at": "2026-05-20T18:12:43Z"
    }
  ],
  "claims": [                         // concatenated, ids remain unique because of PHASE<N>-C<M> scheme
    {
      "id": "PHASE7-C1",
      "type": "ui",
      "surface": "/admin/settings",
      "behavior": "User can enable Web Search and persist queries across reload",
      "proven_by": "web-search-settings.spec.ts::persists across reload"
    }
  ]
}
```

## Aggregation command

```bash
cd '<WORKTREE_PATH>' || exit 1
HARNESS_SPEC_DIR='.harness/<SPEC_NAME>'
shopt -s nullglob
PHASE_FILES=( "$HARNESS_SPEC_DIR"/phase-*-claims.json )
if [ ${#PHASE_FILES[@]} -eq 0 ]; then
  echo 'MISSING_PHASE_CLAIMS — coder produced no phase-*-claims.json files'; exit 1
fi
jq -s '{
  spec: "<SPEC_NAME>",
  aggregated_at: (now | todate),
  executed: (map(.executed // 0) | add),
  passed:   (map(.passed   // 0) | add),
  failed:   (map(.failed   // 0) | add),
  phases:   (map(.phase)),
  e2e_runs: (map(select(.e2e_run != null) | {
              phase: .phase,
              runner: .e2e_run.runner,
              report_path: .e2e_run.report_path,
              command: .e2e_run.command,
              executed: .executed,
              passed:   .passed,
              failed:   .failed,
              started_at:  .e2e_run.started_at,
              finished_at: .e2e_run.finished_at
            })),
  claims:   (map(.claims // []) | add)
}' "${PHASE_FILES[@]}" > "$HARNESS_SPEC_DIR/claims.json"
```

If aggregation fails → stop the pipeline with `MISSING_PHASE_CLAIMS`.

## UI-proof gate (runs AFTER functional-verify returns, BEFORE quality gate)

This gate is the reason the claims model exists. Every `type: "ui"` claim must have an independent Playwright MCP screenshot referenced in `proof-report.md` — not in the phase's `.spec.ts`, not in the phase report. The verifier must have driven a real browser via `mcp__playwright__browser_*` and captured the screenshot themselves.

```bash
cd '<WORKTREE_PATH>' || exit 1
CLAIMS_FILE='.harness/<SPEC_NAME>/claims.json'
PROOF='docs/spec/<SPEC_NAME>/verification/proof-report.md'

if [ ! -f "$CLAIMS_FILE" ]; then
  echo 'MISSING_CLAIMS_FILE'; exit 1
fi
if [ ! -f "$PROOF" ]; then
  echo 'MISSING_PROOF_REPORT'; exit 1
fi

MISSING=""
for CLAIM_ID in $(jq -r '.claims[] | select(.type == "ui") | .id' "$CLAIMS_FILE"); do
  # proof-report must reference the claim id AND a screenshot path under verification/screenshots/
  if ! grep -q "$CLAIM_ID" "$PROOF"; then
    MISSING="$MISSING $CLAIM_ID(no-id-mention)"
    continue
  fi
  # Lines mentioning the claim id must include a screenshot reference
  if ! awk -v id="$CLAIM_ID" '
        $0 ~ id { found=1 }
        found && /verification\/screenshots\/.*\.png/ { ok=1; exit }
        END { exit ok ? 0 : 1 }
      ' "$PROOF"; then
    MISSING="$MISSING $CLAIM_ID(no-screenshot)"
  fi
done

if [ -n "$MISSING" ]; then
  echo "MISSING_UI_PROOF —$MISSING"
  echo "Every UI claim must have an independent Playwright MCP screenshot in $PROOF."
  echo "A passing phase .spec.ts does NOT satisfy this gate — verify must drive the browser itself."
  exit 1
fi
```

## Verdict mapping

| Outcome | Pipeline action |
|---------|-----------------|
| Gate passes | Continue to quality-gate |
| `MISSING_PHASE_CLAIMS` | Stop pipeline. Coder did not produce phase reports. |
| `MISSING_CLAIMS_FILE` | Stop pipeline. Aggregation step was skipped. |
| `MISSING_PROOF_REPORT` | Stop pipeline. Functional-verify did not run (Stop hook should have caught this). |
| `MISSING_UI_PROOF — <ids>` | Stop pipeline. Verify skipped Playwright MCP for one or more UI claims. Re-dispatch verify with explicit instruction to cover the listed claim ids. |

## Why this gate exists

A passing Playwright `.spec.ts` from the coder phase asserts a *contract* (selectors exist, values persist) but does not let any human eye see the rendered page. Two real bugs surface only when a verifier opens a browser and looks:

- Silent validation failures (the API accepts a value the UI says is invalid).
- Layout / neighbour-ordering breakage that a contract test cannot encode.

The UI-proof gate forces a Playwright MCP session per claim. The screenshot is the evidence.
