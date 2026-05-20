---
name: orchestrate
description: >
  Multi-agent pipeline orchestrator. Takes a prompt or spec file and runs:
  brainstorm, planner, coder (TDD + stagnation detection), code review (two-pass review+fix),
  verify & finalize (functional verification + quality gate + sync docs + learnings), and commit/PR.
  Reviewer-facing artifacts stored in docs/spec/<name>/ (committed); pipeline working state in .harness/<name>/ (gitignored). Use when the user says orchestrate, run the pipeline,
  full workflow, or wants end-to-end development from spec to PR.
  Supports --auto mode for CI/CD pipelines — bypasses interactive approval gates while still producing all artifacts.
argument-hint: "<prompt or path/to/spec.md> [--auto]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
---

# Orchestrate: Multi-Agent Development Pipeline

Runs a full development pipeline in 7 stages. Brainstorm, Planner, and Commit & PR run in the main conversation. All other stages are dispatched as sub-agents via the `Agent` tool.

**Announce at start:** "Using the orchestrate skill to run the full development pipeline."

**CRITICAL: Do NOT explore the codebase, read project files, or fetch URLs before completing the Initialization steps below. The very first actions are: detect input, check for auto mode, then start the dashboard. No exceptions.**

**CRITICAL: Do NOT stop, pause, or present a summary until ALL pipeline stages (0-6) have completed or a stage has explicitly failed/blocked. Each stage flows directly into the next. The only permitted pause is the plan approval gate after Stage 2.**

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
- **Skip PR creation in Stage 6** — only commit and push; caller handles PR interaction
- **All artifacts still produced** (design docs, specs, plans) for auditability

### Step 2: DAG Dashboard Bootstrap

The dashboard script path is: !`echo "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/skills/orchestrate/dashboard/dag-update.sh"`
Store the path above as `DAG_SCRIPT`. All Bash calls below use this resolved path.

Start the dashboard immediately. Do NOT read files, explore the codebase, or invoke any Skill or Agent before this.

1. Generate a spec name from the task prompt: lowercase, replace spaces with hyphens, truncate to 30 chars. Example: `"Add user auth system"` → `"add-user-auth-system"`
2. Initialize the DAG and start the dashboard:
   ```
   Bash("
     export HARNESS_DIR=$(/usr/bin/env bash '<DAG_SCRIPT>' init '<SPEC_NAME>' '<TASK_CONTEXT summary>' unknown unknown)
     /usr/bin/env bash '<DAG_SCRIPT>' add-node setup 'Setup'
     /usr/bin/env bash '<DAG_SCRIPT>' add-node worktree 'Create Worktree' --parent setup
     /usr/bin/env bash '<DAG_SCRIPT>' add-node baseline 'Baseline Metrics' --parent setup --depends-on worktree
     /usr/bin/env bash '<DAG_SCRIPT>' add-node brainstorm 'Brainstorm' --depends-on setup
     /usr/bin/env bash '<DAG_SCRIPT>' add-node library-probe 'Library Probe' --depends-on brainstorm
     /usr/bin/env bash '<DAG_SCRIPT>' add-node spec-gen 'Spec Generation' --depends-on library-probe
     /usr/bin/env bash '<DAG_SCRIPT>' add-node planning 'Planning' --depends-on spec-gen
     /usr/bin/env bash '<DAG_SCRIPT>' add-node coder 'Coder' --depends-on planning
     /usr/bin/env bash '<DAG_SCRIPT>' add-node code-review 'Code Review' --depends-on coder
     /usr/bin/env bash '<DAG_SCRIPT>' add-node verify-finalize 'Verify & Finalize' --depends-on code-review
     /usr/bin/env bash '<DAG_SCRIPT>' add-node commit-pr 'Commit & PR' --depends-on verify-finalize
     /usr/bin/env bash '<DAG_SCRIPT>' serve
   ")
   ```
   Note: Phase nodes are added as children of `coder` after planning (Stage 2) when phases are known.
