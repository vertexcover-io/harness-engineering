---
name: orchestrate
description: Take a task from a prompt or PRD all the way to a pull request through a multi-agent pipeline. Use when the user asks to orchestrate or run the full pipeline; hands over a PRD, brief, or design doc to build end to end; asks to auto-fix a tech-debt-finder findings.json; or passes --auto for an unattended CI run.
argument-hint: "<prompt or path/to/prd-or-design.md> [--auto]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent, AskUserQuestion
---

# Orchestrate

Six stages carry a task to a pull request: **0** setup, **1** plan, **3** coder, **4** review, **5** verify, **6** ship.

Every stage appends to the **ledger** — an append-only event log. One script folds the log into a state file. A stage ends when the gate reads that state and passes.

**Announce at start:** "Using the orchestrate skill to run the full development pipeline."

## Invariants

1. **Initialize first.** The Initialization steps below are your first actions. Explore the codebase after them.
2. **Run stages 3 → 4 → 5 → 6 back to back.** Each stage starts when the previous stage's gate passes. The `planning` skill owns the only two pauses, and both self-bypass in `--auto`.
3. **Halt only on the `## Halt` table.** Nothing outside it stops the pipeline. Reaching stage 6 is the only success.
4. **Every question uses `AskUserQuestion`.** In `--auto`, skip them.
5. **Invoke the stage's skill and pass it only this run's variables.** `references/config.md` resolves which skill. The skill owns the contract; paths, ids and ranges are yours to pass. A rule restated in a prompt becomes a second source of truth and drifts. Before leaving a stage, confirm you invoked its skill.

---

## Reference files

Read the one whose condition you are in. Do not work from memory of it.

| File | Read it when |
|------|--------------|
| `references/ledger.md` | appending any event, or reading the gate's answer |
| `references/config.md` | resolving which skill or model a stage runs |
| `references/dag-commands.md` | running any dashboard command |
| `references/dashboard-report-formats.md` | writing the body of a `write-report` call |
| `references/stage-prompts.md` | dispatching a sub-agent (stage 3 or stage 5) |
| `references/coder-contracts.md` | executing a coder phase |
| `references/tech-debt-mode.md` | `INPUT_KIND=findings` |
| `references/atomic-route.md` | planning sent the work straight to `implement` |
| `references/consumer-repo-e2e.md` | a phase changes a library proved in a consumer repo |

---

## Initialization

### Step 1 — Detect the input and gate on the version

One script does both. A stale harness runs stale contracts, so this runs **before the worktree exists**. Pass the raw argument through, `--auto` and all:

```bash
bash "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}/skills/orchestrate/scripts/init-gate.sh" "<raw argument>"
```

It prints four lines. Act on them:

```
AUTO_MODE=true|false
INPUT_KIND=prompt|file|findings
INPUT_PATH=<absolute path, empty when INPUT_KIND=prompt>
VERSION_GATE=OK|UNKNOWN|STALE local=<x> remote=<y>
```

- `INPUT_KIND=prompt` → the stripped argument is the task.
- `INPUT_KIND=file` → read `INPUT_PATH`; its contents are the task.
- `INPUT_KIND=findings` → read `references/tech-debt-mode.md` and follow it.

Store the resolved input as `TASK_CONTEXT`.

`VERSION_GATE=OK` continues. `UNKNOWN` logs one warning and continues. `STALE` stops before anything exists: report both versions, tell the user to run `/plugin`, reload, and re-run. In `--auto`, log the warning and continue — CI cannot reload a session.

`AUTO_MODE=true` skips every `AskUserQuestion`, the worktree, and the dashboard. It commits and pushes but leaves the PR to the caller. All artifacts are still written.

### Step 2 — Worktree, then the dashboard

The dashboard script path is: !`echo "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/skills/orchestrate/dashboard/dag-update.mjs"`

Create the worktree **first**, then start the dashboard from inside it. Both write under the worktree's cwd, so a dashboard started elsewhere splits the run across two checkouts. (In `--auto`, skip this whole step.)

