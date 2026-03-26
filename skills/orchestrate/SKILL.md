---
name: orchestrate
description: >
  Multi-agent pipeline orchestrator. Takes a prompt or spec file and runs:
  brainstorm (interactive), planner (interactive), coder (sub-agent with
  TDD + stagnation detection), quality gate, sync-docs, capture learnings, and commit/PR. Artifacts stored in
  docs/spec/<name>/. Use when the user says orchestrate, run the pipeline, full workflow,
  or wants end-to-end development from spec to PR.
  Supports --auto mode for CI/CD pipelines — bypasses interactive approval gates while still producing all artifacts.
argument-hint: "<prompt or path/to/spec.md> [--auto]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
---

# Orchestrate: Multi-Agent Development Pipeline

Runs a full development pipeline in 8 stages. Brainstorm and Planner run interactively in the main conversation. All other stages are dispatched as sub-agents via the `Agent` tool.

**Announce at start:** "Using the orchestrate skill to run the full development pipeline."

**CRITICAL: Do NOT explore the codebase, read project files, or fetch URLs before completing the Initialization steps below. The very first actions are: detect input, check for auto mode, then start the dashboard. No exceptions.**

**CRITICAL: Do NOT stop, pause, or present a summary until ALL pipeline stages (0-7) have completed or a stage has explicitly failed/blocked. Each stage flows directly into the next. The only permitted pause is the plan approval gate after Stage 2.**

---

## Initialization (do these first, in order, before anything else)

### Step 1: Input Detection

The argument is either an **inline prompt** or a **spec file path**.

1. Check if the argument contains `--auto`. If present, set `AUTO_MODE=true` and strip `--auto` from the argument.
2. Check if the remaining argument is a path to an existing file (use `Bash` to test with `[ -f "<arg>" ]`)
3. If file exists → read its contents as the task spec
4. If not a file → treat the argument as an inline task prompt
5. Store the resolved input as `TASK_CONTEXT` — this is passed to every stage.

When `AUTO_MODE=true`:
- **Skip all AskUserQuestion calls** — Claude decides autonomously, auto-approves designs and plans
- **Skip worktree creation** — use current working directory (e.g., GitHub Actions already checked out the PR branch)
- **Skip all `dag-update` calls** — no live dashboard in CI
- **Skip PR creation in Stage 7** — only commit and push; caller handles PR interaction
- **All artifacts still produced** (design docs, specs, plans) for auditability

### Step 2: DAG Dashboard Bootstrap

The dashboard script path is: !`echo "${CLAUDE_PLUGIN_ROOT}/skills/orchestrate/dashboard/dag-update.sh"`
Store the path above as `DAG_SCRIPT`. All Bash calls below use this resolved path.

Start the dashboard immediately. Do NOT read files, explore the codebase, or invoke any Skill or Agent before this.

1. Generate a spec name from the task prompt: lowercase, replace spaces with hyphens, truncate to 30 chars. Example: `"Add user auth system"` → `"add-user-auth-system"`
2. Initialize the DAG and start the dashboard:
   ```
   Bash("
     export HARNESS_DIR=$(/usr/bin/env bash '<DAG_SCRIPT>' init '<SPEC_NAME>' '<TASK_CONTEXT summary>' unknown unknown)
     DU='/usr/bin/env bash <DAG_SCRIPT>'
     $DU add-node setup 'Setup'
     $DU add-node worktree 'Create Worktree' --parent setup
     $DU add-node baseline 'Baseline Metrics' --parent setup --depends-on worktree
     $DU add-node brainstorm 'Brainstorm & Spec' --depends-on setup
     $DU add-node planning 'Planning' --depends-on brainstorm
     $DU add-node coder 'Coder' --depends-on planning
     $DU add-node quality-gate 'Quality Gate' --depends-on coder
     $DU add-node docs 'Sync Docs' --depends-on quality-gate
     $DU add-node learnings 'Capture Learnings' --depends-on quality-gate
     $DU add-node commit-pr 'Commit & PR' --depends-on docs,learnings
     $DU serve
   ")
   ```
   Note: Phase nodes are added as children of `coder` after planning (Stage 2) when phases are known.