3. Store `HARNESS_DIR` for use in all subsequent `dag-update` calls.

**DAG command pattern:** Invoke `dag-update.sh` directly instead of storing the command in a shell string. This works in both bash and zsh:
`Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' <command> <args>")`

---

## Pipeline Stages

| # | Stage | Execution | Output |
|---|-------|-----------|--------|
| 0 | Setup | **Main conversation** | Worktree path, baseline metrics, spec directory |
| 1 | Brainstorm | **Main conversation** | `docs/spec/<name>/design.md` with declared dependency + fallback chain |
| 1.5 | Library Probe | **Main conversation** | `docs/spec/<name>/library-probe.md` + verified probe scripts (in `.harness/<name>/probes/`) |
| 1.7 | Spec Generation | **Main conversation** | `docs/spec/<name>/spec.md` (folds VS-0 probe scenarios in) |
| 2 | Planner | **Main conversation** | `docs/spec/<name>/plan.md` (committed) + `.harness/<name>/phase-*.md` (gitignored) |
| 3 | Coder | Sub-agent (parallelizable) | Implementation + tests + `.harness/<name>/phase-<N>-claims.json` (one per phase) |
| 4 | Code Review | Sub-agent (2-pass) | `.harness/<name>/review/pass-{1,2}.md` verdicts, fixes applied |
| 5 | Verify & Finalize | Sub-agent | Functional verification, quality gate PASS/BLOCKED, synced docs, learnings captured |
| 6 | Commit & PR | **Main conversation** | Commits + PR URL |

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

### Mandatory Stages (never skip)

| Stage | Why |
|-------|-----|
| 0: Setup | Worktree and baseline are always required |
| 1.5: Library Probe | Trust gate — every external dep must be verified before code is written |
| 3: Coder | Core implementation — the whole point of the pipeline |
| 4: Code Review | Semantic verification gate — catches bugs that metrics can't |
| 5: Verify & Finalize | Functional verification + quality gate + docs + learnings — always runs as single consolidated stage |
| 6: Commit & PR | Always runs to finalize work (runs in main conversation) |

### Handling Skipped Stages

For each skipped stage:
1. Set its DAG status to `skipped` (using the full `export HARNESS_DIR=... && DU=...` preamble pattern)
2. Log: "Skipping Stage N (<name>) — <reason>"
3. Proceed to the next stage in order

**Even when stages are skipped, all mandatory stages MUST execute in order.** Skipping brainstorm does not skip setup. Skipping planning does not skip coder, code review, quality gate, or commit.

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

Invoke their respective skills directly using the `Skill` tool. All other stages (3-5) run as sub-agents via the `Agent` tool.

### Pipeline Flow

```dot
digraph pipeline {
  rankdir=LR
  node [shape=box]

  stage_0 [label="0: Setup"]
  stage_1 [label="1: Brainstorm"]
  stage_15 [label="1.5: Library Probe"]
  stage_17 [label="1.7: Spec Generation"]
  stage_2 [label="2: Planner"]
  stage_3 [label="3: Coder"]
  stage_4 [label="4: Code Review"]
  stage_5 [label="5: Verify & Finalize"]
  stage_6 [label="6: Commit & PR"]

  stage_0 -> stage_1 -> stage_15 -> stage_17 -> stage_2 -> stage_3
  stage_3 -> stage_4 -> stage_5 -> stage_6
  stage_4 -> stage_4 [label="2-pass review+fix" style=dashed]
  stage_3 -> stage_15 [label="LIB_SUSPECT loopback" style=dashed color=red]
}
```

Stage 3 (Coder) is the only stage with internal parallelism — see "Parallel When Possible" below. Stage 4 (Code Review) has a two-pass review — see Stage 4 dispatch below.

### Parallel When Possible

After Stage 2, read the **phase graph** from plan.md (DOT digraph) and dispatch in waves:

**Phase waves:** Compute **ready nodes** = phases with no incomplete predecessors. Dispatch all ready phases in parallel. After each wave completes, recompute → dispatch next wave.

