# `orchestrate.config.json`

Required, at the **repo root**, committed. Being tracked, it is present at the worktree root
too — either path reads the same content. Orchestrate reads it once during Stage 0 and passes the
result forward. A worked example lives in `references/orchestrate.config.example.json`.

One file carries five things: this project's **stage overrides**, its **commands**, its
**environments**, its **notifier**, and its **extensions**. It is self-describing — read it
directly. Nothing here restates what its keys mean, and a command it does not name is a command
there is nothing to run for.

Does NOT apply to `orchestrate` itself (no recursive override).

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
| `code-review` | `code-review` | `review/review.md`; `APPROVE` / `APPROVE WITH SUGGESTIONS` / `REQUEST CHANGES` verdict |
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

- **skill** = `CFG.skill` → a project skill named exactly like the default (the `Skill` tool already
  prefers project/plugin over global, so no path lookup) → global default. `CFG.skill` is a skill
  **name only**; a value with `/` is ignored (log it). Log the resolved override:
  `"Using custom skill for stage <id>: <skill-name>"`. On `verify-finalize`, resolve each of the
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

`run-started` is the one strict gate: it exits non-zero, and Stage 0 halts on it. Every later event
fails soft to stderr, so a provider outage never interrupts a run.

`orchestrate/SKILL.md` owns which event fires where.

## Tracker

Optional. Absent, and every tracker call skips in one line — nothing is fetched or written.

```json
"tracker": {
  "provider": "github",
  "resolve": { "from": "branch", "pattern": "REF-\\d+" },
  "states": { "started": "open", "done": "closed" }
}
```

The bridge is `skills/_shared/tracker.ts`, invoked the same way as the notifier:

```
node --experimental-strip-types <plugin-root>/skills/_shared/tracker.ts <verb> [flags]
```

Verbs: `resolve` · `get [--ref R]` · `comment (--body S | --body-file F) [--marker M]` ·
`transition --to <lifecycle>` · `link --url <PR url> [--title T]` · `attach --file F [--name N]` ·
`event <name> [--var KEY=VALUE]...` · `doctor [--ref R]`. `--dry-run` on any verb prints what would
be sent and sends nothing. `doctor` validates the block — provider, credentials, pattern, states,
event bindings, plus one live `get` when a ref resolves — and exits 1 on any FAIL row; setup-harness
runs it after writing this block.

- **provider** names one entry in the provider table in `skills/_shared/tracker.ts`, exactly as
  `notifier.provider` names one in `notify.ts`. Credentials come from the environment or `.env` at
  the main repo root — never from this file, because it is committed. A provider declares which
  verbs it supports; an unsupported verb is a one-line skip, never an error. A missing credential
  errors naming the exact key.

  | provider | credentials | notes |
  |----------|-------------|-------|
  | `github` | `gh` CLI auth | issues only; no `attach`; states beyond open/closed degrade |
  | `asana` | `ASANA_PAT`, `ASANA_WORKSPACE_GID` | ref matches the task name; no `transition` yet |
  | `linear` | `LINEAR_API_KEY` | ref is the identifier (`ENG-123`); native PR `link`; `states` values are the team's state names |
  | `jira` | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | moves use legal transitions only — an unreachable state reports what is reachable |
- **resolve.pattern** is a regex whose first match against the current branch is the ticket ref.
  `--ref` on any call overrides it.
- **states** maps the harness's five lifecycle states — `started`, `in_review`, `verified`, `done`,
  `blocked` — onto this project's own workflow names. Skills only ever name a lifecycle state; this
  map decides what it means here. **An unmapped state means: never move the ticket for it.** The
  harness never learns a project's stage names, and a project never edits a skill to rename one.
- **markers** make writes idempotent. `--marker harness:pr-created:<spec>` stamps the comment, and a
  re-run of the same stage sees the stamp and skips instead of posting a duplicate. `link` stamps
  `harness:link:<url>` on its fallback comment automatically.

Exit discipline: reads (`resolve`, `get`) exit 1 on a miss, because the caller asked for data it did
not get. Writes are best-effort — an outage, an unmapped state, or a verb the provider lacks prints
one line and exits 0. A tracker problem never fails a run.

### Event bindings — `tracker.on`

What each pipeline moment does to the ticket is the project's call, declared as ordered action
lists keyed by event name and fired with `event <name> [--var KEY=VALUE]...`:

```json
"on": {
  "run-started": [ { "transition": "started" } ],
  "pr-created": [
    { "link": "{PR_URL}" },
    { "transition": "in_review" },
    { "comment_file": "harness/tracker/pr-comment.md" }
  ],
  "run-interrupted": [ { "transition": "blocked" }, { "run": "scripts/page-oncall.sh {TICKET}" } ]
}
```

Actions, each a one-key object, executed in order, every one best-effort:

| Action | Does |
|--------|------|
| `{ "transition": "<lifecycle>" }` | Move the ticket via the `states` map — the value is a **lifecycle** state, not a project state name. |
| `{ "link": "<url template>" }` | Native PR link where the provider has one, else a marked comment. |
| `{ "comment": "<inline template>" }` | Post a comment. |
| `{ "comment_file": "<repo-relative path>" }` | Post a markdown file as the comment body. |
| `{ "attach": "<path template>" }` | Attach a file. |
| `{ "run": "<command template>" }` | Escape hatch: run a project script with the vars substituted. |

Templates substitute `{KEY}` from `--var` plus the built-ins `{TICKET}` and `{BRANCH}`. Event
comments are stamped `harness:<event>[:<SPEC>]`, so re-running a stage never posts a duplicate.
Orchestrate fires `run-started`, `pr-created`, `run-interrupted`, and `run-completed` (see its
Tracker events table); event names are free-form, so a project skill can fire its own. An event
with no binding is a one-line skip — an empty `on` means the tracker is read and attached to, but
never written by events.

## When the file is missing

Stage 0 halts and tells the user to run `setup-harness`, which writes it. There is no run-time
fallback: detection would put a different toolchain behind the same spec name on the next run.
