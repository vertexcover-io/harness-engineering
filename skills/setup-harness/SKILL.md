---
name: setup-harness
description: "Set up the harness in a repo. Runs the doctor, fixes what can be fixed here, resolves any standing instruction that would pause an unattended run, hands the user what only they can do, and writes the project's `orchestrate.config.json`. Use when the user says 'set up the harness', is running a harness skill in this repo for the first time, or when a stage halts because a tool is missing or `orchestrate.config.json` is absent or stale."
allowed-tools: Bash, Read, Edit, Write, AskUserQuestion
user-invocable: true
---

# Setup Harness

Bring a repo to the point where `/orchestrate "<task>"` runs unattended.

Anything holding a secret, a login, or a `sudo` password is the user's. Print its command and stop there.
Everything else is yours to run once they agree.

Under `--auto`, run every fix that is yours without asking and stop only on the user's, since nobody is
there to answer.

Run every step from the main repo root, `git rev-parse --show-toplevel`. `.gitignore` lives there.

## Step 1 — Doctor

```
node --experimental-strip-types "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-.}}/skills/_shared/doctor.ts" --json || true
```

Read the results and derive nothing you did not read. Each carries `status`, `optional`, `detail`, and a
`fix` list of candidate commands. The rows are the harness's own checks followed by the project's, when
`orchestrate.config.json` names a `doctor` (see `skills/orchestrate/references/config.md`). A red
`optional` check costs one stage: `gh` skips the PR, `samskara` skips publish. A red required check halts
everything.

Report every check, passed and failed. Then for each failure, propose the entry from its `fix` matching
this machine. The list is flat, so judge from the commands themselves which entries are alternatives and
which are steps in order. A project row's fix is the project's own command — run it as printed.

## Step 2 — Re-run

Run Step 1's command again.

All required checks green: go to Step 3. Otherwise repeat Step 1 for the checks still red, except any
check whose fix already ran. That one is the user's now.

## Step 3 — Resolve instructions that would pause the pipeline

**Purpose:** the pipeline runs with nobody watching. It branches, commits, pushes and opens a PR on
its own. A standing instruction like "ask before committing" makes it stop and wait for an answer
that never comes. Find every such line now and settle it with the user.

**1. List the instruction files.** Everything Claude reads as rules in this repo:

```bash
M=~/.claude/projects/"$(printf %s "$PWD" | tr '/.' '--')"/memory
for f in $(git ls-files '*CLAUDE.md' '*AGENTS.md') CLAUDE.local.md \
         .claude/settings.json .claude/settings.local.json \
         ~/.claude/CLAUDE.md ~/.claude/rules/*.md "$M"/*.md; do [ -f "$f" ] && echo "$f"; done
```

**2. Read each file in full** and pick out every line that would make an unattended run stop:
a pause, a confirmation, a ban on something a stage does. Judge meaning, not wording — "ask before
committing" and "no autonomous git" are the same conflict. In `.claude/settings.json`, a
`permissions.deny` entry or a blocking `PreToolUse` hook is a hard stop: the stage fails, no reasoning
gets past it.

**3. Ask the user, one conflict at a time.** Quote the line, name the stage it stops, and offer:

- **Scope it** (default) — keep the rule, add an exemption for the pipeline. Under `--auto`, do this.
- **Remove it.**
- **Keep it** — stays red in Step 5; the pipeline will not finish unattended.

**4. Write the exemption into the repo's own `CLAUDE.md`** — always there, even when the rule lives
in `~/.claude/CLAUDE.md`, rules, or memory. Setup never edits files outside the repo. Shape to copy:

> Exception: harness pipeline stages may stage, commit and push.

**Done when** every listed file has been read, every conflict has a verdict, and no file was edited
except by an answer the user picked.

## Step 4 — Declare the project's commands

Only when `orchestrate-config` failed. Read `skills/orchestrate/references/config.md` for what every key
means and `references/orchestrate.config.example.json` for a worked example, then write
`orchestrate.config.json` at the repo root. Where the file exists, check the commands it names still
resolve and regenerate only what went stale.

Where the project has its own environment check — a `doctor`, `preflight` or `check` script, a justfile
recipe — declare it as `doctor` so Step 1 folds its rows in on every run. Do not write one.

Print what you wrote and name anything you guessed.

A `hooks` block is optional — UNSET is a fine state. When the config carries one, run
`node --experimental-strip-types <plugin-root>/skills/_shared/hooks.ts doctor` and fix entries
until no FAIL row remains — a FAIL means the pipeline will skip or halt on that hook mid-run.

## Step 5 — Report

Print the doctor's table from the last run, then one line per item still red with the command the user
runs. Add a line per Step 3 conflict: file · the directive · verdict (scoped / removed / kept) · stage
affected. A kept halting conflict is a red item — say which stage stops and that the pipeline will not
complete unattended until it is scoped.
