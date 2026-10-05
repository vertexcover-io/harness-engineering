<h1 align="center">Yok</h1>

<p align="center">
  <strong>Engineering discipline for AI-assisted development</strong><br>
  A Claude Code and Codex plugin that adds the engineering your AI skips — design docs before code, tests before implementation, quality gates before merging
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://github.com/vertexcover-io/harness-engineering/stargazers"><img src="https://img.shields.io/github/stars/vertexcover-io/harness-engineering?style=flat" alt="GitHub stars"></a>
  <a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Claude%20Code-Plugin-blueviolet" alt="Claude Code Plugin"></a>
  <img src="https://img.shields.io/badge/Codex-Plugin-111111" alt="Codex Plugin">
</p>

<p align="center">
  <a href="#installation"><b>Installation</b></a> &nbsp;·&nbsp;
  <a href="#the-pipeline">The Pipeline</a> &nbsp;·&nbsp;
  <a href="#recipes">Recipes</a> &nbsp;·&nbsp;
  <a href="#skill-reference">Skill Reference</a>
</p>

AI coding tools are fast. They're also reckless — no tests, no design, no verification. Code appears in seconds and breaks in production minutes later. Yok fixes this with a full pipeline where every stage has clear inputs, outputs, and pass/fail criteria:

```
Brainstorm → Plan → TDD → Quality Gate → Docs → PR
```

Run the full pipeline end-to-end, or pick individual skills for smaller tasks.

## Installation

### Claude Code

```bash
claude plugin marketplace add vertexcover-io/harness-engineering
claude plugin install yok@yok
```

This persists across sessions — the plugin loads automatically on startup. It installs the latest stable release, not whatever `main` holds: the marketplace pins a release tag. `claude plugin marketplace update main` then `claude plugin update yok@yok` moves you to the next release.

### Working on yok itself

A checkout installs a second command, `yok-dev`, that runs the TypeScript source directly, so an edit shows on the next run with no build. It sits next to the release `yok` and never replaces it.

```bash
cd packages/cli && bun link
# in ~/.zshrc, once
export PATH="$HOME/.bun/bin:$PATH"
```

`yok-dev run …` starts runs from source, and the agent sessions it starts call `yok-dev` back whenever a skill says `yok`. To open an agent by hand the same way, use `yok-dev claude` or `yok-dev codex`; Claude also loads this checkout as its plugin. A session you open with plain `claude` uses the release `yok`.

`yok-dev` keeps its runs, server and logs in `~/.yok-dev`, apart from the release's `~/.yok`, so the two never share a server. A run started by one does not show in the other's `yok view`. Set `YOK_HOME` to point either at another folder.

### Codex

Install Yok from a configured Codex marketplace:

```bash
codex plugin marketplace add vertexcover-io/harness-engineering
codex plugin add yok --marketplace yok
```

Restart Codex after installing or updating the marketplace.

If you added Yok before the Codex marketplace catalog existed and see
`plugin 'yok' was not found in marketplace 'yok'`, remove the old
snapshot and add it again:

```bash
codex plugin marketplace remove main
codex plugin marketplace add vertexcover-io/harness-engineering
codex plugin add yok --marketplace yok
```

Merge the config snippet into `~/.codex/config.toml` to set subagent concurrency and apply the yok permissions profile:

```bash
mkdir -p ~/.codex
cat references/codex-config.toml >> ~/.codex/config.toml
```

**Codex compatibility notes:**
- Skills load from `skills/` via `.codex-plugin/plugin.json` after the plugin is installed and enabled.
- Tool-name differences vs Claude Code are documented in [`references/codex-tools.md`](./references/codex-tools.md) (e.g. `TodoWrite` → `update_plan`, `Edit` → `apply_patch`, `WebSearch` → `web_search`).
- Named subagent types map to TOML agent files at `.codex/agents/` (`explore.toml`, `plan.toml`, `worker.toml`).

### Skills-only install (any agent)