3. Store `HARNESS_DIR` for use in all subsequent `dag-update` calls.

**IMPORTANT: Shell state does not persist between Bash tool calls.** Every `Bash(...)` call that uses `dag-update` must re-export `HARNESS_DIR` and re-define `DU` with the resolved `DAG_SCRIPT` path. Use this pattern for ALL dag-update calls throughout the pipeline:
```
Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU <command> <args>")
```

---

## Pipeline Stages

| # | Stage | Execution | Output |
|---|-------|-----------|--------|
| 0 | Setup | **Main conversation** | Worktree path, baseline metrics, spec directory |
| 1 | Brainstorm + Spec | **Main conversation** | `docs/spec/<name>/spec.md` |
| 2 | Planner | **Main conversation** | `docs/spec/<name>/plan.md` + `phase-*.md` |
| 3 | Coder | Sub-agent (parallelizable) | Implementation + tests |
| 4 | Quality Gate | Sub-agent | PASS/BLOCKED verdict |
| 5 | Sync Docs | Sub-agent | Updated/created docs list |
| 6 | Capture Learnings | Sub-agent | `docs/solutions/<category>/<learning>.md` |
| 7 | Commit & PR | Sub-agent | Commits + PR URL |

---

## Stage Skip Rules

After resolving the input (TASK_CONTEXT), determine which stages to skip **before** starting execution. Stages not listed here are **never skippable** — they run unconditionally every time.

### Skip Decision Logic

```
For each skippable stage:
  1. If input EXPLICITLY says "skip <stage>" → skip unconditionally (trust the caller)
  2. Else if a spec/context file is provided → read it and evaluate:
     - Is the problem clearly defined with specific scope?
     - Are the files/changes to make listed explicitly?
     - Are acceptance criteria present?
     → If ALL yes → skip (the stage would add no value)
     → If ANY no → run the stage to fill the gaps
  3. Else (bare prompt, no spec) → always run the stage
```

### Skippable Stages

| Stage | Skip condition |
|-------|---------------|
| 1: Brainstorm + Spec | Explicit skip instruction from caller, OR agent evaluates input has complete context (clear problem definition, specific scope, acceptance criteria) |
| 2: Planner | Explicit skip instruction from caller, OR agent evaluates task is straightforward enough (single-phase work, per-file instructions already provided) |
| 5: Sync Docs | Explicit skip instruction from caller, OR the task itself is documentation fixes |

### Mandatory Stages (never skip)

| Stage | Why |
|-------|-----|
| 0: Setup | Worktree and baseline are always required |
| 3: Coder | Core implementation — the whole point of the pipeline |
| 4: Quality Gate | Hard verification gate — no exceptions |
| 6: Capture Learnings | Always runs (agent skips internally if nothing to capture) |
| 7: Commit & PR | Always runs to finalize work |

### Handling Skipped Stages

For each skipped stage:
1. Set its DAG status to `skipped` (using the full `export HARNESS_DIR=... && DU=...` preamble pattern)
2. Log: "Skipping Stage N (<name>) — <reason>"
3. Proceed to the next stage in order

**Even when stages are skipped, all mandatory stages MUST execute in order.** Skipping brainstorm does not skip setup. Skipping planning does not skip coder, quality gate, or commit.

---

## Execution Rules

### HARD RULE: Questions and Approvals

**Every question to the user MUST use the `AskUserQuestion` tool — never output questions as plain text.** In auto mode, skip all `AskUserQuestion` calls entirely.

**Single approval gate:** The only approval gate in the pipeline is after Stage 2 (Planner). Present the plan and wait for user approval before proceeding to Stage 3. All other stages flow without approval gates.

**Waiting status:** A PreToolUse/PostToolUse hook automatically sets the current running node to `waiting` (purple) before any `AskUserQuestion` call, and back to `running` after the user responds. No manual dag-update calls needed for this.

### Sub-Agent Prompt Preamble

Every sub-agent prompt MUST start with this preamble (referred to as `[PREAMBLE]` in stage templates below):