**Per phase, choose ONE strategy:**
- **Has step graph** in `phase-N.md` → dispatch steps in waves (same ready-node logic), skip phase-level agent
- **No step graph** → single agent for the whole phase

**To parallelize:** Send multiple `Agent` tool calls in a single message.

---

## Local Skill Override Resolution

Before dispatching any stage that invokes a named skill, check for a project-local override in the current working directory:

```
<cwd>/.claude/skills/<skill-name>/SKILL.md
```

Resolution order:
1. `<cwd>/.claude/skills/<skill-name>/SKILL.md` — project-local (wins)
2. Global harness skill — fallback

Applies to: `quality-gate`, `tdd`, `testing`, `code-review`, `library-probe`.
Does NOT apply to `orchestrate` itself (no recursive override).

When a local override is found, log:
> "Using local skill override: .claude/skills/\<skill-name\>/SKILL.md"

The local skill is loaded and followed exactly in place of the global one. The local skill is responsible for emitting compatible verdict comments so orchestrate can parse the result:
- `<!-- QG:VERDICT:PASS -->` or `<!-- QG:VERDICT:BLOCKED -->`
- `<!-- QG:CHECK:N:PASS -->` or `<!-- QG:CHECK:N:BLOCKED -->` (N = 1–9)

---

## Sub-Agent Dispatch

### Stage 0: Setup (Main Conversation)

**Worktree sub-step:**
1. Run FIRST: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status setup running && /usr/bin/env bash '<DAG_SCRIPT>' set-status worktree running")`
2. Invoke the `using-git-worktrees` skill via `Skill` tool to create the worktree
3. `cd` into worktree. Store: `WORKTREE_PATH`, `BRANCH_NAME`
4. After worktree ready: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' write-report worktree '# Worktree\n- **Path:** <WORKTREE_PATH>\n- **Branch:** <BRANCH_NAME>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status worktree done")`

**Baseline sub-step:**
5. `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status baseline running")`
6. Derive `SPEC_NAME` from task, create:
   - `docs/spec/<SPEC_NAME>/verification/{screenshots,traces}/` (committed tree)
   - `.harness/<SPEC_NAME>/review/` (gitignored working tree; `reports/` already created by dashboard init)
7. Auto-detect project tooling: check `CLAUDE.md` first, then `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`
8. Run baseline metrics (typecheck, lint, test, coverage), write to `.harness/<SPEC_NAME>/baseline.json`
9. Write `.harness/<SPEC_NAME>/manifest.json` skeleton `{spec_name, branch, worktree, started_at, pr_number: null, stages: {}}`
10. Store: `SPEC_NAME`, `SPEC_DIR` (`docs/spec/<SPEC_NAME>/`), `HARNESS_SPEC_DIR` (`.harness/<SPEC_NAME>/`), `BASELINE_PATH`, `MANIFEST_PATH`
11. After baseline: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' write-report baseline '# Baseline\n- **Spec:** <SPEC_NAME>\n- **Baseline:** <BASELINE_PATH>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status baseline done && /usr/bin/env bash '<DAG_SCRIPT>' set-status setup done")`

### Stage 1: Brainstorm (Main Conversation)

1. `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status brainstorm running")`
2. Invoke `brainstorm` skill via `Skill` tool — no approval gate, design flows straight through.
   The brainstorm skill MUST produce a `## External Dependencies & Fallback Chain` section in the design doc (see brainstorm Phase 2.5). If absent, library-probe will block.
3. Mark brainstorm done:
   `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' write-report brainstorm '# Brainstorm' && /usr/bin/env bash '<DAG_SCRIPT>' set-status brainstorm done")`

### Stage 1.5: Library Probe (Main Conversation)

The trust gate. Runs *before* spec generation so verified probes can be folded into the spec as VS-0 scenarios.

