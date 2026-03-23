# Harness — Claude Code Plugin

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin providing a systematic software engineering pipeline — brainstorm, plan, TDD, quality gates, code review, and full orchestration from spec to PR.

Install as a plugin (see [Installation](#installation)) or symlink into `~/.claude/` for global use.

## Structure

```
claude/
├── CLAUDE.md        # Global instructions for Claude Code
├── settings.json    # Permissions, hooks, and environment config
└── skills/          # Reusable skills that extend Claude's capabilities
    ├── brainstorm/
    ├── code-quality/
    ├── code-review/
    ├── constitution/
    ├── coverage-guard/
    ├── doc-quality-guard/
    ├── find-skills/
    ├── git-commit/
    ├── learn/
    ├── orchestrate/
    ├── pipeline-setup/
    ├── planning/
    ├── quality-gate/
    ├── refactor/
    ├── spec-generation/
    ├── sync-docs/
    ├── tdd/
    ├── tech-debt-finder/
    ├── testing/
    └── using-git-worktrees/
```

## CLAUDE.md

The global `CLAUDE.md` file provides instructions that Claude Code follows across every project. It covers:

- **Preferences** — TDD-first approach, strict TypeScript, Python type hints, functional style, no over-engineering
- **Workflow** — Explore before implementing, plan before coding, re-plan when stuck, verify with typecheck/tests/lint
- **Style** — Small focused functions, early returns over nested conditionals
- **Communication** — Ask before architectural changes, explain non-obvious decisions

## settings.json

Configures Claude Code's runtime behavior:

- **Permissions** — Pre-approved read-only tools (git, grep, find, jq, etc.) and blocked dangerous commands (sudo, `git push`)
- **Deny rules** — Prevents reading dotfiles, `~/Library`, `/etc`, and other sensitive paths
- **Hooks** — AI-powered permission reviewer for grey-area tool calls (not matched by allow/deny rules). Handles .env protection, blanket git add safety, and general security review. Caches decisions for 1 hour to avoid redundant model calls
- **Status line** — Uses [ccstatusline](https://www.npmjs.com/package/ccstatusline)
- **Plugins** — skill-creator enabled

## Skills

Skills are reusable prompt modules that give Claude Code specialized capabilities. They trigger automatically based on context or can be invoked explicitly.

| Skill | Description |
|-------|-------------|
| [brainstorm](skills/brainstorm/SKILL.md) | Structured brainstorming and design gate for deep problem understanding before implementation. Produces an approved architectural design before any code is written. |
| [code-quality](skills/code-quality/SKILL.md) | High-quality code patterns with strict types, functional programming, and immutability. Loads automatically for all implementation tasks. |
| [code-review](skills/code-review/SKILL.md) | Deep code review that hunts for subtle bugs and verifies changes against a plan/design document. Invoked explicitly with `/code-review`. |
| [constitution](skills/constitution/SKILL.md) | Inviolable rules injected into every sub-agent context. Loaded by the orchestrate skill to enforce scope discipline, verification rigor, and safe coding practices. |
| [coverage-guard](skills/coverage-guard/SKILL.md) | Enforces minimum test coverage thresholds. Generates a test gap spec and invokes orchestrate to implement missing tests when coverage falls below the required minimum. |
| [doc-quality-guard](skills/doc-quality-guard/SKILL.md) | Audits documentation accuracy and tone against the actual codebase. Detects stale, missing, or contradictory docs. |
| [find-skills](skills/find-skills/SKILL.md) | Discovers and installs agent skills from the open skills ecosystem using the Skills CLI (`npx skills`). |
| [git-commit](skills/git-commit/SKILL.md) | Analyzes dirty working trees, groups related changes into logical commits using hunk-level staging, and writes conventional commit messages (feat, fix, refactor, etc.). |
| [learn](skills/learn/SKILL.md) | Captures and persists development learnings into `CLAUDE.md` and `docs/learnings/`. Guardian of institutional knowledge — ensures insights survive beyond the current session. |
| [orchestrate](skills/orchestrate/SKILL.md) | Multi-agent pipeline orchestrator. Runs end-to-end: brainstorm, plan, TDD coding, quality gate, sync-docs, learnings, and commit/PR. |
| [pipeline-setup](skills/pipeline-setup/SKILL.md) | Sets up the development pipeline environment — git worktree, constitution loading, tooling auto-detection, baseline metrics, and spec artifact directory. |
| [planning](skills/planning/SKILL.md) | Implementation planning for features, design documents, and multi-step tasks. Bridges brainstorming and execution with structured plan documents. |
| [quality-gate](skills/quality-gate/SKILL.md) | Post-stage verification with hard pass/fail thresholds. Every claim backed by verbatim command output. Runs after TDD, refactor, and before PR. |
| [refactor](skills/refactor/SKILL.md) | Refactoring assessment and patterns. Used after tests pass (GREEN phase) or when explicitly asked. Guides what to look for and which techniques to apply. |
| [spec-generation](skills/spec-generation/SKILL.md) | Transforms an approved design doc into a structured SPEC with testable acceptance criteria using EARS format. Bridges brainstorm and planning. |
| [sync-docs](skills/sync-docs/SKILL.md) | Synchronizes documentation with code changes. Scans for stale, missing, or contradictory docs, then updates them to reflect the actual implementation. |
| [tdd](skills/tdd/SKILL.md) | Test-Driven Development workflow (RED-GREEN-REFACTOR). Loaded before writing any production code in TDD-configured projects. |
| [tech-debt-finder](skills/tech-debt-finder/SKILL.md) | Comprehensive code quality assessment — finds tech debt, code smells, and areas needing cleanup before planning a refactor or sprint. |
| [testing](skills/testing/SKILL.md) | Behavior-driven testing patterns and test-first methodology. Language-agnostic with framework-specific references. Tests verify *what* code does, not *how*. |
| [using-git-worktrees](skills/using-git-worktrees/SKILL.md) | Creates isolated git worktrees with smart directory selection and safety verification for feature work. |

## Installation

This is a Claude Code plugin. It's not yet available in the marketplace, so install it locally:

```bash
# Clone the repo
git clone https://github.com/vertexcover-io/harness-engineering.git

# Run Claude Code with the plugin loaded from this directory
claude --plugin-dir .
```

The `--plugin-dir .` flag tells Claude Code to load this directory as a plugin, making all skills available in your session.


## Inspiration

The skills and CLAUDE.md in this repo were heavily inspired by these projects:

- [obra/superpowers](https://github.com/obra/superpowers) — The primary reference for many of the skills here (TDD, code quality, planning, brainstorm, refactor, testing, and more). A comprehensive and well-thought-out skill collection that informed the structure and content of most skills in this repo.
- [coelhoxyz/claude-code-global-config](https://github.com/coelhoxyz/claude-code-global-config) — Inspired the global CLAUDE.md structure and approach to shaping Claude Code's behavior across projects.
- [abhishekray07/claude-md-templates](https://github.com/abhishekray07/claude-md-templates/blob/main/global/CLAUDE.md) — Another reference for CLAUDE.md patterns, particularly around workflow preferences and coding style directives.
- [citypaul/.dotfiles/claude](https://github.com/citypaul/.dotfiles/tree/main/claude/.claude) — A well-organized Claude Code configuration that served as a reference for the overall repo layout and settings.
