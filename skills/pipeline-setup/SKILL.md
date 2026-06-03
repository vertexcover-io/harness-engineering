---
name: pipeline-setup
description: >
  Sets up the development pipeline environment. Creates a git worktree,
  auto-detects project tooling, runs baseline metrics (typecheck, lint, test, coverage),
  derives a spec name, and creates the spec artifact directory. Returns all environment
  variables needed by downstream pipeline stages.
argument-hint: "<TASK_CONTEXT string>"
allowed-tools: Bash, Read, Write, Glob, Grep, Skill
user-invocable: false
---

# Pipeline Setup

Prepares the environment for a development pipeline run. This skill is invoked at the start of the orchestrate pipeline (Stage 0) but can also be used standalone for any workflow that needs an isolated worktree with baseline metrics.

**Announce at start:** "Setting up pipeline environment."

---

## Input

The argument is `TASK_CONTEXT` — the resolved task prompt or spec content that describes what will be built.

---

## Steps

### 1. Create Worktree

Invoke the `using-git-worktrees` skill using the `Skill` tool. Then `cd` into the worktree.

Store: `WORKTREE_PATH`, `BRANCH_NAME`

### 2. Auto-Detect Project Tooling

Detect available tooling by checking (in order):
1. `CLAUDE.md` for any documented tooling commands — **this takes priority over defaults**
2. `package.json` → Node.js project (npm/pnpm/yarn)
3. `pyproject.toml` / `setup.py` → Python project
4. `go.mod` → Go project
5. `Cargo.toml` → Rust project

### 3. Run Baseline Metrics

Run each detected tool and record results:
- **Type checker** (tsc, mypy, etc.)
- **Linter** (eslint, ruff, etc.)
- **Test suite** (jest, pytest, go test, etc.)
- **Coverage** (from test runner output)

If a tool is not detected, record `null` for that key — do not fail on missing tooling.

### 3b. E2E Infrastructure Detection

Detect e2e test infrastructure without running anything:

1. **Compose files** — check for `compose.yml`, `docker-compose.yml`, `compose.yaml`
2. **E2E test frameworks** — scan for Playwright config (`playwright.config.*`), vitest e2e projects (vitest config with `e2e` in test include patterns), Cypress config
3. **Infra scripts** — read `package.json` (root and per-package) for scripts containing `infra`, `docker`, `compose`, `db:migrate`, `db:setup`
4. **Dev server command** — identify the command that starts the application (commonly `dev`, `start`, `serve` scripts)

Record in baseline.json alongside the other metrics:

```json
{
  "e2e": {
    "detected": true,
    "infra_up_cmd": "<script that starts backing services>",
    "infra_down_cmd": "<script that stops backing services>",
    "dev_cmd": "<script that starts the app>",
    "e2e_cmd": "<script that runs e2e tests>",
    "frameworks": ["playwright", "vitest-e2e"]
  }
}
```

If no e2e infrastructure is found, record `"e2e": { "detected": false }`. Do not fail — not every project has e2e tests.

### 3c. Classify Test Runner + Derive Scoped Commands

Downstream coders re-run tests on every RED/GREEN iteration. If they only get a whole-package
command they default to running the entire suite (slow) or guess the wrong file-filter flag. Record
the runner and a **single-file** command so each iteration stays scoped.

1. Classify the unit-test **runner** from the package's `test`/`test:unit` script (and config files):
   `vitest` | `jest` | `node-test` (`node --test`) | `pytest` | `go` | `cargo` | `unknown`.
2. Emit the runner-correct single-file syntax into `commands.test_file` (with a literal `{FILE}`
   placeholder the coder substitutes):

   | runner | `test_file` template | scoping? |
   |--------|----------------------|----------|
   | vitest | `<test_all> -- --run {FILE}` | yes |
   | jest | `<test_all> --testPathPattern={FILE}` | yes |
   | node-test | `node --test {FILE}` | yes |
   | pytest | `pytest {FILE}` | yes |
   | go | `go test ./$(dirname {FILE})/...` (scopes by package) | yes |
   | cargo | `<test_all>` (cargo filters by name, not file) | no |
   | unknown | `<test_all>` | no |