1. `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status library-probe running")`
2. Invoke `library-probe` skill via `Skill` tool. Pass design-doc path and `SPEC_DIR`. Pass `--auto` if `AUTO_MODE=true`.
3. Read the verdict marker from `docs/spec/<SPEC_NAME>/library-probe.md`:
   - `<!-- LP:VERDICT:PASS -->` → continue.
   - `<!-- LP:VERDICT:BLOCKED -->` → **stop the pipeline.** Report which library failed and the user's choice (or that creds were missing in `--auto`).
   - `NOT_APPLICABLE` (no external deps) → continue.
4. Mark done:
   `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' write-report library-probe '<summary>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status library-probe done")`

### Stage 1.7: Spec Generation (Main Conversation)

1. `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status spec-gen running")`
2. Invoke `spec-generation` skill — it reads `docs/spec/<SPEC_NAME>/design.md` + `library-probe.md` + the probe verification stubs at `docs/spec/<SPEC_NAME>/verification/verification-stubs.md` and folds them into the spec's `## Verification Scenarios` (so functional-verify re-runs the probes).
3. Save spec to `docs/spec/<SPEC_NAME>/spec.md`, store `SPEC_PATH`.
4. `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status spec-gen done")`

### Stage 2: Planner (Main Conversation)

1. `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status planning running")`
2. Invoke `planning` skill via `Skill` tool — it reads design doc + spec internally
3. Planner explores codebase, asks interactive questions, designs phases
4. **APPROVAL GATE:** Use `AskUserQuestion` — hook auto-handles waiting status
5. Output: `docs/spec/<SPEC_NAME>/plan.md` (committed) + `.harness/<SPEC_NAME>/phase-*.md` (gitignored). Store `PLAN_PATH=docs/spec/<SPEC_NAME>/plan.md` and `PHASE_DIR=.harness/<SPEC_NAME>/`
6. Add phase DAG nodes as children of `coder`, mark planning done:
   `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status planning done")`
7. Add phase nodes: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' add-node phase-1 'Phase 1: <label>' --parent coder && /usr/bin/env bash '<DAG_SCRIPT>' add-node phase-2 'Phase 2: <label>' --parent coder --depends-on phase-1")`

**Extract:** `PLAN_PATH`, `PHASE_DIR`, phase graph (DOT from plan.md), phase count

### Stage 3: Coder

Dispatch based on phase and step dependency graphs. Two-level parallelism:

**Parallelism heuristic:** Only parallelize phases touching 3+ files or having a Steps section. Serialize smaller phases.

**Phase level:** Parse the phase graph from plan.md. Dispatch ready nodes (no incomplete predecessors) in waves.

**Step level:** For each phase, read `.harness/<SPEC_NAME>/phase-N.md`. If it has a step graph → dispatch steps in waves. If not → single agent for the phase.

DAG transitions:
- Before dispatching: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status coder running")`
- Before each phase: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status <phase-node> running")`
- After each phase: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status <phase-node> done")`
- After all phases: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status coder done")`

**Claims aggregation (mandatory, runs after the last phase completes):**

Aggregate every `.harness/<SPEC_NAME>/phase-*-claims.json` into a single
`.harness/<SPEC_NAME>/claims.json`. The aggregated schema and the exact `jq`
command live in `references/claims-aggregation-format.md` — invoke it verbatim.
If aggregation fails (`MISSING_PHASE_CLAIMS`), stop the pipeline. The aggregated
`claims.json` is what verify reads; phase files are kept for audit.

### LIB_SUSPECT Loopback (from Stage 3 → 1.5)

After every coder sub-agent returns, scan its report for the marker
`<!-- LIB_SUSPECT:<lib>:<class> -->`. If present:

1. Increment a session-level counter `LOOPBACK_COUNT` (start at 0). Cap at **2**.
   Beyond 2 → stop the pipeline with `BLOCKED:repeated-lib-failure` and report.
2. Mark the failed phase node `blocked` in the DAG.
3. Re-invoke `library-probe` skill with `--lib <lib>`:
   ```
   Skill(name="library-probe", args="--lib <lib> --auto" if AUTO_MODE else "--lib <lib>")
   ```