1. Derive `SPEC_NAME` from the task: lowercase, spaces to hyphens, 30 characters at most. `"Add user auth system"` → `"add-user-auth-system"`. **While cwd is still the launch directory**, capture the session id so stage 5 publishes against the real session:
   `SESSION_ID=$(basename "$(ls -t ~/.claude/projects/"$(pwd | sed 's#/#-#g')"/*.jsonl 2>/dev/null | head -1)" .jsonl 2>/dev/null)`
2. Create the worktree with the project's own worktree skill, or `using-git-worktrees`. Store `WORKTREE_PATH` and `BRANCH_NAME`, then `cd` in.
3. From inside the worktree, run the init block in `references/dag-commands.md` verbatim. Store `HARNESS_DIR`.
4. Start the dashboard in the background: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && node '<DAG_SCRIPT>' serve", run_in_background=true)`.

---

## Stages

| # | Stage | Runs in | Produces |
|---|-------|---------|----------|
| 0 | Setup | main conversation | worktree, package commands, baseline numbers |
| 1 | Plan | main conversation | `design.md` · `plan.html` → `plan.md` + `phases/phase-*.md` |
| 3 | Coder | sub-agent, one per phase | implementation, tests, commits |
| 4 | Review | main conversation | `review/review.md` |
| 5 | Verify | sub-agent | `verification/proof-report.html`, quality gate, synced docs |
| 6 | Ship | main conversation | commits and a PR URL |

Stages 3 and 5 are sub-agents. The rest run here: stage 0 sets the working directory, stage 1 explores the code with you, stage 4's skill dispatches its own reviewers, and stage 6 commits.

**Every stage is mandatory.** Planning scales itself — its own gate may route atomic work to `implement`. Never pre-empt that call.

### Stage 0 — Setup

1. `set-status setup running`.
2. Read `harness.json` at the worktree root. **It is missing → halt** and tell the user to run `setup-harness`. Detection is a once-per-project job and never runs here.
3. Create `.harness/<SPEC_NAME>/` and, under it, `phases/`, `review/`, `verification/screenshots/`, and `verify-staging/`. `verify-staging/` is a **sibling** of `verification/`, not a child. The whole `.harness/` tree is gitignored.
4. Append the `start` event, then one `package` event per package in `harness.json` (`references/ledger.md`).
5. Run each package's test, lint and typecheck commands. Append one `check` event per result, each carrying its proof path.
6. Read `orchestrate.config.json` if it exists, into `STAGE_CONFIG`. `references/config.md` owns every rule about it.
7. `write-report baseline`, `set-status setup done`.

### Stage 1 — Plan

1. `set-status planning running`, append `start`.
2. Invoke `planning` via `Skill` with `TASK_CONTEXT`.
3. The skill owns the whole arc, both pauses included. Add no question of your own.
4. Confirm `plan.html`, `plan.md` and `phases/phase-*.md` exist. **Planning routed to `implement` instead → read `references/atomic-route.md`.**
5. Add the phase nodes under `coder` (`references/dag-commands.md`), append `end`, `write-report planning`, `set-status planning done`.

**Extract:** `PLAN_PATH`, `PHASE_DIR`, the phase graph from plan.md's `## Phases`, the phase count.

### Stage 3 — Coder

Parallelism is graph-driven. Read the phase graph, compute the phases with no incomplete predecessor, and dispatch that whole wave in one message. Recompute after each wave.

**One phase is one dispatch** — one TDD cycle, one commit. A phase too large for one agent is a plan defect, so re-slice it.

Build every dispatch from the stage 3 block in `references/stage-prompts.md`. Give each agent a fresh six-character token; that token is how the cost reader finds its transcript later.

The coder appends its own `check`, `artifact` and `end` events. When its report carries `<!-- LIB_SUSPECT:<lib> -->`, append a `problem` with `kind: "library"` and re-dispatch the phase once.

After the last wave: `ledger state --assert coder`. A non-zero exit halts the pipeline and prints the reason.

### Stage 4 — Review

`set-status code-review running`. Invoke `<SKILL:code-review>` **in this conversation** — it dispatches its own reviewers and edits no source. Pass:

- plan `.harness/<SPEC_NAME>/plan.md`, scope `--commits <BASE_BRANCH>..HEAD`
- `--output .harness/<SPEC_NAME>/review/review.md`

