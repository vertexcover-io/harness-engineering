# Coder Stage Contracts

**Read this when** executing a coder phase inside the orchestrate pipeline — the `implement` skill
sends you here the moment it is handed a phase file. It carries every pipeline-specific input,
output, and signal the coder stage owes the orchestrator. The craft — the RED-GREEN-REFACTOR loop
and the testing standard — lives in the `tdd` skill, which `implement` loads; this file is only the
wire protocol around it.

---

## Input: the phase file

**Primary input is a `phases/phase-N.md`** (from the planning skill, at
`.harness/<SPEC_NAME>/phases/`; its overview is `plan.md` one level up). Map its sections:

- `## Implementation` — the build steps to execute
- `## Test Scenarios` (`### Unit` / `### API` / `### E2E`, each `S<n>`) — the RED specs, one
  test per scenario. The scenarios are already derived and placed — do not re-decompose the
  feature.
- `## Commit` — the message to use

**Carry the scenario's id in each test title** (`S12: …`) so a reviewer can trace it. The id
is for tracing — the rest of the title still states the claim, per the `tdd` skill.


## Tooling commands

Your preamble carries a `## Tooling commands` block: use the scoped `test_file` / `lint_file`
(substitute `{FILE}`) while iterating, and run the full `test_all` / `lint` **once** each, only
to confirm green before declaring the phase done. Don't restructure working tests to satisfy a
strict lint rule on test files — that's the project's lint-config concern.

---

## E2E is mandatory and gated

**Every phase that changes production behavior gets an E2E leg** — not only UI/HTTP changes: a
backend job, a CLI command, a queue consumer all have externally-observable effects. The phase
is BLOCKED until the E2E test passes and the report artifacts are written.

- **Authored ≠ run.** `executed > 0` at the scenario's altitude is the gate — authoring a
  `.spec.ts` without running it = BLOCKED. Counts must come from a real runner invocation,
  never hand-authored.
- **The environment is the first task of the phase, not a blocker.** A stack that won't start,
  an unsynced consumer build, a service that's down — read the project's testing contract
  (CLAUDE.md's testing/e2e section, a setup script) and bring it up. Only after that setup
  still can't run — a genuinely missing test hook, a build with no documented sync path — is
  the phase **BLOCKED, not done**: name the scenario and the concrete reason, return control.
- **Confirm the behavior under test is enabled in this environment.** If it sits behind an env
  flag or feature gate, the harness must turn it on, or the test goes green because the code
  never ran — a false pass, not a done scenario.
- **The E2E flow is given, not chosen.** The phase's `### E2E` block is the finish-line spec —
  use it verbatim. Flows in plan.md's `## System Verification` are cross-slice: author one
  only when your phase file names it as yours to run (the slice completing the journey), and
  take its steps from the plan verbatim. Before creating a new spec file, grep the e2e
  directory for the surface (route, command, topic, selector); if one covers it, **extend
  it** — a parallel spec for the same flow is a BLOCKED condition.
- **Published library component?** Its E2E leg runs in the **consumer** repo that mounts it,
  and the consumer's installed copy must be rebuilt/synced from the worktree first — see
  `consumer-repo-e2e.md`.

### Report artifacts (mandatory, machine-derived)

1. **`phase-<N>-claims.json`** — see `phase-claims-format.md` for the schema and gate rules
   (`executed > 0`, `failed = 0`, per-file `proven_by` coverage, UI claims).
2. **`e2e-report.json`** at `.harness/<SPEC_NAME>/` (gitignored; consumed by
   functional-verify and quality-gate), derived from the runner's machine output:

```json
{
  "phase": "<PHASE_N>", "timestamp": "<ISO>", "passed": 0, "failed": 0,
  "coverage": [{ "scenario": "S12", "description": "<what was tested>", "verdict": "PASS" }],
  "gaps": ["<what this E2E suite did NOT test — flows skipped, edge cases not covered>"]
}
```

`gaps` is as important as `coverage` — it tells functional-verify what to target. Be honest.

**Escape hatch — use sparingly.** Skip E2E only if the phase changes *no externally-observable
behavior* (pure internal refactor, doc-only, config with no runtime effect). Migrations, new
endpoints/jobs, and any change touching the request path do NOT qualify. Write
`"not_applicable": true, "reason": "<why>"` and be ready to justify it.

---

## Behavior coverage is judged at altitude

Done = every scenario in the phase's `## Test Scenarios` was **executed by the runner and
observed to pass at its assigned altitude** (Unit / API / E2E).

- A scenario under `### API` or `### E2E` is done only when a test *at that altitude* ran
  green. "Already covered by a unit test" does **not** satisfy it — silently re-homing a
  scenario to a cheaper altitude is a **BLOCKED** condition, not a pass.
- The phase's scenario set is the test budget — no tests outside it unless you can state the
  unique bug an extra one would catch. Filler tests to move a coverage number are a defect.
- Intentionally untested (no defect-detection value): getters/setters, pass-through wrappers,
  framework behavior, generated code.

**Runner-less producer repos.** A phase may create an artifact in a repo with no test runner
(`"test": "echo no-test"` — raw JSON/config or types-only). Never invent a runner there: the
proving scenario lives in the **consumer** phase that imports the artifact. Coverage of that
artifact is the consumer's scenario, not an uncovered-file gap. See `consumer-repo-e2e.md` for
the same shape one altitude up.

---

## `LIB_SUSPECT` — library failure signal

When a test fails ≥3 times in a row with every failure's stack trace inside the *same* external
lib (error class `auth` / `schema` / `not-found` / `import-error` / `timeout`), stop retrying:
the lib, not your code, may be wrong. Emit `<!-- LIB_SUSPECT:<lib>:<error-class> -->` in your
report and return control — orchestrate re-invokes the `library-probe` skill to walk the
fallback chain. Guard against false positives: most failures are in your code, so flip only
when the lib frame is *consistently* in the stack, read the docs (context7) first, and treat a
different error on each retry as flailing, not a lib problem.