4. Read `docs/spec/<SPEC_NAME>/library-probe.md` after it returns:
   - If `<!-- LP:VERDICT:BLOCKED -->` → stop the pipeline. The user (or auto-fail) said no viable alternative.
   - If a `## Re-plan Required` section is present → re-invoke the `planning` skill scoped to the affected phase(s) only. The planner reads the new selected library from `library-probe.md` and rewrites the relevant `.harness/<SPEC_NAME>/phase-N.md`.
5. Re-dispatch the affected phase agent. Skip phases already marked done.

This is the only retry loop the pipeline performs automatically. It exists
because library failure is the one error class where retrying the *same* code
is futile — the answer is to swap the underlying tool, not iterate the call.

**A) Phase has no Steps section** → single agent:
```
Agent(model="sonnet", prompt="
  [PREAMBLE]
  Invoke tdd skill. Spec: <SPEC_PATH>. Plan: docs/spec/<SPEC_NAME>/plan.md. Phase file: .harness/<SPEC_NAME>/phase-<PHASE_N>.md.

  **E2E TDD is MANDATORY when this phase touches:**
  - any file under packages/web/ (or app/, pages/, frontend/, src/components/ — adapt to project layout), OR
  - any HTTP route file (packages/api/src/routes/, src/routes/, etc.)

  When mandatory:
  1. Write the failing e2e test(s) FIRST (Playwright, Cypress, or project-standard).
  2. Implement until they pass.
  3. **Actually run the suite** end-to-end against live services. Authoring the spec is not enough.
     For infra startup, follow the global reference at
     `<harness-skills-root>/functional-verify/references/infra-startup.md` — it covers
     port probing, finding the right `package.json`/`compose.yml`/`Makefile` command,
     background-starting the service, health-polling up to 30 s, and the cleanup contract
     ("if you started it, you kill it"). Apply migrations first, then start API + web
     dev servers (or project equivalent), then run the e2e command. If the project has a
     local override at `.claude/skills/functional-verify/`, prefer that.
  4. Write the runner's output to `.harness/<SPEC_NAME>/phase-<PHASE_N>-claims.json`.
     Follow the schema and rules in `skills/tdd/references/phase-claims-format.md` —
     it covers the JSON shape, the `claims[]` contract (UI surfaces require ≥1
     `type: "ui"` claim), id format (`PHASE<N>-C<M>`), and anti-patterns.

  The phase is BLOCKED until phase-<N>-claims.json exists with `executed > 0` AND
  `failed = 0` AND (if UI is touched) at least one UI claim. Authoring the spec
  without running it = BLOCKED, not done. The orchestrator verifies this independently.

  For dashboard updates: export HARNESS_DIR='<HARNESS_DIR>' NODE_ID='<phase-node-id>';
  use /usr/bin/env bash '<DAG_SCRIPT>' add-node for sub-tasks, /usr/bin/env bash '<DAG_SCRIPT>' set-status for progress.
  When done, write a phase report following the 'Coder Phase Report' format in
  references/dashboard-report-formats.md.
")
```

**B) Phase has Steps section** → dispatch per-step, parallelizing independent steps:
```
Agent(model="sonnet", prompt="
  [PREAMBLE]
  Invoke tdd and testing skills. Spec: <SPEC_PATH>. Plan: docs/spec/<SPEC_NAME>/plan.md.
  Phase file: .harness/<SPEC_NAME>/phase-<PHASE_N>.md. Step: <STEP_DETAILS>.

  **E2E TDD is MANDATORY when this step touches frontend or HTTP routes** — see the full
  E2E contract in the Phase-A agent prompt above. Summary:
    1. Write the failing e2e test FIRST.
    2. Implement until it passes.
    3. **Actually run the suite** against live services (start infra + dev servers if needed).
    4. Write `.harness/<SPEC_NAME>/phase-<PHASE_N>-claims.json` per
       `skills/tdd/references/phase-claims-format.md` (executed > 0, failed = 0,
       UI surfaces require ≥1 `type: "ui"` claim).
  Authoring the spec without running it = BLOCKED, not done.

  Scope: Only this step's files. Return: files created/modified, test results, step completed or blocked.
")
```