```
You are working in the worktree at <WORKTREE_PATH>.
Your working directory is <WORKTREE_PATH>.
```

### Stages 0-2 Run in Main Conversation

Stages 0 (Setup), 1 (Brainstorm + Spec), and 2 (Planner) run directly in the main conversation — NOT as sub-agents.

- **Stage 0** runs in main so we can `cd` into the worktree and set the working directory for everything that follows.
- **Stage 1** runs in main because brainstorm needs conversation context and flows into spec generation.
- **Stage 2** runs in main because the planner explores the codebase interactively and holds the only approval gate.

Invoke their respective skills directly using the `Skill` tool. All other stages (3-7) run as sub-agents via the `Agent` tool.

### Pipeline Flow

```dot
digraph pipeline {
  rankdir=LR
  node [shape=box]

  stage_0 [label="0: Setup"]
  stage_1 [label="1: Brainstorm"]
  stage_2 [label="2: Planner"]
  stage_3 [label="3: Coder"]
  stage_4 [label="4: Quality Gate"]
  stage_5 [label="5: Sync Docs"]
  stage_6 [label="6: Learnings"]
  stage_7 [label="7: Commit & PR"]

  stage_0 -> stage_1 -> stage_2 -> stage_3
  stage_3 -> stage_4 -> stage_5 -> stage_6 -> stage_7
}
```

Stage 3 (Coder) is the only stage with internal parallelism — see "Parallel When Possible" below.

### Parallel When Possible

After Stage 2, read the **phase graph** from plan.md (DOT digraph) and dispatch in waves:

**Phase waves:** Compute **ready nodes** = phases with no incomplete predecessors. Dispatch all ready phases in parallel. After each wave completes, recompute → dispatch next wave.

**Per phase, choose ONE strategy:**
- **Has step graph** in `phase-N.md` → dispatch steps in waves (same ready-node logic), skip phase-level agent
- **No step graph** → single agent for the whole phase

**To parallelize:** Send multiple `Agent` tool calls in a single message.

---

## Sub-Agent Dispatch

### Stage 0: Setup (Main Conversation)

**Worktree sub-step:**
1. Run this Bash command FIRST, before invoking any skill:
   ```
   Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU set-status setup running && $DU set-status worktree running")
   ```
2. Invoke the `using-git-worktrees` skill using the `Skill` tool to create the worktree
3. `cd` into the worktree. Store: `WORKTREE_PATH`, `BRANCH_NAME`
4. Run immediately after worktree is ready:
   ```
   Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU write-report worktree '# Worktree\n- **Path:** <WORKTREE_PATH>\n- **Branch:** <BRANCH_NAME>' && $DU set-status worktree done")
   ```

**Baseline sub-step:**
5. Run before starting baseline work:
   ```
   Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU set-status baseline running")
   ```
6. Derive `SPEC_NAME` from task (slugified, e.g., `add-user-auth`). Create `docs/spec/<SPEC_NAME>/` directory.
7. Auto-detect project tooling: check `CLAUDE.md` first, then `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`
8. Run baseline metrics (typecheck, lint, test, coverage) and write results to `docs/spec/<SPEC_NAME>/baseline.json`
9. Store: `SPEC_NAME`, `SPEC_DIR`, `BASELINE_PATH`
10. Run after baseline completes:
    ```
    Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU write-report baseline '# Baseline Metrics\n- **Spec:** <SPEC_NAME> → <SPEC_DIR>\n- **Baseline:** <BASELINE_PATH>' && $DU set-status baseline done && $DU set-status setup done")
    ```

### Stage 1: Brainstorm (Main Conversation)

1. ```
   Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU set-status brainstorm running")
   ```
