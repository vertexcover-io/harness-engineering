# `orchestrate.config.json`

Required, at the **repo root**, committed. Being tracked, it is present at the worktree root
too — either path reads the same content. Orchestrate reads it once during Stage 0 and passes the
result forward. A worked example lives in `references/orchestrate.config.example.json`.

One file carries seven things: this project's **doctor**, its **stage overrides**, its **commands**, its
**environments**, its **notifier**, its **extensions**, and its **hooks**. It is self-describing — read it
directly. Nothing here restates what its keys mean, and a command it does not name is a command
there is nothing to run for.

Does NOT apply to `orchestrate` itself (no recursive override).

## Doctor

Optional, top level. One command that checks what this project's own commands rely on — tools,
credentials, datastores, layout. `skills/_shared/doctor.ts` runs it from the repo root with `--json`
appended and folds its rows into its own table, so one verdict covers both.

```json
"doctor": "bun bin/doctor.ts"
```

Expected stdout: `{ "results": [ { "name", "status": "ok" | "warn" | "fail", "optional"?, "detail"?, "fix"?: [] } ] }`.
A command that prints anything else is one row, `project-doctor`, judged by its exit code. One that
does not resolve (exit 127) is a `fail` row naming the command. Absent or `null`: no rows.

## Stage overrides

`stages` keys are **exactly** the DAG node ids created by the init block in
`references/dag-commands.md`. No other spelling resolves; log a warning and ignore an unrecognised
key rather than guessing which stage was meant.

| Stage id | Default skill | Gate contract (gated stages only) |
|----------|---------------|------------------------------------|
| `setup` | `pipeline-setup` (`setup` branch) | spec artifact directory + `manifest.json` |
| `worktree` | the project's own worktree skill, else `using-git-worktrees` | — |
| `baseline` | `pipeline-setup` (`baseline` branch) | `baseline.json` |
| `planning` | `planning` | `plan.html` + extracted `plan.md`/`phases/` (or the `implement` route) |
| `coder` | `implement` | phase `…-e2e.json` runner output (executed>0, failed=0), or a skip note |
| `code-review` | `harness:code-review` | `review/review.md`; `APPROVE` / `APPROVE WITH SUGGESTIONS` / `REQUEST CHANGES` verdict |
| `verify-finalize` | `functional-verify` + `quality-gate` + `sync-docs` | `proof-report.html`; `<!-- QG:VERDICT:PASS -->` / `BLOCKED` |
| `commit-pr` | — (Stage 6 hand-rolls the commit and PR) | PR URL |
| `retro` | `harness-retro` | — (never gates; Stage 7 cannot fail the run) |

Quality-gate-class skills also emit `<!-- QG:CHECK:N:PASS|BLOCKED -->` (N ∈ {1,2,3,4,7,9,10}).

`verify-finalize` runs three skills in sequence, so one `skill` cannot stand in for the stage — set
`skills` instead, a map from the sub-skill being replaced to its replacement. Each named replacement
inherits that sub-skill's gate contract. `skill` on this stage is ignored (log it).

```json
"verify-finalize": { "skills": { "quality-gate": "my-gate" } }
```

`worktree` and `commit-pr` are valid keys and resolve, but neither stage dispatches a resolved skill
yet: worktree creation runs during Initialization before this file is read, and Stage 6 hand-rolls.
An override on either is recorded and logged, not yet honoured.

`retro` is the one stage `disabled` is honoured on. It runs after the PR and produces no artifact
any later stage reads, so a project that does not want it sets `"retro": { "disabled": true }` and
Stage 7 is skipped. Every other stage stays mandatory.

## Resolving a stage

Look the entry up by stage id; call it `CFG`. An **absent key, an empty object, and an empty string
all mean the same thing: use the default.** Then, per stage:

- **skill** = `CFG.skill` → a project skill named exactly like the default → the default. Names in
  the table above are used **verbatim** — a default carrying a `harness:` prefix keeps it. Claude
  Code's own built-in skills share names with some of ours (`code-review` is one), a built-in wins a
  bare name, and the built-in `code-review` sets `disable-model-invocation`, so a bare name there
  hard-blocks the stage. `CFG.skill` is a skill **name only**; a value with `/` is ignored (log it).
  Log the resolved override: `"Using custom skill for stage <id>: <skill-name>"`. On `verify-finalize`, resolve each of the
  stage's three `<SKILL:…>` slots through `CFG.skills` by the slot's default name instead.
- **model** (sub-agent stages `baseline`/`coder`/`verify-finalize` only) = `CFG.model` → the
  dispatch block's `sonnet` default. Passed verbatim to `Agent`'s `model`. `model` on a
  main-conversation stage has no Agent to retarget — ignore it (log).
- **disabled** = every stage is mandatory, so `disabled` is always rejected
  (`"Cannot disable mandatory stage <id> — ignoring"`). Planning scales itself — its step 0 collapses
  the question loop for trivial work, and its own gate is the only route to `implement`.

## Commands

Every runnable command lives under a `commands` map — the root one, or a package's — and nowhere
else. `bootstrap`, `e2e` and the rest are keys in it, not siblings of it, and a command is a plain
string: whatever an e2e run needs to be up is the runner config's business, not this file's. **A
command the project lacks is omitted**, and an older config may carry it as `null` instead.