Dispatch in waves: send all independent steps in parallel → wait → dispatch next wave → repeat.

### Stage 4: Code Review Loop

Two-pass review: a review+fix agent addresses defects directly, then a final review validates.

`Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status code-review running")`

**Pass 1 — Review & Fix:**

```
Agent(model="sonnet", prompt="
  [PREAMBLE]
  Invoke code-review skill. Plan: docs/spec/<SPEC_NAME>/plan.md.
  Scope: --commits <BASE_BRANCH>..HEAD. Output: --output .harness/<SPEC_NAME>/review/pass-1.md.

  After completing the review:
  — If verdict is APPROVE or APPROVE WITH SUGGESTIONS: skip fixing, just write the review report.
  — If verdict is REQUEST CHANGES: FIX all Critical and Important defects you found.
    Invoke tdd skill. Run tests after each fix. Then write a combined review+fix report
    and append the list of fixed defects to .harness/<SPEC_NAME>/review/fixes-applied.md.

  Write dashboard reports following 'Code Review Report' and 'Fix Report' formats in
  references/dashboard-report-formats.md.
  Return: verdict, defects found, defects fixed, files modified.
")
```

`Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status review-1 done")`

**Pass 2 — Final Review:**

```
Agent(model="sonnet", prompt="
  [PREAMBLE]
  Invoke code-review skill. Plan: docs/spec/<SPEC_NAME>/plan.md.
  Scope: --commits <BASE_BRANCH>..HEAD. Output: --output .harness/<SPEC_NAME>/review/pass-2.md.
  This is the FINAL review pass.

  If verdict is REQUEST CHANGES: fix any remaining Critical/Important defects yourself.
  Then re-review the fix. Your output is the definitive verdict.

  Write dashboard report following 'Code Review Report' format in
  references/dashboard-report-formats.md.
  Return: final verdict, any defects fixed in this pass.
")
```

`Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status code-review done")`

**Verdict parsing:** Match `REQUEST CHANGES` first, then `APPROVE WITH SUGGESTIONS`, then `APPROVE`.

### Stage 5: Verify & Finalize

Single consolidated sub-agent that runs functional verification, quality gate, syncs docs, and captures learnings.

`Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status verify-finalize running")`

```
Agent(model="sonnet", prompt="
  [PREAMBLE]
  Run these in order. Stop and return failure immediately if any step fails.

  1. FUNCTIONAL VERIFICATION: Invoke functional-verify skill.
     Spec: docs/spec/<SPEC_NAME>/spec.md. Plan: docs/spec/<SPEC_NAME>/plan.md.
     Phase files: .harness/<SPEC_NAME>/phase-*.md.
     Claims report: .harness/<SPEC_NAME>/claims.json (aggregated from phase-*-claims.json).
     Functional-verify reads this in Step 0. Every `type: "ui"` claim MUST be independently re-proven
     via Playwright MCP — a passing phase .spec.ts is NOT a substitute. API/DB claims may be cited
     as COVERED_BY_E2E. Phase format: skills/tdd/references/phase-claims-format.md.
     Aggregated format + UI-proof gate: skills/orchestrate/references/claims-aggregation-format.md.
     The skill produces TWO required artifacts (both committed):
       - docs/spec/<SPEC_NAME>/verification/proof-report.md  (gate output — the verdict)
       - docs/spec/<SPEC_NAME>/verification/adversarial-findings.md  (Step 5 role-swap pass: scenarios attempted + defects)
     Plus screenshots in docs/spec/<SPEC_NAME>/verification/screenshots/ and traces in verification/traces/.
     Both proof-report.md and adversarial-findings.md must exist before you return. Missing either one = verification did not happen, treat as FAILED.
     Write dashboard report following 'Verification Report' format in
     references/dashboard-report-formats.md.
     If FAILED: stop entirely, return failure with which scenarios failed and why.
     Evidence is saved to docs/spec/<SPEC_NAME>/verification/ — do NOT delete it.

  2. QUALITY GATE: Invoke quality-gate skill.
     Baseline: .harness/<SPEC_NAME>/baseline.json. Spec dir: docs/spec/<SPEC_NAME>/. Harness dir: .harness/<SPEC_NAME>/. Stage: post-tdd.
     Write dashboard report following 'Quality Gate Report' format in
     references/dashboard-report-formats.md.
     If BLOCKED or STAGNATION: stop entire pipeline, return verdict + failure details.

  3. SYNC DOCS: Invoke sync-docs skill.
     Spec dir: docs/spec/<SPEC_NAME>/. Harness dir: .harness/<SPEC_NAME>/ (phase-*.md).
     Write dashboard report following 'Sync Docs Report' format in
     references/dashboard-report-formats.md.

  4. CAPTURE LEARNINGS: Invoke learn skill.
     Focus on pipeline friction — stalls, wrong assumptions, retries.
     Spec dir: docs/spec/<SPEC_NAME>/ (task-specific learnings land in learnings.md; reusable patterns
     still go to docs/solutions/<category>/). If nothing went wrong, skip.
     Write dashboard report following 'Learnings Report' format in
     references/dashboard-report-formats.md.

  Return: verification verdict, gate verdict, docs list, learning doc path (or 'none').
")
```