2. Invoke the `brainstorm` skill using the `Skill` tool — no approval gate here, design flows straight through
3. Invoke the `spec-generation` skill (still in main session — it's quick and needs the brainstorm context)
4. Move/save spec output to `docs/spec/<SPEC_NAME>/spec.md`
5. Store `SPEC_PATH`
6. Copy design doc and spec into dashboard reports, set artifacts, and mark done:
   ```
   Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && \
     cp docs/plans/YYYY-MM-DD-<topic>-design.md $HARNESS_DIR/reports/design.md && \
     $DU set-artifact brainstorm report reports/design.md; \
     cp docs/spec/<SPEC_NAME>/spec.md $HARNESS_DIR/reports/spec.md && \
     $DU set-artifact brainstorm phases reports/spec.md; \
     [ -f \"$HARNESS_DIR/reports/design.md\" ] && [ -f \"$HARNESS_DIR/reports/spec.md\" ] && \
     $DU set-artifact brainstorm tabs-title 'Brainstorm Artifacts'; \
     $DU set-status brainstorm done")
   ```

Then continue to Stage 2.

### Stage 2: Planner (Main Conversation)

1. ```
   Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU set-status planning running")
   ```
2. Read the design doc (`docs/plans/YYYY-MM-DD-<topic>-design.md`) and spec (`docs/spec/<SPEC_NAME>/spec.md`) so the planner has full context from the brainstorm stage
3. Invoke the `planning` skill using the `Skill` tool, referencing both files
4. The planner explores the codebase deeply, asks the user implementation questions interactively, then designs phases
5. **APPROVAL GATE:** Use `AskUserQuestion` to present the plan summary and wait for user approval. The `waiting` status is set automatically by the PreToolUse hook — no manual dag-update needed.
6. Plan output is in `docs/spec/<SPEC_NAME>/plan.md` + `phase-*.md`
7. Store `PLAN_DIR`
8. Copy plan and phase files into dashboard reports, add phase nodes, and mark done:
   ```
   Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && \
     cp docs/spec/<SPEC_NAME>/plan.md $HARNESS_DIR/reports/planning-report.md && \
     $DU set-artifact planning report reports/planning-report.md; \
     PHASE_REPORTS=''; \
     for f in docs/spec/<SPEC_NAME>/phase-*.md; do \
       if cp \"\$f\" \"$HARNESS_DIR/reports/\$(basename \"\$f\")\"; then \
         [ -n \"\$PHASE_REPORTS\" ] && PHASE_REPORTS=\"\$PHASE_REPORTS,\"; \
         PHASE_REPORTS=\"\${PHASE_REPORTS}reports/\$(basename \"\$f\")\"; \
       fi; \
     done; \
     [ -n \"\$PHASE_REPORTS\" ] && \
       $DU set-artifact planning phases \"\$PHASE_REPORTS\" && \
       $DU set-artifact planning tabs-title 'Phase Details'; \
     $DU set-status planning done")
   ```

**Extract:** `PLAN_DIR`, phase graph (DOT from plan.md), phase count

**Add phase nodes as children of coder and link their report artifacts:**
```
Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && \
  $DU add-node phase-1 'Phase 1: <label>' --parent coder && \
  $DU add-node phase-2 'Phase 2: <label>' --parent coder --depends-on phase-1 && \
  # ... for each phase from the plan
  [ -f \"$HARNESS_DIR/reports/phase-1.md\" ] && $DU set-artifact phase-1 report reports/phase-1.md; \
  [ -f \"$HARNESS_DIR/reports/phase-2.md\" ] && $DU set-artifact phase-2 report reports/phase-2.md")
  # ... for each phase
```

Then continue to Stage 3 as sub-agents.

### Stage 3: Coder

Dispatch based on phase and step dependency graphs. Two-level parallelism:

**Phase level:** Parse the phase graph from plan.md. Dispatch all ready nodes (no incomplete predecessors) in parallel. After each wave, recompute and dispatch next wave.

**Step level:** For each phase, read `phase-N.md` for a step graph. If present, apply the same wave-based dispatch. If absent, single agent for the whole phase.

For each phase, choose **one** dispatch strategy:

Before dispatching any phase agents:
```
Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU set-status coder running")
```
Before each phase: `$DU set-status <phase-node> running` (include full `export HARNESS_DIR=... && DU=...` preamble)
After each phase returns: `$DU set-status <phase-node> done` (or `failed`) (include full preamble)
After all phases complete: `$DU set-status coder done` (include full preamble)

**A) Phase has no Steps section** → single agent for the whole phase:

