---
name: pipeline-setup
description: >
  Sets up the development pipeline environment. Creates a git worktree, loads the constitution,
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

### 2. Load Constitution

1. Read `agents/claude/skills/constitution/SKILL.md` from the **main repository** (not the worktree)
2. Extract the content after the frontmatter (everything after the second `---`)
3. Store as `CONSTITUTION`

### 3. Auto-Detect Project Tooling

Detect available tooling by checking (in order):
1. `CLAUDE.md` for any documented tooling commands — **this takes priority over defaults**
2. `package.json` → Node.js project (npm/pnpm/yarn)
3. `pyproject.toml` / `setup.py` → Python project
4. `go.mod` → Go project
5. `Cargo.toml` → Rust project

### 4. Run Baseline Metrics

Run each detected tool and record results:
- **Type checker** (tsc, mypy, etc.)
- **Linter** (eslint, ruff, etc.)
- **Test suite** (jest, pytest, go test, etc.)
- **Coverage** (from test runner output)

If a tool is not detected, record `null` for that key — do not fail on missing tooling.

### 5. Create Spec Directory

1. Derive `SPEC_NAME` from task (slugified, e.g., `add-user-auth`)
2. Create `docs/spec/<SPEC_NAME>/` directory
3. Write baseline metrics to `docs/spec/<SPEC_NAME>/baseline.json`:

```json
{
  "type_check": { "exit": 0, "errors": 0 },
  "lint": { "exit": 0, "warnings": 3 },
  "test": { "exit": 0, "passed": 42, "failed": 0, "skipped": 2 },
  "coverage": { "percent": 85.5 },
  "timestamp": "2026-03-13T..."
}
```

Store: `SPEC_NAME`, `SPEC_DIR`, `BASELINE_PATH` (path to baseline.json)

---

## Outputs

After completion, the following variables are available for downstream stages:

| Variable | Description |
|----------|-------------|
| `WORKTREE_PATH` | Absolute path to the git worktree |
| `BRANCH_NAME` | Name of the worktree branch |
| `CONSTITUTION` | Constitution content for sub-agent preambles |
| `SPEC_NAME` | Slugified task name |
| `SPEC_DIR` | Path to `docs/spec/<SPEC_NAME>/` |
| `BASELINE_PATH` | Path to `baseline.json` |
