# Sub-Agent Dispatch

## Contents

- [The rule (Invariant 6)](#the-rule-invariant-6)
- [`[PREAMBLE]` — prefix every sub-agent](#preamble--prefix-every-sub-agent)
- [Stage 0 — Baseline](#stage-0--baseline)
- [Stage 3 — Coder](#stage-3--coder)
- [Stage 5 — Verify & Finalize](#stage-5--verify--finalize)
- [Stage 7 — Retro](#stage-7--retro)
- [What belongs in the prompt vs the skill](#what-belongs-in-the-prompt-vs-the-skill)

Each sub-agent stage does one thing: **invoke its skill**. The skill carries the contract. This file
carries only what the skill cannot know — the paths, ids and ranges of *this* run.

## The rule (Invariant 6)

> Name the resolved skill. Pass the variables. Say what to return. Stop.

If you catch yourself explaining *how* a stage works — what the skill must produce, which gate it
must satisfy, what shape its report takes — that belongs in the skill, not here. Restating it
creates a second source of truth, and the copy in a prompt is the one that goes stale silently.
**If a sub-agent needs a rule no skill states, add it to the skill.**

`<SKILL:stage-id>` below means *the skill resolved for that stage* per `references/config.md` — never
a hardcoded name, because a project may have swapped it. A custom skill receives the same variables and owes the same gate contract; both
are tabled in `config.md`.

## `[PREAMBLE]` — prefix every sub-agent

```
You are working in the worktree at <WORKTREE_PATH>.
Your working directory is <WORKTREE_PATH>.

What this repo builds, lints and tests with is declared in orchestrate.config.json at the repo
root. Read it and use those exact invocations — do not rediscover the runner or guess a
file-filter flag. Separately, the results in <HARNESS_DIR>/baseline.json are what "no new
failures" is measured against; a suite that was already red is not your regression.
```

Nothing else is universal. Resist adding to this block.

---

## Stage 0 — Baseline

**Skill:** `pipeline-setup` (`baseline` branch) · **Model:** `sonnet` · **Dispatch:** background, then continue to Stage 1 without waiting.

The one sub-agent that does **not** take `[PREAMBLE]`: it writes `baseline.json`, so it cannot be pointed at the results in it. It reads `orchestrate.config.json` for its commands like every other stage — that is in the skill, not this prompt.

```
You are working in the worktree at <WORKTREE_PATH>.
Your working directory is <WORKTREE_PATH>.

Invoke the `pipeline-setup` skill with its `baseline` branch.
SPEC_DIR: <SPEC_DIR>
PACKAGES: <PACKAGES>
```

---

## Stage 3 — Coder

**Skill:** `<SKILL:coder>` · **Model:** `CFG.model` → `sonnet`

Dispatch one agent per phase — the phase file is the unit (one TDD cycle, one commit).

**The coder agent invokes `<SKILL:coder>` and nothing else.** That skill reaches `tdd`,
`code-quality`, and `references/coder-contracts.md` itself; naming them in the dispatch would be a
second source of truth for what the skill already owns (Invariant 6). Pass the phase file — that is
what puts the skill in pipeline mode and makes the phase e2e runner report mandatory.

**Its first action is invoking `<SKILL:coder>` — before any Read or Grep.** The skill and its
contracts shape the whole phase; an agent that explores first is working before it knows the rules.

**Pass:**
- Design record `.harness/<SPEC_NAME>/design.md` (when the full flow ran), plan
  `.harness/<SPEC_NAME>/plan.md` (extracted from plan.html), phase file
  `.harness/<SPEC_NAME>/phases/phase-<PHASE_N>.md`
- E2E runner report path: `.harness/<SPEC_NAME>/phase-<PHASE_N>-e2e.json`
- The `PACKAGES` entry this phase's work sits under, and `ENVIRONMENT` — no phase file says which
  unit or which stack it belongs to
- Dashboard: `HARNESS_DIR=<HARNESS_DIR>`, `NODE_ID=<phase-node-id>`, `DAG_SCRIPT=<DAG_SCRIPT>`

**Then, verbatim — how to orient in this run:**

```
Request every file and call site your phase file names in a single tool call block. Extra
calls in a round are nearly free; a round is not. Orientation is done when every file the
phase names has been read — in that sweep, not one round each.
```

**Return:** files created/modified, test counts, phase completed or blocked (and why).

The orchestrator parses the phase e2e runner report itself — do not take the agent's word for it.

---

## Stage 5 — Verify & Finalize

**Skills, in order:** `<SKILL:functional-verify>` → `<SKILL:quality-gate>` → `<SKILL:sync-docs>` ·
**Model:** `CFG.model` → `sonnet`

Tell the agent to run them in order and stop on the first failure.

**Pass:**
- Design record `.harness/<SPEC_NAME>/design.md` (when the full flow ran), plan
  `.harness/<SPEC_NAME>/plan.md`, phase files `.harness/<SPEC_NAME>/phases/phase-*.md`
- Phase e2e runner reports `.harness/<SPEC_NAME>/phase-*-e2e.json`, verification output dir
  `.harness/<SPEC_NAME>/verification/`
- Baseline `.harness/<SPEC_NAME>/baseline.json`, harness dir
  `.harness/<SPEC_NAME>/`, stage `post-tdd`, spec name `<SPEC_NAME>`
- `PACKAGES: <PACKAGES>`, `ENVIRONMENT: <ENVIRONMENT>`

**Return:** verification verdict, gate verdict, docs updated.

The orchestrator enforces the artifact and UI-proof contracts itself after the agent returns — a
`PASSED` without the artifacts means the gate was skipped. See SKILL.md Stage 5.

---

## Stage 7 — Retro

**Skill:** `<SKILL:harness-retro>` · **Model:** `CFG.model` → `sonnet`

Runs after the PR exists, so it sees the whole run including Stage 6.

**Pass:**
- Session id `<SESSION_ID>` and launch directory `<LAUNCH_DIR>` — the transcripts live under the
  directory the run started in, never the worktree. When `<SESSION_ID>` is empty, pass only
  `<LAUNCH_DIR>` and let the skill take that project's newest session.
- Output dir `.harness/<SPEC_NAME>/retro`, spec name `<SPEC_NAME>`, harness dir
  `.harness/<SPEC_NAME>/`
- Plugin skills root `${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/skills` — recommendations name
  files under it
- `PR: <PR_URL>`, `BRANCH: <BRANCH_NAME>`, `BASE: <BASE_BRANCH>`

**Return:** issue count, MISSED count, report path.

This stage has no gate and no verdict. See SKILL.md Stage 7.

---

## What belongs in the prompt vs the skill

| Belongs in the dispatch | Belongs in the skill |
|---|---|
| `<WORKTREE_PATH>`, `<SPEC_NAME>`, `<PHASE_N>` | what a phase e2e report must contain, and who writes it |
| `--commits <BASE_BRANCH>..HEAD` | how to review, what a verdict means |
| where to write an artifact | what the artifact must say, and its gate |
| which skill, which model | the procedure the skill performs |
| what to return | how to do the work |

A useful test: **would this sentence be true on a different run?** If yes, it is the skill's, not
the prompt's.