```
Agent(prompt="
  [PREAMBLE]
  Invoke the tdd skill.
  Spec: <SPEC_PATH>. Plan: docs/spec/<SPEC_NAME>/plan.md. Phase: <PHASE_N>

  Dashboard updates (use these to register sub-tasks and report progress):
    export HARNESS_DIR='<HARNESS_DIR>' NODE_ID='<phase-node-id>'
    DU='/usr/bin/env bash <DAG_SCRIPT>'
    # Register sub-tasks as you discover them (phases are children of coder):
    $DU add-node '$NODE_ID.task-1' '<label>' --parent '$NODE_ID'
    $DU set-status '$NODE_ID.task-1' running
    # When done with the phase, write a detailed report using this format:
    $DU write-report '$NODE_ID' '# Phase N: <name>

## Summary
2-3 sentences on what was accomplished.

## Files Changed
- `path/to/file.ts` — created/modified (what changed)

## Tests
- X tests added, all passing
- Coverage: X%

## Key Decisions
- Decision and reasoning

## Issues Encountered
- Issue and resolution (or "None")'

  Return: files created/modified, tests with pass/fail and REQ/EDGE coverage, phase completed or blocked.
")
```

**B) Phase has Steps section** → dispatch per-step, parallelizing independent steps:

```
Agent(prompt="
  [PREAMBLE]
  Invoke the tdd and testing skill.
  Spec: <SPEC_PATH>. Plan: docs/spec/<SPEC_NAME>/plan.md.
  Phase: <PHASE_N>. Step: <STEP_DETAILS>
  Scope: Only implement and test what this step describes. Do not touch files outside this step's scope.
  Return: files created/modified, tests with pass/fail, step completed or blocked.
")
```

Dispatch in waves: send all independent steps in parallel → wait for completion → dispatch next wave of steps whose dependencies are satisfied → repeat until all steps in the phase are done.

### Stage 4: Quality Gate

Before dispatching: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU set-status quality-gate running")`

```
Agent(prompt="
  [PREAMBLE]
  Invoke the quality-gate skill.
  Baseline file: docs/spec/<SPEC_NAME>/baseline.json
  Plan dir: docs/spec/<SPEC_NAME>/
  Stage: post-tdd

  When done, write a report using this format:
    export HARNESS_DIR='<HARNESS_DIR>'
    /usr/bin/env bash '<DAG_SCRIPT>' write-report quality-gate '# Quality Gate

## Verdict: PASS/BLOCKED/STAGNATION

## Metrics Comparison
| Metric | Baseline | Current | Status |
|--------|----------|---------|--------|
| Type check | 0 errors | X errors | PASS/FAIL |
| Lint | X warnings | Y warnings | PASS/FAIL |
| Tests | X passed | Y passed | PASS/FAIL |
| Coverage | X% | Y% | PASS/FAIL |

## Failures
- Details of any failures (or "None")'

  Return: gate report path, verdict (PASS/BLOCKED/STAGNATION).
")
```

**Extract from result:** verdict (PASS/BLOCKED/STAGNATION), gate report path

**If BLOCKED → stop pipeline and report what failed and potential ways to solve it. Do not proceed to Stage 5.**

**If STAGNATION → stop pipeline entirely. Do not retry. Report which check stagnated and the repeated error. This signals a fundamental issue that retrying won't fix.**

### Stage 5: Sync Docs

Before dispatching: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU set-status docs running")`

```
Agent(prompt="
  [PREAMBLE]
  Invoke the sync-docs skill.
  Spec dir: docs/spec/<SPEC_NAME>/
  Plan dir: docs/spec/<SPEC_NAME>/

  When done, write a report using this format:
    export HARNESS_DIR='<HARNESS_DIR>'
    /usr/bin/env bash '<DAG_SCRIPT>' write-report docs '# Sync Docs

## Documents Updated
- `path/to/doc.md` — what changed

## Documents Created
- `path/to/new-doc.md` — what it covers'

  Return: list of docs updated/created.
")
```

