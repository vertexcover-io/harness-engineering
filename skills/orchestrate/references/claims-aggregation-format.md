# Claims Aggregation Format & UI-Proof Gate

## Contents

- [Aggregated `claims.json` schema](#aggregated-claimsjson-schema)
- [Aggregation command](#aggregation-command)
- [Aggregated-claims check (Stage 5)](#aggregated-claims-check-stage-5)
- [Verification proof (runs AFTER functional-verify returns)](#verification-proof-runs-after-functional-verify-returns)
- [Verdict mapping](#verdict-mapping)
- [Why verification is not gated](#why-verification-is-not-gated)

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

Run the script — do not transcribe its `jq`. It writes the schema above and emits
`MISSING_PHASE_CLAIMS` when the coder produced no phase reports:

```bash
bash "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/skills/orchestrate/scripts/aggregate-claims.sh" '<WORKTREE_PATH>' '<SPEC_NAME>'
```

If aggregation fails → stop the pipeline with `MISSING_PHASE_CLAIMS`.

## Aggregated-claims check (Stage 5)

Before trusting the Stage 5 verdict, prove the coder's suites actually ran and passed:

```bash
cd '<WORKTREE_PATH>' || exit 1
CLAIMS='.harness/<SPEC_NAME>/claims.json'
test -f "$CLAIMS" || { echo 'MISSING_CLAIMS_FILE'; exit 1; }
jq -e '.executed > 0' "$CLAIMS" >/dev/null || { echo 'E2E_NOT_EXECUTED'; exit 1; }
jq -e '.failed == 0'  "$CLAIMS" >/dev/null || { echo 'E2E_FAILED'; exit 1; }
```

Any printed token stops the pipeline (see [Verdict mapping](#verdict-mapping)).

## Verification proof (runs AFTER functional-verify returns)

functional-verify drives the browser and writes `.harness/<SPEC_NAME>/verification/` —
`proof-report.html` alongside one `NN_<slug>.mp4` per scenario (plus any downloaded CSVs and API
captures), with all the frames in a single `screenshots/` folder. **None of it is gated,
parsed, or committed.** The report is written for a human in plain English and deliberately carries
no claim ids, so there is nothing here to grep; the verifier reports its verdict and its bugs back
in prose when it returns.

Check only that the run happened:

```bash
cd '<WORKTREE_PATH>' || exit 1
test -f '.harness/<SPEC_NAME>/verification/proof-report.html' \
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
| `E2E_NOT_EXECUTED` | Stop pipeline. Phase suites were authored but never run (`executed = 0`). |
| `E2E_FAILED` | Stop pipeline. A phase suite ran red (`failed > 0`). |
| `MISSING_PROOF_REPORT` | Stop pipeline. Functional-verify did not run (Stop hook should have caught this). |

## Why verification is not gated

A passing Playwright `.spec.ts` from the coder phase asserts a *contract* (selectors exist, values persist) but does not let any human eye see the rendered page. Two real bugs surface only when a verifier opens a browser and looks:

- Silent validation failures (the API accepts a value the UI says is invalid).
- Layout / neighbour-ordering breakage that a contract test cannot encode.

That is what functional-verify is for, and it is why the claims carry a `surface` and a `behavior` at all. But the evidence it produces — a flow filmed frame by frame, each frame read and asserted against — is aimed at a person watching it, and no grep over prose can tell a real drive from a plausible one. Pretending otherwise bought a regex that passed whenever the report used an id format it didn't expect, and passed vacuously on every spec whose claims weren't tagged `ui` — which surface-based routing made the common case. The verifier reports what it proved and what it found; a human decides whether that is enough.
