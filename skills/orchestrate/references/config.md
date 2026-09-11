# `orchestrate.config.json`

Required at the repo root and committed, so it is also present in the worktree.
A missing file halts with `CONFIG_MISSING` and names `setup-harness`, which writes it. There is no
run-time fallback: discovering commands instead would put a different toolchain behind the same
spec name on the next run.
See [orchestrate.config.example.json](orchestrate.config.example.json) for a worked example.

## Doctor

Optional. One command that checks what this project's own commands rely on — tools, credentials,
datastores, layout. Its rows join the harness's own checks, so one verdict covers both.

```json
"doctor": "bun bin/doctor.ts"
```

It is run from the repo root with `--json` appended, and should print
`{ "results": [ { "name", "status": "ok" | "warn" | "fail", "optional"?, "detail"?, "fix"?: [] } ] }`.
A command that prints anything else becomes a single row judged by its exit code.

## Stage overrides

`stages` keys match the node IDs in [dashboard.md](dashboard.md). Warn and ignore unknown keys.

| Stage id | Default skill | Output contract |
|---|---|---|
| `worktree` | `using-git-worktrees` | a checkout on a new branch; `WORKTREE_PATH` and `BRANCH_NAME` |
| `planning` | `planning` | plan.html + extracted plan.md/phases, or implement route |
| `coder` | `implement` | phase runner E2E report with executed > 0, failed = 0, or skip note |
| `code-review` | `harness:code-review` | review/review.md and review verdict |
| `verify` | `functional-verify` | proof-report.html and a verification verdict |
| `quality-gate` | `quality-gate` | a gate report carrying a verdict |
| `sync-docs` | `sync-docs` | the documents updated and created |
| `commit-pr` | — (the stage commits, pushes and opens the PR itself) | commits, and a PR URL or a stated reason there is none |
| `retro` | `harness-retro` | retro/report.md; never gates |

`setup` and `baseline` are valid IDs but take no override, because they are one deterministic
script: log an override without honoring it.

A skill named for `commit-pr` replaces the commit, push and PR steps, for a project that ships
differently: stacked PRs, Gerrit, a release bot.

## Resolving a stage

Read `stages.<id>`. A missing entry, `{}`, and `""` all mean the same thing: use the default.

- **Skill:** `stages.<id>.skill`, else a project skill whose name matches the default exactly,
  else the default. Names are used verbatim, `harness:` prefix included — bare `code-review`
  resolves to Claude Code's built-in, which refuses model invocation. A value containing `/` is
  ignored and logged. Log a chosen override as
  "Using custom skill for stage <id>: <skill-name>".
- **Model:** `stages.<id>.model` for the sub-agent stages `coder`, `verify`, `quality-gate` and
  `retro`, else `sonnet`,
  passed verbatim to `Agent.model`. A model on a main-conversation stage has no worker to
  retarget: log and ignore it.
- **Disabled:** only `retro` honors `disabled: true`. Otherwise log
  "Cannot disable mandatory stage <id> — ignoring".

Custom skills receive the arguments in their stage reference and owe the same artifacts/verdicts.
Missing required output is `STAGE_CONTRACT_FAILED`.

## Commands

Every runnable command is one string under a `commands` map — the root one, or a package's.
`bootstrap`, `typecheck`, `e2e` and the rest are keys **inside** that map, never siblings of it.

```json
"commands": { "typecheck": "pnpm typecheck", "test_all": "pnpm vitest run" },
"packages": {
  "api": {
    "path": "packages/api",
    "runner": "vitest",
    "commands": { "test_all": "pnpm --filter api test", "e2e": "pnpm --filter api test:e2e" }
  }
}
```

Resolve a key for the package the run named: `packages.<PKG>.commands`, then root `commands`, stop.

| What you find | Verdict |
|---|---|
| the key, with a command | run it |
| no key, or `null` | `NOT_APPLICABLE` — the project has no such command. Name the package and key; never substitute a neighbouring key or go looking for a runner |
| a command that will not run: exit 127, a missing script or binary | `CONFIG_STALE` — the config is stale, not the code. Halt, naming the command and its package |
| a command that ran and came back failing | a measurement. Record it; a red suite is a result, not a config problem |

`packages.<PKG>.path` is the directory to run in. `runner` names the tool only so its output can be
parsed — never build a command from it.

Placeholders: `{NAME}` or `{NAME...}` take one or more values, and `[...]` is a segment included
only when the run asks for what it carries. So
`scripts/stack.sh up {BRANCH} {SERVICE...} [--seed-demo]` runs as
`scripts/stack.sh up feat/auth api web` when no seed was requested.

A `test_file` carrying no `{FILE}` runs the whole suite; its caller reads the named test's result
out of the output rather than the exit code.

Bringing a stack up is the `environments` block's job, not a command's.

## Environments

**This project names its own stack steps.** Read the entry for the environment the run chose and
run the steps it declares, resolving each command as above. Where an entry declares no readiness
step, poll its status step instead.

## Extensions

`extensions` maps a **skill name** (not a stage id) to a repo-relative markdown doc that skill
reads and follows. Contract: `skills/_shared/extensions.md`. Each skill resolves its own entry;
orchestrate passes nothing extra. Replace a skill (`stages.<id>.skill`) for a different flow;
extend it for the same flow with project instructions.

```json
"extensions": { "planning": "harness/planning.md" }
```

## Env

Optional. A flat map of name to value, read by the scripts that need it.

```json
"env": { "SLACK_CHANNEL_ID": "C09XXXXXXXX", "SLACK_MEMBER_ID": "U09XXXXXXXX" }
```

Two sources only, this block first, then `.env.local` at the **main checkout** root, so a worktree
resolves the same values as the checkout it came from. A missing file is not an error, and neither
`.env` nor the process environment is read.

## Notifier

Absent `notifier`, or `enabled: false`, sends nothing. With
`{"enabled":true,"provider":"slack"}`, the provider resolves through the table in
`skills/_shared/notify.ts` and reads its keys through Env above.
The notifier is a non-required built-in hook; outages are recorded and do not halt stages.

## Hooks

`hooks` maps event names to ordered entry arrays. Which events exist, when each fires, what its
payload carries, and how to act on the result all live in [events.md](events.md).
Entries run after the built-ins, the notifier and the samskara upload. A `hook-failed` notice
mentions a person only when the failed hook was required.

```json
"hooks": {
  "artifact-created": [
    {"name":"link-pr","when":{"kind":"pr"},"fn":{"module":"harness/hooks.ts","export":"linkPr"}}
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | required, unique per event; output map key |
| exactly one of `fn` / `cmd` / `prompt` | fn imports {module, export}; cmd receives payload JSON on stdin; prompt names a Markdown/skill file executed inline |
| `when` | optional exact-match filters: stage, result (pass\|fail), kind |
| `required` | false by default; failure returns HOOK_HALT, handled by events.md |
| `report` | false by default; forward output text when set, or on failure |
| `timeoutMs` | 120000 by default; timeout is a failure |

`hooks.ts doctor` validates this block and exits 1 on FAIL; setup-harness runs it.
A cmd hook inherits the launch process environment;
the config's `env` block is not exported. Scripts needing those values read the config themselves.