**Extract from result:** list of docs updated/created

### Stage 6: Capture Learnings

Before dispatching: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU set-status learnings running")`

```
Agent(prompt="
  [PREAMBLE]
  Invoke the learn skill.
  Focus on pipeline friction from this run — stalls, wrong assumptions, human interventions, retries.
  Spec dir: docs/spec/<SPEC_NAME>/
  If nothing went wrong, skip.

  When done, write a report using this format:
    export HARNESS_DIR='<HARNESS_DIR>'
    /usr/bin/env bash '<DAG_SCRIPT>' write-report learnings '# Learnings

## Friction Points
- What caused delays or confusion

## Patterns Documented
- `path/to/learning.md` — what it covers

## Recommendations
- Suggestions for future runs (or "None — clean run")'

  Return: doc path written (or 'none').
")
```

**Extract from result:** learning doc path (if any)

### Stage 7: Commit & PR

Before dispatching: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && DU='/usr/bin/env bash \"<DAG_SCRIPT>\"' && $DU set-status commit-pr running")`

```
Agent(prompt="
  [PREAMBLE]
  Invoke the git-commit skill to create commits.
  Then push: git push -u origin <BRANCH_NAME>
  Then create PR: gh pr create referencing task summary, spec, and plan.

  When done, write a report using this format:
    export HARNESS_DIR='<HARNESS_DIR>'
    /usr/bin/env bash '<DAG_SCRIPT>' write-report commit-pr '# Commit & PR

## Commits
- `abc1234` — commit message 1
- `def5678` — commit message 2

## Pull Request
- URL: <PR_URL>
- Title: <PR title>
- Branch: <branch> → main'

  Return: commits list, PR URL.
")
```

**Extract from result:** commits, `PR_URL`

---

## Summary

After all stages complete, present a compact summary:

```markdown
## Pipeline Complete

**Task:** <TASK_CONTEXT summary>
**Worktree:** <WORKTREE_PATH> (branch: <BRANCH_NAME>)

| Stage | Result |
|-------|--------|
| 0. Setup | Worktree at <path>, baseline captured |
| 1. Brainstorm | Spec: docs/spec/<name>/spec.md |
| 2. Plan | <phase_count> phases, <parallel> parallel |
| 3. TDD | <files> files, <tests> tests passing |
| 4. Gate | <PASS/BLOCKED/STAGNATION> |
| 5. Sync Docs | <docs_count> docs updated |
| 6. Learnings | <doc_path or "none"> |
| 7. PR | <PR_URL> |

**Issues:** <any retries, failures, stagnation, or "None">
```

After presenting the summary, finalize the dashboard:
```
Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash \"<DAG_SCRIPT>\" finalize done")
```

---

## Error Handling

- If any sub-agent fails or returns an error, **stop the pipeline** and report which stage failed and why
- If the quality gate returns BLOCKED, **stop the pipeline** and report what failed
- If the quality gate returns STAGNATION, **stop the pipeline entirely** — do not retry. Report which check stagnated, the repeated error signature, and that manual intervention is required
- Do not proceed to the next stage if the current one failed
- Present what was accomplished so far and suggest next steps
- Worktree is preserved for manual intervention on failure

---

## Key Principles

- **Each stage is isolated** — sub-agents don't share context, so pass all necessary information in the prompt
- **Extract artifacts** — after each sub-agent returns, extract file paths and key info to pass forward
- **Gate is a hard stop** — a BLOCKED verdict stops the pipeline, no workarounds
- **Parallelize from the graph** — dispatch ready nodes (no incomplete predecessors) in parallel, at both phase and step level
- **Stagnation stops early** — coder detects repeated failures and stops itself, don't loop endlessly
- **Spec folder structure** — all artifacts for a task live in `docs/spec/<name>/` for traceability
- **Dashboard is explicit** — the orchestrator calls `dag-update set-status` at each stage transition. Sub-agents call `dag-update add-node` and `dag-update write-report` for sub-task tracking. A `SessionEnd` hook provides safety-net finalization if the session terminates unexpectedly.