Append one `problem` event per defect it reports, each with a `level` of `high`, `medium` or `low`. The verdict is computed from those levels, so grep no prose for it. `set-status code-review done`.

### Stage 5 — Verify

One sub-agent runs functional verification, then the quality gate, then sync-docs. Dispatch the stage 5 template from `references/stage-prompts.md`.

Append a `resolution` for every problem the verifier reports, with `how` set to `fixed` or `accepted`. An `accepted` needs a reason. **A problem left open halts stage 6** — the gate counts them, so no one has to remember.

Then `ledger state --assert verify`. It checks that `proof-report.html` exists and that no test failed.

A passing `.spec.ts` is not evidence the feature works. The verifier drives a real browser through the `agent-browser` CLI and films each scenario.

### Stage 6 — Ship

`ledger state --assert ship` first — it refuses while any problem is open. Then:

1. Write `.harness/<SPEC_NAME>/README.md`: title, verification verdict, one paragraph, and a list of every artifact. Reviewers read it out of band, because nothing under `.harness/` reaches the PR.
2. Invoke `git-commit` via `Skill`. `.harness/` is gitignored — if `git status` shows it, fix `.gitignore`.
3. `git push -u origin <BRANCH_NAME>`.
4. Unless `--no-pr`: `gh pr create --title '<spec title>' --body '<one paragraph; artifacts live in .harness/<SPEC_NAME>/>' --base main --head <BRANCH_NAME>`.
5. Append the PR `artifact` event and the run's `end`. Backfill the PR URL into README.md.
6. `write-report commit-pr`, `set-status commit-pr done`.

---

## Execution rules

**The ledger.** Set `LEDGER_DIR` once, in stage 0. Every append and every gate call uses it. The event vocabulary and the gate's answers live in `references/ledger.md`.

**Waiting status.** A hook sets the running node to `waiting` around any `AskUserQuestion` and appends the `question` and `answer` events. Nothing to do by hand.

**Sub-agent prompts.** Each starts with the `[PREAMBLE]` from `references/stage-prompts.md`, then names the resolved skill and this run's variables.

**Dashboard.** `set-status running` before each stage and `done` after. Take every command verbatim from `references/dag-commands.md`; a mistyped one writes nothing silently.

**Document style.** Every human-facing document follows `${CLAUDE_PLUGIN_ROOT}/skills/_shared/writing-style.md`. Sub-agents that write documents get that path.

---

## Halt

Stop and report which stage failed and why on any of these. This table is the whole halt set.

| Condition | Detail |
|-----------|--------|
| Sub-agent error | any sub-agent fails or returns an error |
| `harness.json` missing | stage 0 has no package commands — tell the user to run `setup-harness` |
| A gate exits non-zero | `ledger state --assert` prints one word; report it and its detail |
| Functional verification failed | name the scenarios that failed |
| Quality gate BLOCKED | report what failed |
| Quality gate STAGNATION | report the stagnated check and its repeated error. Do not retry. |
| Review cites a hard violation | `review.md` names a documented standard and a `file:line`. Report both. |

A review that reports only judgement calls logs a warning and continues to stage 5. On any halt the worktree is preserved — say what was accomplished and what to do next.

---

## Summary

Present this only after stage 6, or after a halt.

```markdown
## Pipeline Complete

**Task:** <TASK_CONTEXT summary>
**Worktree:** <WORKTREE_PATH> (branch: <BRANCH_NAME>)

| Stage | Result |
|-------|--------|
| 0. Setup | <packages> packages, baseline captured |
| 1. Plan | <phase_count> phases · plan.html |
| 3. Coder | <files> files, <tests> tests |
| 4. Review | <verdict>, <problems> problems |
| 5. Verify | verify <PASSED/FAILED>, gate <PASS/BLOCKED>, docs <N> |
| 6. Ship | <PR_URL> |

**Cost:** $<total> over <minutes> minutes, <wait> waiting on you
**Issues:** <retries, failures, or "None">
```

Read the cost and timing straight from `state.json` — `ledger state --refresh` fills them from the transcripts.

Finalize: `Bash("export HARNESS_DIR='<HARNESS_DIR>' && node '<DAG_SCRIPT>' finalize done")`
