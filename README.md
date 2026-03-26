# Harness — Claude Code Plugin

A [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin providing a systematic software engineering pipeline — brainstorm, plan, TDD, quality gates, code review, and full orchestration from spec to PR.

## Installation

### Option 1: Plugin marketplace (recommended)

```bash
# Clone the repo
git clone https://github.com/vertexcover-io/harness-engineering.git

# Add as a local marketplace
/plugin marketplace add ./

# Install the plugin
/plugin install harness
```

This persists across sessions — the plugin loads automatically on startup.

### Option 2: Load with `--plugin-dir`

For quick one-off usage without installing:

```bash
# Clone the repo
git clone https://github.com/vertexcover-io/harness-engineering.git

# Run Claude Code with the plugin loaded from this directory
claude --plugin-dir ./harness-engineering/agents/claude
```

## Workflows

### Orchestrate — Spec to PR in One Command

The orchestrate skill runs a full development pipeline end-to-end. Give it a prompt or a spec file and it handles the rest.

```
/orchestrate "Add rate limiting to the API endpoints"
```

**Pipeline stages:**

```
Setup → Brainstorm → Planner → Coder → Quality Gate → Sync Docs → Learnings → Commit & PR
```

| Stage | What happens |
|-------|-------------|
| **Setup** | Creates an isolated git worktree, runs baseline metrics |
| **Brainstorm** | Interactive design session — you approve the architecture before any code |
| **Planner** | Generates phased implementation plan with dependency graph |
| **Coder** | Dispatches parallel sub-agents running TDD (RED-GREEN-REFACTOR) per phase |
| **Quality Gate** | Hard pass/fail verification — typecheck, lint, tests, coverage |
| **Sync Docs** | Updates documentation to match the new code |
| **Learnings** | Captures gotchas and patterns for future sessions |
| **Commit & PR** | Creates conventional commits and opens a pull request |

Stages 0–2 (Setup, Brainstorm, Planner) run interactively so you stay in control of design decisions. Stages 3–7 run as autonomous sub-agents.

All artifacts land in `docs/spec/<name>/` — spec, plan, phase files, and quality reports.

**Live DAG Dashboard**

The pipeline launches a live dashboard that visualizes progress as a directed acyclic graph. Each node represents a stage or phase, color-coded by status (pending, running, done, failed). Click any node to see its report.

<p align="center">
  <img src="assets/dag-dashboard-overview.png" alt="DAG Dashboard — full pipeline view" width="700" />
</p>

Click any completed node to inspect its report:

<p align="center">
  <img src="assets/dag-report-brainstorm-spec.png" alt="Brainstorm & Spec report" width="400" />
  <img src="assets/dag-report-planning-context.png" alt="Planning report — context and phase graph" width="400" />
</p>

After the pipeline completes, the dashboard is finalized into a self-contained HTML file you can share or archive.

---

### Tech Debt Finder — Code Health Audit

Scans your codebase for technical debt and creates GitHub issues for what it finds.

```
/tech-debt-finder src/
```

Or scan the entire repo:

```
/tech-debt-finder full
```

**What it scans** — three parallel agents run simultaneously:

| Scanner | Looks for |
|---------|-----------|
| **Dependency & Environment** | Known CVEs, outdated packages, unused dependencies, circular imports, pinning gaps |
| **Structural & Complexity** | God modules, high cyclomatic complexity, deep nesting, layer violations, code duplication |
| **Code Patterns** | Bare except, swallowed exceptions, `Any` overuse, blocking calls in async, mutable defaults, magic numbers, dead code |

**Output:**

1. A terminal report organized by severity (Critical → High → Medium → Low)
2. GitHub issues — one parent issue linking sub-issues per category, each with code snippets and permalinks

**Suppression:** Add patterns to `.claude/harness/tech-debt-ignore.md` to suppress known findings:

```
providers/fal.py:god-module       # suppress specific rule for a file
utils.py:*                        # suppress all rules for a file
*:magic-number                    # suppress a rule everywhere
```

---

### Doc Quality Guard — Documentation Audit

Checks your docs for accuracy against the actual code and flags AI-generated tone ("slop").

```
/doc-quality-guard docs/
```

Or scan all READMEs and docs:

```
/doc-quality-guard
```

**What it catches:**

| Category | Examples |
|----------|----------|
| **Accuracy** | Wrong API signatures, removed features still documented, stale code examples, dead internal links, outdated install instructions |
| **AI slop** | "Additionally", "leverage", "seamlessly", promotional language, filler phrases, em dash overuse, chatbot tone |

Findings are classified by severity (critical → medium), then a fix spec is generated and handed off to `/orchestrate` for automated remediation.

## Structure

```
harness/
├── CLAUDE.md        # Global instructions for Claude Code
├── settings.json    # Permissions, hooks, and environment config
├── hooks/
│   └── hooks.json   # AI-powered permission reviewer and session hooks
└── skills/          # Reusable skills that extend Claude's capabilities
    ├── brainstorm/
    ├── code-quality/
    ├── code-review/
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
| [coverage-guard](skills/coverage-guard/SKILL.md) | Enforces minimum test coverage thresholds. Generates a test gap spec and invokes orchestrate to implement missing tests when coverage falls below the required minimum. |
| [doc-quality-guard](skills/doc-quality-guard/SKILL.md) | Audits documentation accuracy and tone against the actual codebase. Detects stale, missing, or contradictory docs. |
| [find-skills](skills/find-skills/SKILL.md) | Discovers and installs agent skills from the open skills ecosystem using the Skills CLI (`npx skills`). |
| [git-commit](skills/git-commit/SKILL.md) | Analyzes dirty working trees, groups related changes into logical commits using hunk-level staging, and writes conventional commit messages (feat, fix, refactor, etc.). |
| [learn](skills/learn/SKILL.md) | Captures and persists development learnings into `CLAUDE.md` and `docs/learnings/`. Guardian of institutional knowledge — ensures insights survive beyond the current session. |
| [orchestrate](skills/orchestrate/SKILL.md) | Multi-agent pipeline orchestrator. Runs end-to-end: brainstorm, plan, TDD coding, quality gate, sync-docs, learnings, and commit/PR. |
| [pipeline-setup](skills/pipeline-setup/SKILL.md) | Sets up the development pipeline environment — git worktree, tooling auto-detection, baseline metrics, and spec artifact directory. |
| [planning](skills/planning/SKILL.md) | Implementation planning for features, design documents, and multi-step tasks. Bridges brainstorming and execution with structured plan documents. |
| [quality-gate](skills/quality-gate/SKILL.md) | Post-stage verification with hard pass/fail thresholds. Every claim backed by verbatim command output. Runs after TDD, refactor, and before PR. |
| [refactor](skills/refactor/SKILL.md) | Refactoring assessment and patterns. Used after tests pass (GREEN phase) or when explicitly asked. Guides what to look for and which techniques to apply. |
| [spec-generation](skills/spec-generation/SKILL.md) | Transforms an approved design doc into a structured SPEC with testable acceptance criteria using EARS format. Bridges brainstorm and planning. |
| [sync-docs](skills/sync-docs/SKILL.md) | Synchronizes documentation with code changes. Scans for stale, missing, or contradictory docs, then updates them to reflect the actual implementation. |
| [tdd](skills/tdd/SKILL.md) | Test-Driven Development workflow (RED-GREEN-REFACTOR). Loaded before writing any production code in TDD-configured projects. |
| [tech-debt-finder](skills/tech-debt-finder/SKILL.md) | Comprehensive code quality assessment — finds tech debt, code smells, and areas needing cleanup before planning a refactor or sprint. |
| [testing](skills/testing/SKILL.md) | Behavior-driven testing patterns and test-first methodology. Language-agnostic with framework-specific references. Tests verify *what* code does, not *how*. |
| [using-git-worktrees](skills/using-git-worktrees/SKILL.md) | Creates isolated git worktrees with smart directory selection and safety verification for feature work. |

## Inspiration

The skills and CLAUDE.md in this repo were heavily inspired by these projects:

- [obra/superpowers](https://github.com/obra/superpowers) — The primary reference for many of the skills here (TDD, code quality, planning, brainstorm, refactor, testing, and more). A comprehensive and well-thought-out skill collection that informed the structure and content of most skills in this repo.
- [coelhoxyz/claude-code-global-config](https://github.com/coelhoxyz/claude-code-global-config) — Inspired the global CLAUDE.md structure and approach to shaping Claude Code's behavior across projects.
- [abhishekray07/claude-md-templates](https://github.com/abhishekray07/claude-md-templates/blob/main/global/CLAUDE.md) — Another reference for CLAUDE.md patterns, particularly around workflow preferences and coding style directives.
- [citypaul/.dotfiles/claude](https://github.com/citypaul/.dotfiles/tree/main/claude/.claude) — A well-organized Claude Code configuration that served as a reference for the overall repo layout and settings.
