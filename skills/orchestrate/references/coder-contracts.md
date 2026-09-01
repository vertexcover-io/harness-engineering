# Coder Stage Contracts

## Contents

- [Input: the phase file](#input-the-phase-file)
- [Tooling commands](#tooling-commands)
- [E2E is mandatory](#e2e-is-mandatory)
- [Report artifact (mandatory, machine-derived)](#report-artifact-mandatory-machine-derived)
- [Behavior coverage is judged at altitude](#behavior-coverage-is-judged-at-altitude)

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

**Building a screen? Open the design first.** plan.md's `## Design References` names the file
for it — that file is the spec. Match it. A screen you design yourself can pass every test and
still be the wrong screen.

**Carry the scenario's id in each test title** (`S12: …`) so a reviewer can trace it. The id
is for tracing — the rest of the title still states the claim, per the `tdd` skill.


## Tooling commands

From `orchestrate.config.json` at the repo root, plus the `packages` entry your dispatch named.
`references/config.md` owns how a key resolves and what an absent one means.

- **Iterating:** `test_file` / `lint_file`, the test path substituted for `{FILE}`.
- **Before declaring the phase done:** `test_all` / `lint`, once each.
- **E2E leg:** the package's `e2e` command.
- **Not in the config:** a check this project does not have. Skip it.

Don't restructure working tests to satisfy a strict lint rule on test files — that's the project's
lint-config concern.

---

## E2E is mandatory

**Every phase that changes production behavior gets an E2E leg** — not only UI/HTTP changes: a
backend job, a CLI command, a queue consumer all have externally-observable effects. The phase
is not done until the E2E test passes and the runner report is written.

- **Authored ≠ run.** A `.spec.ts` authored but never run is a BLOCKED phase. The report's
  counts must come from a real runner invocation, never hand-authored.
- **The environment is the first task of the phase, not a blocker.** A stack that won't start,
  an unsynced consumer build, a service that's down — bring it up with the `environments` entry
  your `ENVIRONMENT` names, else the project's testing contract (CLAUDE.md's testing/e2e
  section, a setup script). Only after that setup
  still can't run — a genuinely missing test hook, a build with no documented sync path — is
  the phase **BLOCKED, not done**: name the scenario and the concrete reason, return control.
- **Confirm the behavior under test is enabled in this environment.** If it sits behind an env
  flag or feature gate, the harness must turn it on, or the test goes green because the code
  never ran — a false pass, not a done scenario.
- **The E2E flow is given, not chosen.** The phase's `### E2E` block is the finish-line spec —
  use it verbatim. Flows in plan.md's `## Acceptance` are cross-slice: author one
  only when your phase file names it as yours to run (the slice completing the journey), and
  take its steps from the plan verbatim. Before creating a new spec file, grep the e2e
  directory for the surface (route, command, topic, selector); if one covers it, **extend
  it** — a parallel spec for the same flow is a BLOCKED condition.
- **Published library component?** Its E2E leg runs in the **consumer** repo that mounts it,
  and the consumer's installed copy must be rebuilt/synced from the worktree first — see
  `consumer-repo-e2e.md`.

### Report artifact (mandatory, machine-written)

The phase's e2e leg writes its runner's own machine output to
`.harness/<SPEC_NAME>/phase-<PHASE_N>-e2e.json` (gitignored; read by quality-gate's Check 9).
**A bare `--reporter=json` prints to stdout and writes no file** — each runner names its
destination differently:

| Runner | Invocation |
|---|---|
| Playwright | `PLAYWRIGHT_JSON_OUTPUT_NAME=<path> playwright test --reporter=json` |
| vitest | `vitest run --reporter=json --outputFile=<path>` |
| jest | `jest --json --outputFile=<path>` |

Where the project wraps its runner (an `e2e` script, a custom entry point), pass the same
env var or flag through it — the file on disk is what the gate reads, not the console output.

**Write nothing into it by hand.** The file is evidence precisely because no agent authored it:
counts, test titles and statuses all come from the run. A summary you compose yourself is a
claim, not evidence, and the pipeline has no use for it.

**Carry the scenario id in the test title** (`S12: …`, per *Input: the phase file*) — that is how
counts become traceable to scenarios without a second file to keep in sync.

**Escape hatch — use sparingly.** Skip E2E only if the phase changes *no externally-observable
behavior* (pure internal refactor, doc-only, config with no runtime effect). Migrations, new
endpoints/jobs, and any change touching the request path do NOT qualify. Write
`.harness/<SPEC_NAME>/phase-<PHASE_N>-e2e-skipped.md` naming the reason, and be ready to justify it.

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

**Runner-less producer repos.** A phase may create an artifact in a package that declares no
`test_all` — raw JSON/config or types-only. Never invent a runner there: the
proving scenario lives in the **consumer** phase that imports the artifact. Coverage of that
artifact is the consumer's scenario, not an uncovered-file gap. See `consumer-repo-e2e.md` for
the same shape one altitude up.

---

