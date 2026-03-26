# Skills Guide

This plugin gives Claude Code a set of development workflows called **skills**. You invoke them with slash commands like `/tdd` or `/orchestrate`. Some skills run automatically in the background when you're writing code — you never need to call them.

For installation and setup, see [README.md](README.md).

## Quick Start

Tell Claude what you want to build. For the full pipeline:

```
/orchestrate "Add rate limiting to the API"
```

This handles everything — design, planning, coding with tests, quality checks, docs, and a PR.

For smaller tasks, use individual skills like `/tdd`, `/code-review`, or `/git-commit`.

## Recipes

### I want to build a feature

Run `/orchestrate` with a prompt or spec file. It runs the full pipeline:

1. **Brainstorms** the problem with you and produces a design doc
2. **Plans** the implementation — breaks work into phases (you approve before coding starts)
3. **Codes** each phase using TDD with parallel sub-agents
4. **Runs quality checks** — typecheck, lint, tests, coverage
5. **Updates docs** to match the new code
6. **Captures learnings** from the run
7. **Commits and creates a PR**

All artifacts are saved to `docs/spec/<name>/` for traceability.

You can also run stages individually if you prefer more control:
`/brainstorm` → `/planning` → `/tdd` → `/quality-gate` → `/git-commit`

---

### I want to fix a bug

You don't need the full pipeline. Three skills:

1. **`/tdd`** — Write a failing test that reproduces the bug, then fix it with the RED-GREEN-REFACTOR cycle
2. **`/quality-gate`** — Verify typecheck, lint, and tests all pass (or run them yourself)
3. **`/git-commit`** — Stage and commit with a conventional message

---

### I want to review a PR

**Manual review:** Run `/code-review`. It reads the diff, checks against a plan or design doc if provided, and produces a `REVIEW.md` with a verdict: APPROVE, APPROVE WITH SUGGESTIONS, or REQUEST CHANGES.

**Automated (CI):** The `review-fixer` skill runs in GitHub Actions. When a human leaves review comments on a PR, it classifies each comment, applies fixes, runs the quality gate, commits, and replies inline on the PR.

---

### I want to audit code quality

Three standalone tools — run any of them independently:

| Command | What it finds | What it produces |
|---------|--------------|-----------------|
| `/tech-debt-finder` | Code smells, dependency issues, structural problems | Terminal report + GitHub issues |
| `/coverage-guard` | Test coverage below threshold (default 90%) | Auto-generates missing tests via `/orchestrate` if below threshold |
| `/doc-quality-guard` | Stale docs, wrong API signatures, AI slop | Fix spec → runs `/orchestrate` to fix docs |

---

### I want to commit my changes

Run `/git-commit`. It does more than `git commit`:

- Analyzes your dirty working tree
- Groups related changes into logical commits (using hunk-level staging)
- Writes conventional commit messages with proper prefixes (`feat`, `fix`, `refactor`, etc.)

---

### I want to refactor code

Use `/tdd`. Refactoring is built into the TDD cycle:

1. Write tests around the existing behavior you want to preserve
2. Make sure they pass (GREEN)
3. The `refactor` skill kicks in automatically — assesses extraction, simplification, and naming improvements
4. Tests keep you safe throughout

You don't invoke `/refactor` directly — it runs as part of the TDD workflow.

## Always-On Skills

Some skills run automatically when you're writing code — through `/tdd`, `/orchestrate`, or directly. You never invoke them:

- **code-quality** — Enforces strict types (no `any`), immutability (`readonly`), pure functions, Result types for errors, early returns over nested conditionals
- **testing** — Enforces behavior-driven test patterns, proper factories, minimal mocking — tests verify *what* not *how*
- **refactor** — Kicks in after tests pass (GREEN phase) to assess code for extraction, simplification, and naming improvements

## Extending with New Skills

Want a skill that doesn't exist yet? Search the ecosystem:

```
/find-skills "how do I do X"
```

## Skill Reference

**Slash commands you invoke:**

| Command | What it does |
|---------|-------------|
| `/orchestrate` | Full pipeline: design → plan → code → PR |
| `/brainstorm` | Deep problem exploration, produces design doc |
| `/planning` | Breaks work into phases with dependency graph |
| `/tdd` | RED-GREEN-REFACTOR development cycle |
| `/code-review` | Reviews a PR, produces verdict in REVIEW.md |
| `/git-commit` | Groups changes into logical conventional commits |
| `/tech-debt-finder` | Finds code smells, creates GitHub issues |
| `/coverage-guard` | Enforces minimum test coverage |
| `/doc-quality-guard` | Audits docs for accuracy and staleness |
| `/find-skills` | Discovers new skills from the ecosystem |
| `/skill-eval-generator` | Generates test suites for skills |

**Run automatically (no command needed):**
`code-quality` · `testing` · `refactor` · `quality-gate` · `pipeline-setup` · `spec-generation` · `sync-docs` · `learn` · `review-fixer` · `using-git-worktrees`