The open-standard [`skills` CLI](https://github.com/vercel-labs/skills) installs Yok's skills into any supported agent — it auto-discovers `SKILL.md` and needs no manifest:

```bash
npx skills add vertexcover-io/harness-engineering --agent claude-code
npx skills add vertexcover-io/harness-engineering --agent codex
```

### Pre-releases

Users install the tag a marketplace file on `main` pins, so `main` can run ahead of any release. There are two marketplaces:

| Channel | File | Marketplace | Pins |
|---|---|---|---|
| stable | `.claude-plugin/marketplace.json` | `main` | the latest stable tag |
| pre-release | `.claude-plugin/pre-release/marketplace.json` | `yok-pre-release` | the latest tag of any kind |

**Cut a release** from GitHub: Actions → Release → Run workflow, then pick the bump and tick pre-release if you want one. The workflow bumps the version, repins the marketplaces, pushes the commit and tag to the branch you ran it on, and publishes the GitHub release. Or cut one locally and push it:

```bash
bun run release:version minor --pre-release   # 1.31.1 -> 1.32.0-rc.1
bun run release:version --pre-release         # 1.32.0-rc.1 -> 1.32.0-rc.2
bun run release:version minor                 # 1.32.0-rc.2 -> 1.32.0, the real release
git push origin main --follow-tags
```

With npm, put `--` before the arguments: `npm run release:version -- minor --pre-release`. A pre-release repins only the pre-release marketplace; a stable release repins both. Users see a new pin once it reaches `main`.

**Try a pre-release** by hand:

```bash
claude plugin marketplace add https://raw.githubusercontent.com/vertexcover-io/harness-engineering/main/.claude-plugin/pre-release/marketplace.json
claude plugin install yok@yok-pre-release
claude plugin uninstall yok@yok
```

Keep only one of `yok@yok` and `yok@yok-pre-release` installed: both load at once when both are.

## Quick Start

The `yok` CLI runs a workflow from start to finish. From this checkout:

```bash
bun install
bun run cli run task --prompt "Add rate limiting to the API"
```

`task` is a workflow yok ships in `workflows/`. A bare name runs the shipped workflow of
that name; a path, or a name ending in `.yaml` or `.yml`, runs that file from your project
(`yok run ./my-flow.yaml …`). `yok verify` and `yok doctor --workflow` take the same.

`yok run` starts the yok server, opens an agent session, and sends it the `orchestrate`
skill. The session then walks the workflow one stage at a time. `yok doctor` checks the tools,
repository and config a run needs; `yok view` opens a run's page in the browser.

For smaller tasks, use individual skills like `/tdd`, `/code-review`, or `/git-commit`.

## The Pipeline

`workflows/task.yaml` runs these stages, each one a skill under `skills/`:

```
ticket-fetcher → create-workspace → baseline → design → planning → implement
  → code-review → qa (loops back to implement until it passes) → git-commit → visual-pr
  → retro (runs after a failed stage too)
```

`ticket-fetcher` picks its provider from the ticket URL or key in the request: Linear
(`LINEAR_API_KEY`) or Asana (`ASANA_API_KEY`). A workflow can force one with
`variables: { provider: NAME }` on its ticket-fetcher node. `task.yaml`'s `doctor` checks
`LINEAR_API_KEY`; change it to `ASANA_API_KEY` for an Asana-only project.

The project's settings live in `orchestrate.config.yaml` (`version: 2`) at the repository root.
Run artifacts land in `.yok/`.

## Recipes

### I want to review a PR

Run `/code-review`. It reads the diff, reviews it across eight axes (defects, spec, security, testing, reuse, simplification, efficiency, altitude), and produces a `REVIEW.md` with a verdict: APPROVE, APPROVE WITH SUGGESTIONS, or REQUEST CHANGES. It then applies the fixes for what it found and records each one in the report.

---

### I want to commit my changes

Run `/git-commit`. It does more than `git commit`:

- Analyzes your dirty working tree
- Groups related changes into logical commits (using hunk-level staging)
- Writes conventional commit messages with proper prefixes (`feat`, `fix`, `refactor`, etc.)
- Runs start to finish without asking, then names any file it left out

---

### I want to refactor code

Use `/refactor`. It assesses your code for improvement opportunities:

1. Identifies extraction, simplification, and naming improvements
2. Applies refactoring patterns (extract method, inline temp, replace conditional with polymorphism, etc.)
3. Verifies tests still pass after each change

---

## Always-On Skills

Some skills run automatically when you're writing code — through `/tdd`, `/implement`, or directly. You never invoke them:

- **code-quality** — Enforces strict types (no `any`), immutability (`readonly`), pure functions, Result types for errors, early returns over nested conditionals
- **testing standard** — lives inside `tdd` (`references/testing.md` + `anti-patterns.md`): behavior-driven tests, factories, minimal mocking — tests verify *what* not *how*
- **refactor** — Kicks in after tests pass (GREEN phase) to assess code for extraction, simplification, and naming improvements

## Skill Reference

**Slash commands you invoke:**

| Command | What it does |
|---------|-------------|
| `orchestrate` | Walks a v2 workflow inside the session `yok run` starts (not typed by hand) |
| `/planning` | Breaks work into phases with dependency graph |
| `/adr` | Records one architecture decision in `docs/adr/`, checked by a review agent, and adds it to the index |
| `/tdd` | RED-GREEN-REFACTOR development cycle |
| `/implement` | Manual coding entry point: TDD + code-quality, review when green |
| `/code-review` | Reviews a PR, produces verdict in REVIEW.md, then applies the fixes |
| `/git-commit` | Groups changes into logical conventional commits; squashes a branch's commits first when asked |
| `/visual-pr` | Creates or updates a PR with a visual change outline and validation evidence |
| `/retro` | Audits a finished run's session transcripts and writes a ranked report of yok defects |
| `/resolve-merge-conflict` | Resolves a stopped merge or rebase, or a PR that conflicts, by recovering each side's intent |

**Run automatically (no command needed):**
`code-quality` · `refactor` · `writing-style`

## Structure

```
yok/
├── .agents/
│   └── plugins/
│       └── marketplace.json  # Codex marketplace catalog
├── .codex-plugin/
│   └── plugin.json  # Codex plugin manifest
├── .claude-plugin/
│   └── plugin.json  # Claude Code plugin manifest
├── CLAUDE.md        # Global instructions for Claude Code
├── settings.json    # Permissions, hooks, and environment config
└── skills/          # Reusable skills that extend Claude Code and Codex
    ├── adr/
    ├── baseline/
    ├── code-quality/
    ├── code-review/
    ├── create-workspace/
    ├── design/
    ├── git-commit/
    ├── retro/
    ├── implement/
    ├── orchestrate/
    ├── planning/
    ├── qa/
    ├── refactor/
    ├── resolve-merge-conflict/
    ├── tdd/
    ├── ticket-fetcher/
    ├── visual-pr/
    └── writing-style/
```

## Configuration

**CLAUDE.md / AGENTS.md** — Global instructions followed by Claude Code and Codex:
- TDD-first approach, strict TypeScript, Python type hints, functional style
- Explore before implementing, plan before coding, re-plan when stuck
- Small focused functions, early returns over nested conditionals

**.claude-plugin/plugin.json** — Claude Code plugin metadata.

**.codex-plugin/plugin.json** — Codex plugin metadata. It points Codex at the same `skills/` directory used by Claude Code.

**.agents/plugins/marketplace.json** — Codex marketplace catalog. It exposes `yok@yok` for `codex plugin add`.

**settings.json** — Claude Code runtime behavior:
- Pre-approved read-only tools (git, grep, find, jq) and denied dangerous commands
- Deny rules for dotfiles, `~/Library`, `/etc`, and other sensitive paths
- [ccstatusline](https://www.npmjs.com/package/ccstatusline) integration

## Writing extensions

Verifiers, run hooks and schema modules are TypeScript files in your project that import the SDK:

```ts
import { NonEmptyStringSchema } from "@yok/sdk";
import { z } from "zod";
```

You install neither package for yok: the binary answers both imports itself. For your editor
and `tsc`, yok writes the SDK's type files to `.yok/types/` on every `yok run`, or when
you run `yok types`. Then add one line to `tsconfig.json`, and zod for its types only:

```jsonc
{ "compilerOptions": { "paths": { "@yok/sdk": ["./.yok/types/index.d.ts"] } } }
```

```sh
bun add -d zod@VERSION   # yok types prints the exact version
```

The type files need nothing else: no `@types/bun` or `@types/node`.

## Inspiration

The skills and CLAUDE.md in this repo were heavily inspired by these projects:

- [obra/superpowers](https://github.com/obra/superpowers) — The primary reference for many of the skills here (TDD, code quality, planning, brainstorm, refactor, testing, and more). A comprehensive and well-thought-out skill collection that informed the structure and content of most skills in this repo.
- [coelhoxyz/claude-code-global-config](https://github.com/coelhoxyz/claude-code-global-config) — Inspired the global CLAUDE.md structure and approach to shaping Claude Code's behavior across projects.
- [abhishekray07/claude-md-templates](https://github.com/abhishekray07/claude-md-templates/blob/main/global/CLAUDE.md) — Another reference for CLAUDE.md patterns, particularly around workflow preferences and coding style directives.
- [citypaul/.dotfiles/claude](https://github.com/citypaul/.dotfiles/tree/main/claude/.claude) — A well-organized Claude Code configuration that served as a reference for the overall repo layout and settings.
