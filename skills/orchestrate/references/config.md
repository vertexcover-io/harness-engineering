# `orchestrate.config.json`

Required, at the **repo root**, committed. Being tracked, it is present at the worktree root
too — either path reads the same content. Orchestrate reads it once during Stage 0 and passes the
result forward. A worked example lives in `references/orchestrate.config.example.json`.

One file carries three things: this project's **stage overrides**, its **commands**, and its
**environments**. It is self-describing — read it directly. Nothing here restates what its keys
mean, and a command it does not name is a command there is nothing to run for.

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
`verify-finalize` is a bundle — overriding its `skill` replaces all three sub-skills and their
contracts.

`worktree` and `commit-pr` are valid keys and resolve, but neither stage dispatches a resolved skill
yet: worktree creation runs during Initialization before this file is read, and Stage 6 hand-rolls.
An override on either is recorded and logged, not yet honoured.

## Resolution

Look the entry up by stage id; call it `CFG`. An **absent key, an empty object, and an empty string
all mean the same thing: use the default.** Then, per stage:

- **skill** = `CFG.skill` → a project skill named exactly like the default (the `Skill` tool already
  prefers project/plugin over global, so no path lookup) → global default. `CFG.skill` is a skill
  **name only**; a value with `/` is ignored (log it). Log the resolved override:
  `"Using custom skill for stage <id>: <skill-name>"`.
- **model** (sub-agent stages `baseline`/`coder`/`verify-finalize` only) = `CFG.model` → the
  dispatch block's `sonnet` default. Passed verbatim to `Agent`'s `model`. `model` on a
  main-conversation stage has no Agent to retarget — ignore it (log).
- **disabled** = every stage is mandatory, so `disabled` is always rejected
  (`"Cannot disable mandatory stage <id> — ignoring"`). Planning scales itself — its step 0 collapses
  the question loop for trivial work, and its own gate is the only route to `implement`.

## Custom skills

A custom skill is invoked with the **same arguments** the default would get (see each dispatch block
in `references/stage-prompts.md`) and, for **gated** stages, MUST emit the same verdict
markers/artifacts so orchestrate can parse the result — a missing verdict is treated as a stage
FAILURE/BLOCKED.

## When the file is missing

Stage 0 halts and tells the user to run `setup-harness`, which writes it. There is no run-time
fallback: detection would put a different toolchain behind the same spec name on the next run.