**After the sub-agent returns, enforce the proof-report contract AND the e2e-execution contract before trusting the verdict:**

```
Bash("
  test -f docs/spec/<SPEC_NAME>/verification/proof-report.md &&
  test -f docs/spec/<SPEC_NAME>/verification/adversarial-findings.md ||
  { echo 'MISSING_VERIFICATION_ARTIFACTS'; exit 1; }
")
```

If either file is missing → treat verification as FAILED regardless of what the sub-agent returned, stop the pipeline. A "PASSED" verdict without the artifacts means the gate was skipped — the Stop/SubagentStop hook should have already blocked it, but this is the belt-and-suspenders check in orchestrate.

**E2E execution + UI-proof gate (mandatory):**

After verify returns, run the aggregated-claims gate from
`references/claims-aggregation-format.md`. It enforces, in order:

1. `claims.json` exists, `executed > 0`, `failed = 0`.
2. Every `type: "ui"` claim id appears in `verification/proof-report.md` AND has a
   `verification/screenshots/*.png` reference on the same / a nearby line.

Failure modes (stop the pipeline, do not continue):

- `MISSING_PHASE_CLAIMS` / `MISSING_CLAIMS_FILE` — coder or aggregation skipped.
- `E2E_NOT_EXECUTED` / `E2E_FAILED` — phase suites did not run or had failures.
- `MISSING_UI_PROOF — <claim-ids>` — verify skipped Playwright MCP for one or more
  UI claims. Re-dispatch verify with explicit instruction to cover the listed ids.

A passing phase `.spec.ts` is NOT sufficient — the verifier must drive a real
browser via `mcp__playwright__browser_*` and capture screenshots per claim id.

`Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status verify-finalize done")`

**If functional verification FAILED → stop pipeline and report which scenarios failed.**
**If proof-report.md or adversarial-findings.md is missing → stop pipeline, report MISSING_VERIFICATION_ARTIFACTS.**
**If quality gate BLOCKED → stop pipeline and report what failed.**
**If STAGNATION → stop pipeline entirely, do not retry.**

### Stage 6: Commit & PR (Main Conversation)

`Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status commit-pr running")`

Do these directly (no sub-agent):

1. **Generate `docs/spec/<SPEC_NAME>/README.md`** — the reviewer index. Include:
   - Title (from spec) + final verification verdict (PASS / BLOCKED, with link to `verification/proof-report.md`)
   - One-paragraph summary of what was built (from spec)
   - Table of contents linking each committed artifact: `design.md`, `spec.md`, `plan.md`, `library-probe.md`, `learnings.md` (if present), `verification/proof-report.md`, `verification/adversarial-findings.md`
   - Library-probe verdict line (selected lib + alternatives tried)
   - PR link placeholder (filled in after step 4)