### Resolving a command

Given a key and the package the run named (`PACKAGES`, resolved in Stage 0):

1. `packages.<PKG>.commands.<key>`, then root `commands.<key>`. Stop there.
2. **Absent or `null` means this project has no such command.** Report `NOT_APPLICABLE` naming the
   package and the key. Never substitute a neighbouring key, and never go looking for a runner.
3. **Declared but unresolvable** — exit 127, a missing script — means the config is stale, not the
   code: halt/BLOCKED naming the command. A command that ran and came back red is a result.

`packages.<PKG>.path` is the working directory. `packages.<PKG>.runner` is the only tool name a
skill may hold, and only to parse that runner's output, never to build a command.

**Placeholders.** `{NAME...}` takes zero or more values, and `[...]` is a segment to include only
when the run asks for what it carries. **A `test_file` without `{FILE}` runs the whole suite** — its
caller reads the named test's line, not the exit code.

## Environments

**This project names its own stack steps.** Read the entry for the environment you are using and
run the steps it declares, resolving each as above. Where one declares no readiness step, poll its
status step instead.

## Extensions

`extensions` maps a **skill name** (not a stage id) to a repo-relative markdown doc that skill
reads and follows. Contract: `skills/_shared/extensions.md`. Each skill resolves its own entry;
orchestrate passes nothing extra. Replace a skill (`stages.<id>.skill`) for a different flow;
extend it for the same flow with project instructions.

```json
"extensions": { "planning": "harness/planning.md" }
```

## Custom skills

A custom skill is invoked with the **same arguments** the default would get (see each dispatch block
in `references/stage-prompts.md`) and, for **gated** stages, MUST emit the same verdict
markers/artifacts so orchestrate can parse the result — a missing verdict is treated as a stage
FAILURE/BLOCKED.

## Notifier

Optional. Absent, or `enabled: false`, and the pipeline sends nothing.

```json
"notifier": { "enabled": true, "provider": "slack" }
```

`provider` names one entry in the provider table in `skills/_shared/notify.ts`. No credential belongs
in this file, because it is committed — each provider reads its own keys from the environment, or
from `.env` at the main repo root.

Every event fails soft, `run-started` included: the notifier rides the pipeline as a default hook
with `required` unset, so a provider outage never halts a stage — `fire` records the failure in its
output map and the run continues. See `## Hooks` below for the entry shape that guarantee comes from.

`orchestrate/SKILL.md` owns which event fires where.

## Hooks

Optional. A `hooks` block maps **event names** to ordered arrays of hook entries. The pipeline
fires seven events — `run-started`, `stage-started`, `stage-completed`, `question-pending`,
`run-interrupted`, `run-completed`, and `artifact-created` (which carries a `kind`: `pr`,
`commit`, `plan`, `proof-report`). An eighth, `hook-failed`, is fired by the dispatcher itself
whenever a hook fails — hook it to page someone, and never fire it by hand.
`skills/_shared/hooks.ts` is the dispatcher; `orchestrate/SKILL.md` owns which event fires where.

Entries run in the order you write them, with one exception: the harness ships its own hooks and
runs them first. Today that is the Slack notifier, on the six lifecycle events and on
`hook-failed` when `notifier.enabled` is true — so a hook you declare first still runs after it.
A `hook-failed` notice mentions a person only when the hook that broke was `required`.

```json
"hooks": {
  "stage-completed": [
    { "name": "page-me", "when": { "stage": "coder", "result": "fail" },
      "cmd": "scripts/page-me.sh", "required": true }
  ],
  "artifact-created": [
    { "name": "link-pr", "when": { "kind": "pr" },
      "fn": { "module": "harness/hooks.ts", "export": "linkPr" } }
  ]
}
```

| Field | Meaning |
|---|---|
| `name` | required, unique within its event — the key the hook's output appears under |
| exactly one of `fn` / `cmd` / `prompt` | `fn` {module, export} is imported and called in-process; `cmd` is spawned with the payload JSON on stdin; `prompt` is a markdown/skill file the orchestrator executes inline |
| `when` | optional filter — `stage`, `result` (pass\|fail), `kind`; every given key must equal the fired payload's value |
| `required` | default false. A failing required hook halts the stage (`HOOK_HALT`) |
| `report` | default false. A hook's output text reaches the orchestrator only when set — or whenever the hook failed |
| `timeoutMs` | default 120000; a timeout is a failure under the `required` rule |

`fire` prints one JSON line: `status` (the verdict — `success`, `skipped`, `failure`, `halt`, or
`invalid`), `result` (why, on `halt` and `invalid`), `results` (name → {status, result}), and
`prompts` (prompt hooks for the orchestrator to execute). It exits non-zero for `invalid` alone
— a command it could not act on, rejected before any hook fired, safe to correct and send again.
A required hook's failure is `halt`: the caller pauses, and exit stays 0, because a hook is not
the stage. `references/events.md` has the table. `hooks.ts doctor` validates the block and exits
1 on any FAIL row; setup-harness runs it.

This file is committed: no secrets in hook entries — a hook reads its own keys from the
environment or `.env`, exactly like the notifier.

## When the file is missing

Stage 0 halts and tells the user to run `setup-harness`, which writes it. There is no run-time
fallback: detection would put a different toolchain behind the same spec name on the next run.
