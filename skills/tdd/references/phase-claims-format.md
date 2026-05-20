# Phase Claims Format

Every coder phase that runs an e2e or integration suite MUST emit a phase-claims report at:

```
.harness/<SPEC_NAME>/phase-<PHASE_N>-claims.json
```

This file is the only artifact the orchestrator trusts to decide whether the phase is done. It serves two consumers:

1. **Orchestrate** — gates the phase (`executed > 0`, `failed = 0`, UI surfaces have at least one UI claim) and later aggregates all phase files into `claims.json`.
2. **Functional-verify** — reads the aggregated `claims.json` and independently re-proves every `type: "ui"` claim via Playwright MCP. The phase report is *corroborating evidence*, not a substitute for independent reproof.

## Schema

```jsonc
{
  "phase": 7,                          // integer, matches phase-<N> in plan.md
  "executed": 12,                      // integer ≥ 1; number of test cases the runner actually executed
  "passed":   12,                      // integer; passed == executed required
  "failed":    0,                      // integer; MUST be 0 for the phase to be unblocked
  "scenarios": [                       // raw runner output, one entry per test case
    {
      "name": "settings page persists web search toggle",
      "status": "passed",              // "passed" | "failed" | "skipped"
      "durationMs": 1840
    }
  ],
  "claims": [                          // human-meaningful behaviors this phase asserts
    {
      "id": "PHASE7-C1",               // stable id; format PHASE<N>-C<M> (1-indexed within phase)
      "type": "ui",                    // "ui" | "api" | "db"
      "surface": "/admin/settings",    // route for ui, endpoint for api ("POST /api/runs"), table for db
      "behavior": "User can enable Web Search and persist queries across reload",
      "proven_by": "web-search-settings.spec.ts::persists across reload"
    }
  ]
}
```

## Rules

- **`executed` must be > 0.** A non-executed suite does not satisfy the phase gate. Authoring a `.spec.ts` without running it = BLOCKED.
- **`failed` must be 0.** Any failure blocks the phase.
- **Every user-visible behavior introduced or modified by this phase is one claim.** Do not collapse multiple distinct behaviors into one claim ("the settings page works" is not a claim).
- **UI surfaces require a `type: "ui"` claim.** If the phase touches any file under a UI surface (`packages/web/`, `app/`, `pages/`, `frontend/`, `src/components/`), the `claims[]` array MUST contain ≥1 entry with `type: "ui"`. Missing UI claim = BLOCKED.
- **API/DB claims are corroborated by the phase tests** and do not require independent reproof downstream.
- **UI claims are NOT considered proven by this report.** Functional-verify re-runs them through Playwright MCP and must produce a screenshot per claim id. Do not over-claim — every UI claim is a downstream work item.
- **`proven_by`** points at the test that asserts the claim, in the format `<test file>::<test name>`. The reviewer must be able to grep for it.
- **`id` is stable.** Once written, do not renumber within a phase — downstream artifacts (proof-report.md) reference claim ids verbatim.

## Anti-patterns

- Omitting a UI claim because "the API claim covers it." API claims do not exercise the rendered UI.
- One mega-claim covering an entire feature ("user can use Web Search"). Split per behavior.
- Hand-writing `executed`/`passed`/`failed`. These come from the test runner's machine-readable output (e.g. Playwright JSON reporter, vitest `--reporter=json`).
- Marking a phase done while the suite still has failing scenarios.
- Treating `claims[]` as documentation. It is a worklist for the verifier.

## How orchestrate consumes this

After all phases complete, orchestrate aggregates every `phase-*-claims.json` into a single `.harness/<SPEC_NAME>/claims.json`. See `skills/orchestrate/references/claims-aggregation-format.md` for the aggregated shape and the UI-proof gate that runs after functional-verify.
