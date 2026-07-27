# Tooling Detection & Baseline

How the gate detects a project's toolchain and records the starting metrics.

## Baseline capture (Stage 0)

Run at pipeline start, immediately after worktree setup, so gates can detect regressions against a
known-good starting point. Capture these metrics and write them to
`.harness/<SPEC_NAME>/baseline.json`:

```json
{
  "type_check": { "exit": 0, "errors": 0 },
  "lint": { "exit": 0, "warnings": 3 },
  "test": { "exit": 0, "passed": 42, "failed": 0, "skipped": 2 },
  "coverage": { "percent": 85.5 },
  "timestamp": "2026-03-13T..."
}
```

If a tool is not detected, record `null` for that key — do not omit it.

## Detection order

1. **CLAUDE.md** — explicit project commands (e.g. `npm run typecheck`, `make lint`) win.
2. **Project files:**
   - `package.json` → Type: `tsc --noEmit`, Lint: `eslint .`, Test: `npm test`
   - `pyproject.toml` / `setup.py` → Type: `mypy .`, Lint: `ruff check .`, Test: `pytest`
   - `go.mod` → Type: `go vet ./...`, Lint: `golangci-lint run`, Test: `go test ./...`
   - `Cargo.toml` → Type: `cargo check`, Lint: `cargo clippy`, Test: `cargo test`
3. **Coverage tool:**
   - `package.json` + vitest → `vitest --coverage`
   - `package.json` + c8/nyc → `npx c8 npm test` or `npx nyc npm test`
   - `pyproject.toml` / `setup.py` → `pytest --cov`
   - `go.mod` → `go test -cover ./...`
   - `Cargo.toml` → `cargo tarpaulin`

## Scope to changed packages (monorepos)

If `baseline.json`'s `commands.monorepo` is set (turborepo/nx), use `commands.test_changed`
(substitute `{BASE}` with `<BASE_BRANCH>`) to run typecheck/lint/test against only the **changed
packages and their dependents** — e.g. `turbo run test:unit lint typecheck --filter='...[<BASE_BRANCH>]'`.
Turbo's `...[base]` filter includes downstream dependents, so regressions in affected packages are
still caught while unchanged packages become cache hits. Single-package repos (`monorepo: null`) run
the whole project via the plain `commands`.
