# `orchestrate.config.json`

Required, at the **repo root**, committed. Being tracked, it is present at the worktree root
too — either path reads the same content. Orchestrate reads it once during Stage 0 and passes the
result forward. A worked example lives in `references/orchestrate.config.example.json`.

One file carries four things: this project's **stage overrides**, its **commands**, its
**environments**, and its **extensions**. It is self-describing — read it directly. Nothing
here restates what its keys mean, and a command it does not name is a command there is
nothing to run for.

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
| `coder` | `implement` | phase `…-claims.json` (`executed>0`, `failed=0`) |
| `code-review` | `code-review` | `review/review.md`; `APPROVE` / `APPROVE WITH SUGGESTIONS` / `REQUEST CHANGES` verdict |
| `verify-finalize` | `functional-verify` + `quality-gate` + `sync-docs` | `proof-report.html`; `<!-- QG:VERDICT:PASS -->` / `BLOCKED` |
| `commit-pr` | — (Stage 6 hand-rolls the commit and PR) | PR URL |

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

`extensions` is a map from **skill name** to a path, relative to the repo root, of a markdown
doc that skill reads and follows:

```json
"extensions": {
  "planning": "harness/planning.md"
}
```

It is keyed by skill name, not stage id — `verify-finalize` runs three skills, and skills like
`implement` also run standalone. The contract for what an extension doc may say lives in
`skills/_shared/extensions.md`; each skill that supports one names that file as its extension
point.

Orchestrate itself does not read `extensions` — each skill resolves its own entry — so the
orchestrator passes nothing extra in dispatch prompts.

Use `stages.<id>.skill` to replace a skill when the project needs a different flow. Use
`extensions` to keep the same flow with extra project instructions.

## Custom skills

A custom skill is invoked with the **same arguments** the default would get (see each dispatch block
in `references/stage-prompts.md`) and, for **gated** stages, MUST emit the same verdict
markers/artifacts so orchestrate can parse the result — a missing verdict is treated as a stage
FAILURE/BLOCKED.

## When the file is missing

Stage 0 halts and tells the user to run `setup-harness`, which writes it. There is no run-time
fallback: detection would put a different toolchain behind the same spec name on the next run.
