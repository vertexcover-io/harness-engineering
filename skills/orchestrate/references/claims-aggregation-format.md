# Claims Aggregation Format & UI-Proof Gate

After every coder phase has produced `.harness/<SPEC_NAME>/phase-<N>-claims.json` (see `skills/orchestrate/references/phase-claims-format.md` for the per-phase shape), orchestrate aggregates them into a single `.harness/<SPEC_NAME>/claims.json` that functional-verify consumes.

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

## Verification proof (runs AFTER functional-verify returns)

functional-verify drives the browser and writes `.harness/<SPEC_NAME>/verification/` —
`proof-report.md` alongside one `NN_<slug>.mp4` per scenario (plus any downloaded CSVs and API
captures), with all the frames in a single `screenshots/` folder. **None of it is gated,
parsed, or committed.** The report is written for a human in plain English and deliberately carries
no claim ids, so there is nothing here to grep; the verifier reports its verdict and its bugs back
in prose when it returns.

Check only that the run happened:

```bash
cd '<WORKTREE_PATH>' || exit 1
test -f '.harness/<SPEC_NAME>/verification/proof-report.md' \
  || { echo 'MISSING_PROOF_REPORT'; exit 1; }
```

The claims model still earns its keep upstream: `executed > 0` and `failed = 0` on the aggregated
`claims.json` is what proves the coder's suites ran and passed, and functional-verify reads the
claims to decide what to drive. It just no longer decides whether verification counted.

## Verdict mapping

| Outcome | Pipeline action |
|---------|-----------------|
| Gate passes | Continue to quality-gate |
| `MISSING_PHASE_CLAIMS` | Stop pipeline. Coder did not produce phase reports. |
| `MISSING_CLAIMS_FILE` | Stop pipeline. Aggregation step was skipped. |
| `MISSING_PROOF_REPORT` | Stop pipeline. Functional-verify did not run (Stop hook should have caught this). |

## Why verification is not gated

A passing Playwright `.spec.ts` from the coder phase asserts a *contract* (selectors exist, values persist) but does not let any human eye see the rendered page. Two real bugs surface only when a verifier opens a browser and looks:

- Silent validation failures (the API accepts a value the UI says is invalid).
- Layout / neighbour-ordering breakage that a contract test cannot encode.

That is what functional-verify is for, and it is why the claims carry a `surface` and a `behavior` at all. But the evidence it produces — a flow filmed frame by frame, each frame read and asserted against — is aimed at a person watching it, and no grep over prose can tell a real drive from a plausible one. Pretending otherwise bought a regex that passed whenever the report used an id format it didn't expect, and passed vacuously on every spec whose claims weren't tagged `ui` — which surface-based routing made the common case. The verifier reports what it proved and what it found; a human decides whether that is enough.
