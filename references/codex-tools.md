# Codex compatibility guide

Harness was authored against the Claude Code vocabulary, but Codex CLI (`openai/codex`) provides native equivalents for nearly every surface. This document is the authoritative mapping.

## Tool equivalents

| Claude Code | Codex equivalent | Notes |
|---|---|---|
| `Read` | native read | Same semantics. |
| `Write` / `Edit` | `apply_patch` | Same semantics. |
| `Bash` | `shell` | Same semantics. |
| `Grep` / `Glob` | native grep / glob | Same semantics. |
| `TodoWrite` | `update_plan` | Track multi-step work. |
| `WebFetch` / `WebSearch` | `web_search` | First-party tool. Disable via `web_search = "disabled"` in `config.toml`. |
| `Skill` tool | `/skills` or `$skill-name` | Codex has a native skills concept. Skills also auto-activate from their `description` frontmatter. |
| `Agent` / `Task` (subagent dispatch) | TOML agent definitions under `.codex/agents/*.toml` (project) or `~/.codex/agents/*.toml` (user) | Codex spawns implicitly; there is no user-facing spawn/wait/close tool. Concurrency controlled by `[agents] max_threads` (default 6) and `max_depth` (default 1) in `config.toml`. |
| `subagent_type: "Explore" / "Plan" / "general-purpose"` | `.codex/agents/explore.toml`, `plan.toml`, `worker.toml` | Harness ships these; see `.codex/agents/` at the plugin root. |
| `AskUserQuestion` | inline question to the user | Plain text — no structured-choice tool. |
| `ScheduleWakeup` / `CronCreate` | not available | No scheduling primitives. |

## Plugin manifest

`.codex-plugin/plugin.json` is canonical. Recognized pointer fields:

- `skills` — path to a skills folder (e.g. `"./skills/"`)
- `hooks` — path to a hooks config (e.g. `"./hooks/hooks.json"`)
- `mcpServers` — path to a `.mcp.json`
- `apps` — path to an `.app.json`

Plugins are discovered via marketplace catalogs at:
`$REPO_ROOT/.agents/plugins/marketplace.json` → `~/.agents/plugins/marketplace.json` → legacy `.claude-plugin/marketplace.json` → the curated directory.

## AGENTS.md

`AGENTS.md` is Codex's `CLAUDE.md` equivalent. Codex builds an instruction chain in this order:

1. Global: `~/.codex/AGENTS.override.md`, else `~/.codex/AGENTS.md`.
2. Project: walks from git root down to CWD, picking up `AGENTS.override.md` then `AGENTS.md` at each level.

Files are concatenated root → leaf; later files override earlier. Byte cap: `project_doc_max_bytes` (default 32 KiB).

## Skills (native)

Codex has a real skills concept with the same `SKILL.md` + frontmatter format (`name`, `description`) used here. Discovery scopes (most → least specific):

1. `$CWD/.agents/skills`
2. `$REPO_ROOT/.agents/skills`
3. `$HOME/.agents/skills`
4. `/etc/codex/skills`
5. plugin-bundled skills (via the `skills` pointer in `plugin.json`)

Invocation: explicit `/skills` or `$skill-name`, or implicit auto-selection from the `description` field. Listings have a ~8 KB context budget — keep `description` lines tight.

## Hooks (native, with different event names)

Codex supports hooks. Config locations:

- `~/.codex/hooks.json` (user)
- `<repo>/.codex/hooks.json` (project)
- inline `[hooks]` in `config.toml`
- plugin-bundled via `hooks` pointer in `plugin.json` — **requires `[features] plugin_hooks = true`**

Events: `SessionStart`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`.

Note: Codex uses `Stop` where Claude Code uses `SessionEnd`. Harness's `hooks/hooks.json` is already mapped accordingly.

Only `type: "command"` handlers execute today; handlers receive JSON on stdin and have a `timeout_seconds` default of 600.

## Subagents

Codex subagents are defined as TOML files. Required fields: `name`, `description`, `developer_instructions`. Optional: `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`.

Global limits live under `[agents]` in `config.toml`:

```toml
[agents]
max_threads = 6
max_depth = 1
job_max_runtime_seconds = 1800
```

Harness ships three agents at `.codex/agents/` to mirror the Claude Code roles used by `orchestrate` and `doc-quality-guard`: `explore.toml`, `plan.toml`, `worker.toml`.

## MCP servers

Configured under `[mcp_servers.<name>]` in `config.toml`. STDIO uses `command`/`args`/`env`/`cwd`; streamable HTTP uses `url`/`bearer_token_env_var`/`http_headers`. Plugins can bundle MCP via the `mcpServers` pointer → `.mcp.json`.

## Permissions & sandbox

There is no `settings.json` in Codex — everything lives in `config.toml`.

- Sandbox modes: `read-only`, `workspace-write`, `danger-full-access` (profiles: `:read-only`, `:workspace`, `:danger-no-sandbox`).
- Approval policies: `on-request` | `never` | `untrusted` | granular object with `sandbox_approval`, `rules`, `mcp_elicitations`, `request_permissions`, `skill_approval`.
- Filesystem and network allowlists: `[permissions.<profile>.filesystem]` and `[permissions.<profile>.network.domains]`, selected via `default_permissions`.

A starter permissions block matching the harness allowlist is at `references/codex-config.toml`.

## Slash commands

Codex ships ~40 built-in slash commands (`/skills`, `/model`, `/diff`, `/permissions`, …). User-defined slash commands are **not officially supported** at the time of writing. Map Claude Code slash commands (`/orchestrate`, `/tdd`, …) onto skill names — Codex will auto-activate via the skill's `description`, or the user can type `$orchestrate`.

## Sources

- https://developers.openai.com/codex/plugins/build
- https://developers.openai.com/codex/hooks
- https://developers.openai.com/codex/subagents
- https://developers.openai.com/codex/skills
- https://developers.openai.com/codex/mcp
- https://developers.openai.com/codex/config-advanced
- https://developers.openai.com/codex/guides/agents-md
- https://developers.openai.com/codex/cli/features
- https://github.com/openai/codex
