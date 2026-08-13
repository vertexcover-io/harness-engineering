# Sub-Agent Dispatch

Each sub-agent stage does one thing: **invoke its skill**. The skill carries the contract. This file
carries only what the skill cannot know — the paths, ids and ranges of *this* run.

## The rule (Invariant 6)

> Name the resolved skill. Pass the variables. Say what to return. Stop.

If you catch yourself explaining *how* a stage works — what the skill must produce, which gate it
must satisfy, what shape its report takes — that belongs in the skill, not here. Restating it
creates a second source of truth, and the copy in a prompt is the one that goes stale silently.
**If a sub-agent needs a rule no skill states, add it to the skill.**

`<SKILL:stage-id>` below means *the skill resolved for that stage* per `references/config.md`
(config override → project skill → global default) — never a hardcoded name, because a project may
have swapped it. A custom skill receives the same variables and owes the same gate contract; both
are tabled in `config.md`.

## `[PREAMBLE]` — prefix every sub-agent

```
You are working in the worktree at <WORKTREE_PATH>.
Your working directory is <WORKTREE_PATH>.

Tooling commands for this repo are in <HARNESS_DIR>/baseline.json (`commands`). Read it and use
those exact invocations — do not rediscover the runner or guess a file-filter flag. The baseline
`results` there are what "no new failures" is measured against; a suite that is already red is not
your regression.
```

Nothing else is universal. Resist adding to this block.

---

## Stage 3 — Coder

**Skill:** `<SKILL:coder>` · **Model:** `CFG.model` → `sonnet`

Dispatch one agent per phase — the phase file is the unit (one TDD cycle, one commit).

**The coder agent invokes `<SKILL:coder>` and nothing else.** That skill reaches `tdd`,
`code-quality`, and `references/coder-contracts.md` itself; naming them in the dispatch would be a
second source of truth for what the skill already owns (Invariant 6). Pass the phase file — that is
what puts the skill in pipeline mode and makes the claims artifacts mandatory.

**Its first action is invoking `<SKILL:coder>` — before any Read or Grep.** The skill and its
contracts shape the whole phase; an agent that explores first is working before it knows the rules.

**Pass:**
- Design `.harness/<SPEC_NAME>/design.md` and dossier `.harness/<SPEC_NAME>/dossier.md` (both when
  brainstorm ran), plan `.harness/<SPEC_NAME>/plan.md`, phase file
  `.harness/<SPEC_NAME>/phases/phase-<PHASE_N>.md`
- Claims report path: `.harness/<SPEC_NAME>/phase-<PHASE_N>-claims.json`
- Dashboard: `HARNESS_DIR=<HARNESS_DIR>`, `NODE_ID=<phase-node-id>`, `DAG_SCRIPT=<DAG_SCRIPT>`

**Then, verbatim — how to orient in this run:**

```
Read the map before the territory. The dossier is verbatim code quotes whose file:line pointers
are already verified: read it before any source file and go straight to the cited lines rather
than re-discovering the area by search. Explore past the map only where your phase touches code
it does not quote.

Then request every file and call site you need in a single tool call block. Extra calls in a
round are nearly free; a round is not. Orientation is done when every file the phase names has
been read — in that sweep, not one round each.
```

Skip the first paragraph when no `dossier.md` exists.

**Return:** files created/modified, test counts, phase completed or blocked (and why).

The orchestrator verifies the claims report independently — do not take the agent's word for it.

---

## Stage 5 — Verify & Finalize

**Skills, in order:** `<SKILL:functional-verify>` → `<SKILL:quality-gate>` → `<SKILL:sync-docs>` ·
**Model:** `CFG.model` → `sonnet`

Tell the agent to run them in order and stop on the first failure.

**Pass:**
- Design `.harness/<SPEC_NAME>/design.md` (when brainstorm ran), plan
  `.harness/<SPEC_NAME>/plan.md`, phase files `.harness/<SPEC_NAME>/phases/phase-*.md`
- Claims `.harness/<SPEC_NAME>/claims.json` (aggregated), verification output dir
  `.harness/<SPEC_NAME>/verification/`
- Baseline `.harness/<SPEC_NAME>/baseline.json`, harness dir
  `.harness/<SPEC_NAME>/`, stage `post-tdd`, spec name `<SPEC_NAME>`
- Artifact-publish session id: tell the agent to `export SESSION_ID=<SESSION_ID>` before running
  `<SKILL:functional-verify>`, so its publish steps target the real top-level session instead of
  deriving it from the worktree cwd (which encodes to the wrong transcript directory). If
  `<SESSION_ID>` is empty, omit this — the skill falls back to deriving.

**Return:** verification verdict, gate verdict, docs updated.

The orchestrator enforces the artifact and UI-proof contracts itself after the agent returns — a
`PASSED` without the artifacts means the gate was skipped. See SKILL.md Stage 5.

---

## What belongs in the prompt vs the skill

| Belongs in the dispatch | Belongs in the skill |
|---|---|
| `<WORKTREE_PATH>`, `<SPEC_NAME>`, `<PHASE_N>` | what a phase claims file must contain |
| `--commits <BASE_BRANCH>..HEAD` | how to review, what a verdict means |
| where to write an artifact | what the artifact must say, and its gate |
| which skill, which model | the procedure the skill performs |
| what to return | how to do the work |

A useful test: **would this sentence be true on a different run?** If yes, it is the skill's, not
the prompt's.
