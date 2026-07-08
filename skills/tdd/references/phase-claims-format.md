# Phase Claims Format

Every coder phase that runs an e2e or integration suite MUST emit a phase-claims report at:

```
.harness/runtime/<SPEC_NAME>/phase-<PHASE_N>-claims.json
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
  "e2e_run": {                         // REQUIRED. Re-verified by coder-e2e-gate hook.
    "runner": "playwright",            // "playwright" | "vitest" | "jest" | "generic"
    "report_path": ".harness/runtime/<SPEC_NAME>/phase-7-playwright.json",
    "command": "pnpm test:e2e --reporter=json",
    "started_at": "2026-05-20T18:11:02Z",
    "finished_at": "2026-05-20T18:12:43Z"
  },
  "claims": [                          // human-meaningful behaviors this phase asserts
    {
      "id": "PHASE7-C1",               // stable id; format PHASE<N>-C<M> (1-indexed within phase)
      "type": "ui",                    // "ui" | "api" | "db" | "logic"
      "surface": "/admin/settings",    // route for ui, endpoint for api ("POST /api/runs"), table for db, exported helper/module for logic ("buildOptions()")
      "behavior": "User can enable Web Search and persist queries across reload",
      "proven_by": "web-search-settings.spec.ts::persists across reload"
    }
  ]
}
```

## Rules

- **`executed` must be > 0.** A non-executed suite does not satisfy the phase gate. Authoring a `.spec.ts` without running it = BLOCKED.
- **`failed` must be 0.** Any failure blocks the phase.
- **`e2e_run.report_path` must point at the raw runner JSON on disk.** The `coder-e2e-gate` SubagentStop hook re-parses this file to derive `executed` / `passed` / `failed` independently. Hand-written counts that disagree with the runner output = BLOCKED (`E2E_COUNTS_TAMPERED`). Use the runner's machine-readable reporter (Playwright JSON reporter, vitest/jest `--reporter=json`, or a generic `{executed,passed,failed}` shape).
- **Every touched production *code* file must appear in some claim's `proven_by` — this rule is universal and not UI-specific.** It applies equally to UI components, backend routes, CLI handlers, libraries, workers, and any other source. Code extensions: `.ts .tsx .js .jsx .mjs .cjs .py .go .rs .java .kt .scala .swift .rb .c .cc .cpp .h .hpp .vue .svelte`. Config/lock/doc/env files are exempt — including an artifact created in a **runner-less producer repo** (`"test": "echo no-test"`): its `proven_by` is a test in the *consumer* repo that imports it (cross-repo match by stem is allowed). Test files (`*.spec.*`, `*.test.*`, `*_test.go`, `tests/`, `e2e/`) are not themselves required to be covered. Match is by basename or stem, so a `widget.spec.ts` covers `widget.ts`. Uncovered code file = BLOCKED (`UNCOVERED_FILES`).
- **Every user-visible behavior introduced or modified by this phase is one claim.** Do not collapse multiple distinct behaviors into one claim ("the settings page works" is not a claim).
- **Interactive UI surfaces require a `type: "ui"` claim.** If the phase touches a file under a UI surface (`packages/web/`, `app/`, `pages/`, `frontend/`, `src/components/`) **and that change is exercisable through a rendered, browser-drivable surface**, `claims[]` MUST contain ≥1 `type: "ui"` entry (functional-verify re-proves it via Playwright). A change under those paths that is proven only through **pure exported logic** — no route or interactive surface, asserted directly in a unit test (the planning skill's "assert on pure helpers, no render harness" case) — is a `type: "logic"` claim instead; it is corroborated by the phase tests and needs no downstream reproof. Do not fabricate a `type: "ui"` claim you cannot drive.
- **API/DB claims are corroborated by the phase tests** and do not require independent reproof downstream.
- **UI claims are NOT considered proven by this report.** Functional-verify re-runs them through Playwright MCP and must produce a screenshot per claim id. Do not over-claim — every UI claim is a downstream work item.
- **`proven_by`** points at the test that asserts the claim, in the format `<test file>::<test name>`. The reviewer must be able to grep for it.
- **`id` is stable.** Once written, do not renumber within a phase — downstream artifacts (proof-report.md) reference claim ids verbatim.

## Anti-patterns

- One mega-claim covering an entire feature ("user can use Web Search"). Split per behavior.
- Treating `claims[]` as documentation. It is a worklist for the verifier.
- Fabricating a `type: "ui"` claim for a change that has no browser-drivable surface — use `type: "logic"`.

## How orchestrate consumes this

After all phases complete, orchestrate aggregates every `phase-*-claims.json` into a single `.harness/runtime/<SPEC_NAME>/claims.json`. See `skills/orchestrate/references/claims-aggregation-format.md` for the aggregated shape and the UI-proof gate that runs after functional-verify.
