# Per-stage Config: `orchestrate.config.json`

Optional file at the **repo root**, read once during Stage 0. Its `stages` map keys each stage to
`{ skill?, model?, disabled? }` — every field independent. Keys are stage IDs (`coder`) or the
stage's default skill name (`implement`) — both resolve the same stage. A worked example lives in
`references/orchestrate.config.example.json`.

```json
{
  "stages": {
    "brainstorm":      { "skill": "my-brainstorm" },
    "coder":           { "skill": "my-implement", "model": "opus" },
    "code-review":     { "model": "opus" },
    "quality-gate":    { "skill": "my-quality-gate" },
    "planning":        { "skill": "my-planning" },
    "verify-finalize": { "model": "haiku" }
  }
}
```

Look the entry up by stage ID, then by default skill name; call the match `CFG`. Then, per stage:

- **skill** = `CFG.skill` → a project skill named exactly like the default (the `Skill` tool already
  prefers project/plugin over global, so no path lookup) → global default. `CFG.skill` is a skill
  **name only**; a value with `/` is ignored (log it). Log the resolved override:
  `"Using custom skill for stage <id>: <skill-name>"`.
- **model** (sub-agent stages `coder`/`code-review`/`verify-finalize` only) = `CFG.model` → the
  dispatch block's `sonnet` default. Passed verbatim to `Agent`'s `model`. `model` on a
  main-conversation stage has no Agent to retarget — ignore it (log).
- **disabled** = `CFG.disabled === true` skips the stage, exactly like a caller "skip <stage>" (DAG
  node → `skipped`, "Handling Skipped Stages" applies). Honored ONLY for the **Skippable Stage**
  (`brainstorm`); on any **Mandatory** stage it is rejected
  (`"Cannot disable mandatory stage <id> — ignoring"`). Planning is mandatory — its own
  "is a plan warranted?" gate (inside the skill, after recon) is the only route to `implement`.

Does NOT apply to `orchestrate` itself (no recursive override).

## Stages, default skills, and gate contracts

A custom skill is invoked with the **same arguments** the default would get (see each dispatch block
in `references/stage-prompts.md`) and, for **gated** stages, MUST emit the same verdict
markers/artifacts so orchestrate can parse the result — a missing verdict is treated as a stage
FAILURE/BLOCKED.

| Stage ID | Default skill | Gate contract (gated stages only) |
|----------|---------------|------------------------------------|
| `setup` | `pipeline-setup` | `baseline.json`, `relevant-lessons.md` (`ROUTED_LESSONS`) |
| `brainstorm` | `brainstorm` | — |
| `library-probe` | `library-probe` | `<!-- LP:VERDICT:PASS -->` / `BLOCKED` |
| `planning` | `planning` | — |
| `coder` | `implement` | phase `…-claims.json` (`executed>0`, `failed=0`) |
| `code-review` | `code-review` | `APPROVE` / `APPROVE WITH SUGGESTIONS` / `REQUEST CHANGES` verdict |
| `verify-finalize` | `functional-verify` + `quality-gate` + `sync-docs` + `learn` | `proof-report.html`; `<!-- QG:VERDICT:PASS -->` / `BLOCKED` |

Quality-gate-class skills also emit `<!-- QG:CHECK:N:PASS|BLOCKED -->` (N ∈ {1,2,3,4,6,7,9,10}).
`verify-finalize` is a bundle — overriding its `skill` replaces all four sub-skills and their
contracts; override `quality-gate` (etc.) to swap just one.

Worktree creation is not in this table: it runs during Initialization, before this file is read. It
takes the project's own worktree skill when there is one, and `using-git-worktrees` otherwise.