2. Invoke the `git-commit` skill via `Skill` tool. It should create a final, separate commit for the artifact tree: `docs(spec): add artifacts for <SPEC_NAME>` containing only the `docs/spec/<SPEC_NAME>/` files (kept distinct from feature commits for review clarity).
3. `Bash("git push -u origin <BRANCH_NAME>")`
4. If PR desired (not --no-pr): `Bash("gh pr create --title '<spec title>' --body 'Closes: see docs/spec/<SPEC_NAME>/README.md for design, spec, plan, and verification proof.' --base main --head <BRANCH_NAME>")`
5. Update `.harness/<SPEC_NAME>/manifest.json` with `pr_number` and `completed_at`. Backfill the PR URL into `docs/spec/<SPEC_NAME>/README.md` and amend the artifact commit (or follow up with a new commit if pre-existing commit policy forbids amend).
6. Write dashboard report following 'Commit & PR Report' format in references/dashboard-report-formats.md.
   Use: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' write-report commit-pr '...'")`
7. `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' set-status commit-pr done")`

**Extract:** commits, `PR_URL`

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
| 2. Plan | <phase_count> phases |
| 3. Coder | <files> files, <tests> tests |
| 4. Review | <verdict> (2-pass) |
| 5. Verify & Finalize | Verify: <PASSED/FAILED>, Gate: <PASS/BLOCKED>, docs: <N> updated, learnings: <path or none> |
| 6. PR | <PR_URL> |

**Issues:** <any retries, failures, stagnation, or "None">
```

Finalize: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && /usr/bin/env bash '<DAG_SCRIPT>' finalize done")`

---

## Error Handling

- If any sub-agent fails or returns an error, **stop the pipeline** and report which stage failed and why
- If functional verification fails (any scenario), **stop the pipeline** — the feature doesn't work as specified
- If the review pass 2 still returns `REQUEST CHANGES` after its own fix attempt, **log a warning but proceed** to Stage 5 — verification and gate catch remaining violations
- If a review agent fails, **stop the pipeline** — do not continue
- If the quality gate returns BLOCKED, **stop the pipeline** and report what failed
- If the quality gate returns STAGNATION, **stop the pipeline entirely** — do not retry. Report which check stagnated, the repeated error signature, and that manual intervention is required
- Do not proceed to the next stage if the current one failed
- Present what was accomplished so far and suggest next steps
- Worktree is preserved for manual intervention on failure

---

## Key Principles

- **Each stage is isolated** — sub-agents don't share context, so pass all necessary information in the prompt
- **Extract artifacts** — after each sub-agent returns, extract file paths and key info to pass forward
- **Verify before gate** — functional verification runs the app and tests features live BEFORE the quality gate runs metrics. A feature that doesn't work is caught early, with evidence.
- **Gate is a hard stop** — a BLOCKED verdict stops the pipeline, no workarounds
- **Parallelize from the graph** — dispatch ready nodes (no incomplete predecessors) in parallel, at both phase and step level. Only parallelize phases touching 3+ files
- **Stagnation stops early** — coder detects repeated failures and stops itself, don't loop endlessly
- **Spec folder structure** — committed, reviewer-facing artifacts live in `docs/spec/<name>/` (design, spec, plan, library-probe, learnings, verification/); pipeline working state lives in `.harness/<name>/` (baseline, phase-*, phase-*-claims.json, claims.json, gate-reports, review/, probes/, manifest) and is gitignored
- **Dashboard** — orchestrator calls `/usr/bin/env bash '<DAG_SCRIPT>' set-status` at each stage transition. Sub-agents use `/usr/bin/env bash '<DAG_SCRIPT>' add-node` and `/usr/bin/env bash '<DAG_SCRIPT>' write-report` for sub-task tracking. Formats live in `references/dashboard-report-formats.md`.