3. Derive `lint_file` the same way when the linter supports a path arg (e.g. `eslint {FILE}`,
   `ruff check {FILE}`); else `null`.

### 4. Create Spec + Harness Directories

Artifacts are split across two trees:

- `docs/spec/<SPEC_NAME>/` — committed, reviewer-facing (design.md, spec.md, plan.md, library-probe.md, learnings.md, verification/, README.md)
- `.harness/<SPEC_NAME>/` — gitignored, pipeline working state (baseline.json, manifest.json, phase-*.md, e2e-report.json, gate-report-*.md, lib-suspect-*.md, review/, probes/)

Steps:

1. Derive `SPEC_NAME` from task (slugified, e.g., `add-user-auth`)
2. Create `docs/spec/<SPEC_NAME>/` and `docs/spec/<SPEC_NAME>/verification/{screenshots,traces}/`
3. Create `.harness/<SPEC_NAME>/review/` (the DAG dashboard already creates `.harness/<SPEC_NAME>/reports/`)
4. Write baseline metrics to `.harness/<SPEC_NAME>/baseline.json`:

```json
{
  "type_check": { "exit": 0, "errors": 0 },
  "lint": { "exit": 0, "warnings": 3 },
  "test": { "exit": 0, "passed": 42, "failed": 0, "skipped": 2 },
  "coverage": { "percent": 85.5 },
  "commands": {
    "runner": "vitest",
    "monorepo": "turborepo",
    "runner_supports_file_scoping": true,
    "typecheck": "pnpm typecheck",
    "lint": "pnpm eslint .",
    "lint_file": "pnpm eslint {FILE}",
    "build": "pnpm build",
    "test_all": "pnpm vitest run",
    "test_file": "pnpm vitest run -- --run {FILE}",
    "coverage_all": "pnpm vitest run --coverage",
    "test_changed": "turbo run test:unit lint typecheck --filter='...[{BASE}]'"
  },
  "timestamp": "2026-03-13T..."
}
```

`{FILE}`/`{BASE}` are literal placeholders downstream stages substitute (test path; base ref like the
merge-base or `<BASE_BRANCH>`). Set any undetected command to `null`. When `runner_supports_file_scoping`
is false, set `test_file` equal to `test_all`. The existing `type_check`/`lint`/`test`/`coverage` result
keys are unchanged — `commands` is additive.

- **`coverage_all`** runs the suite once **with coverage** — quality-gate uses it for both its test and
  coverage checks instead of running the suite twice.
- **`monorepo` + `test_changed`** let downstream gates run only **changed packages and their dependents**
  (turbo's `...[base]` graph) rather than the whole repo; unchanged packages are cache hits. Set
  `monorepo`/`test_changed` to `null` for single-package repos, where the whole-project commands already
  cover everything.

5. Write manifest skeleton to `.harness/<SPEC_NAME>/manifest.json`:

```json
{
  "spec_name": "<SPEC_NAME>",
  "branch": "<BRANCH_NAME>",
  "worktree": "<WORKTREE_PATH>",
  "started_at": "<ISO8601>",
  "pr_number": null,
  "stages": {}
}
```

Downstream stages append `stages.<stage_name> = { started_at, completed_at, outcome }` entries.

Store: `SPEC_NAME`, `SPEC_DIR` (`docs/spec/<SPEC_NAME>/`), `HARNESS_SPEC_DIR` (`.harness/<SPEC_NAME>/`), `BASELINE_PATH`, `MANIFEST_PATH`

---

## Outputs

After completion, the following variables are available for downstream stages:

| Variable | Description |
|----------|-------------|
| `WORKTREE_PATH` | Absolute path to the git worktree |
| `BRANCH_NAME` | Name of the worktree branch |
| `SPEC_NAME` | Slugified task name |
| `SPEC_DIR` | Path to `docs/spec/<SPEC_NAME>/` (committed artifacts) |
| `HARNESS_SPEC_DIR` | Path to `.harness/<SPEC_NAME>/` (gitignored working state) |
| `BASELINE_PATH` | Path to `.harness/<SPEC_NAME>/baseline.json` |
| `MANIFEST_PATH` | Path to `.harness/<SPEC_NAME>/manifest.json` |
