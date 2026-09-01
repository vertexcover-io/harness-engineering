---
name: setup-harness
description: "Preflight the harness in a repo — probe for the tools, git wiring, and tracker credentials the pipeline needs, install what's missing, write the project's `orchestrate.config.json`, and hand the user the short list only they can do. Use when the user says 'set up the harness', is running a harness skill in this repo for the first time, when a stage halts because `orchestrate.config.json` is missing or one of its commands no longer resolves, or when a skill halts on BLOCKED:no-agent-browser or BLOCKED:no-infra, an unset tracker credential, or a standing CLAUDE.md/memory instruction that stops a pipeline stage."
argument-hint: "[optional: project root — defaults to cwd]"
allowed-tools: Bash, Read, Edit, Write, AskUserQuestion
user-invocable: true
---

# Setup Harness

A **preflight**: every item is checked, then fixed, then re-checked. Items are **required** (the pipeline cannot run without them) or **on-demand** (only one branch of the pipeline needs them — a missing one is a warning, never a halt).

Three kinds of red, and the split decides who acts:

- **Yours** — a missing binary or a `.gitignore` line. Install or edit it in Step 3 without asking.
- **Contested** — a standing instruction in their `CLAUDE.md`, memory, or settings that countermands something the pipeline does unattended. Yours to fix, theirs to approve: propose the edit in Step 5, apply only the answer they pick.
- **Theirs** — anything holding a secret or a browser login: authentication, tokens, workspace ids. Never attempt these; collect them into the Step 7 summary.

Run every step from the **main repo root**, not a worktree — `git rev-parse --show-toplevel`. `.gitignore` lives there.

## Step 1 — Probe

Run the checklist in one block and read the printed verdicts. Derive nothing you did not print.

```bash
p(){ printf '%-16s %s\n' "$1" "$2"; }
for t in git node jq curl gh just mani agent-browser; do
  command -v $t >/dev/null && p $t "OK ($($t --version 2>&1|head -1))" || p $t MISSING; done
for w in wt git-wt; do command -v $w >/dev/null && { p wt "OK ($($w --version 2>&1|head -1) as $w)"; break; }; done
command -v wt >/dev/null || command -v git-wt >/dev/null || p wt MISSING
if command -v claude-sessions >/dev/null 2>&1; then
  claude-sessions status >/dev/null 2>&1 && p claude-sessions OK || p claude-sessions UNAUTHENTICATED
else p claude-sessions MISSING; fi
W="${ASANA_WORKSPACE_GID:-$(grep -hs '^ASANA_WORKSPACE_GID=' .env | tail -1 | cut -d= -f2-)}"
[ -n "$W" ] && p asana-workspace "OK ($W)" || p asana-workspace UNSET
jq -e .tracker orchestrate.config.json >/dev/null 2>&1 && p tracker configured || p tracker UNSET
grep -qxF '.harness/' .gitignore 2>/dev/null && p ignore-harness OK || p ignore-harness MISSING
[ -f orchestrate.config.json ] && p orchestrate-config OK || p orchestrate-config MISSING
M=~/.claude/projects/"$(printf %s "$PWD" | tr '/.' '--')"/memory
for f in $(git ls-files '*CLAUDE.md' '*AGENTS.md') CLAUDE.local.md \
         .claude/settings.json .claude/settings.local.json \
         ~/.claude/CLAUDE.md ~/.claude/rules/*.md "$M"/*.md; do
  [ -f "$f" ] && p instructions "$f"; done
```

Required: `git`, `node`, `jq`, `curl`, `ignore-harness`, `orchestrate-config`.
On-demand: `just`, `mani`, `wt` (the repo's own task/multi-repo/worktree commands) · `agent-browser` (functional-verify's UI proofs) · `gh` (code-review on a PR, orchestrate's PR stage) · `claude-sessions` and `asana-workspace` (functional-verify's publish step, best-effort — it skips in one line when either is red) · `tracker` (the tracker bridge: ticket fetch, PR link, status moves, attachments — every call self-skips in one line when UNSET).

The `wt` line reports which name answered — on Windows worktrunk installs as `git-wt`, since Windows Terminal owns `wt`.

Each `instructions` line is one file Step 5 must read — that print is the read list.

**Done when** every line above is printed with a verdict.

## Step 2 — Wire git

`.gitignore` carries `.harness/` — the whole tree, no exceptions. Every artifact the pipeline writes stays local; reviewers read them out-of-band.

Add the line if the probe printed MISSING, and remove any narrower `.harness/*` + `!…` exception lines a previous setup left behind.

**Done when** `git check-ignore .harness/anything` exits 0.

## Step 3 — Install what's yours

Read the platform once, then install from the matching column. Never guess the package manager:

```bash
uname -s; command -v brew apt-get dnf pacman zypper apk winget 2>/dev/null
```

| Tool | brew (macOS/Linux) | Native | Fallback |
|---|---|---|---|
| `just` | `brew install just` | `apt install just` (Debian 13+/Ubuntu 24.04+) · `pacman -S just` · `winget install --id Casey.Just --exact` | `cargo install just` |
| `mani` | `brew tap alajmo/mani && brew install mani` | `yay -S mani` (AUR) · `port install mani` | `curl -sfL https://raw.githubusercontent.com/alajmo/mani/main/install.sh \| sh` |
| `wt` (worktrunk) | `brew install worktrunk` | `pacman -S worktrunk` · `winget install max-sixty.worktrunk` | `cargo install worktrunk` |
| `agent-browser` | — | — | `npm i -g agent-browser && agent-browser install` |
| `gh` | `brew install gh` | `apt install gh` · `dnf install gh` · `pacman -S github-cli` · `winget install GitHub.cli` | — |
| `jq`, `curl` | `brew install jq` | `apt install jq` · `dnf install jq` · `pacman -S jq` · `apk add jq` | — |
| `node` | `brew install node` | the repo's version manager if one is configured (`mise`, `nvm`, `fnm`, `.node-version`, `.nvmrc`) | — |

After installing worktrunk, run `wt config shell install` — it wires the shell integration the CLI needs.

Prefer the path that needs no `sudo`. When the only route is a system package manager that will prompt for a password, install nothing: put the exact command in the Step 7 summary and let the user run it.

`fallow` and `radon` need no install — tech-debt-finder fetches them on demand and skips cleanly when offline.

**Done when** every tool Step 1 printed MISSING is either installed and re-probed OK, or listed in Step 7 with the reason it could not be installed here.

## Step 4 — Declare the project's commands

`orchestrate.config.json` at the repo root, written once. Take its shape from
`skills/orchestrate/references/orchestrate.config.example.json` — every block a project can carry is
in there. Where the probe printed OK, check the commands already in it still resolve and regenerate
only what went stale.

Fill it from `CLAUDE.md` first, then the manifest (`package.json`, `pyproject.toml`/`setup.py`,
`go.mod`, `Cargo.toml`), then the runner off the test script for the scoped forms:

| runner | `test_file` template | scopes by file? |
|--------|----------------------|-----------------|
| vitest | `<test_all> {FILE}` | yes |
| jest | `<test_all> --testPathPattern={FILE}` | yes |
| node-test | `node --test {FILE}` | yes |
| pytest | `pytest {FILE}` | yes |
| go | `go test ./$(dirname {FILE})/...` | by package |
| cargo | `<test_all>` — filters by name, not file | no |
| unknown | `<test_all>` | no |

`lint_file` takes the same shape where the linter accepts a path (`eslint {FILE}`). Where the runner
does not scope, `test_file` equals `test_all` — a wrapper that swallows a trailing argument counts as
not scoping.

**Omit a command the project lacks rather than nulling it**, `test_file` excepted: the table above
writes the unscoped command rather than dropping the key.

**Declare every `environments` step the project has a command for**, each key named for what its
step does. Seeding and authentication usually exist as scripts and go undeclared, and each one
omitted is prose a verification run rediscovers by hand.

**Notifications are opt-in.** Ask whether the pipeline should report its progress to a chat
provider. Omit the `notifier` block when the answer is no. When it is yes, add
`"notifier": { "enabled": true, "provider": "<name>" }`, then send one test notification:

```
node --experimental-strip-types <plugin-root>/skills/_shared/notify.ts --event run-started --title setup-check --body "Notifier check from setup-harness."
```

It prints a reference on success. On failure it names the exact credential it needs. Put that
credential in `.env` at the repo root, never in `orchestrate.config.json`, because that file is
committed. A red credential is theirs to supply — record it in Step 7.

`slack` needs three: `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and `SLACK_MEMBER_ID` (the run owner's
member ID). Ask for all three before the test send.

**The tracker is opt-in the same way.** Ask whether the project's tickets should follow the run
(fetched as input, PR linked, status moved, artifacts attached). When the answer is no, omit the
`tracker` block. When it is yes, write it — provider, `resolve.pattern`, `states`, and any `on`
bindings, shapes in `skills/orchestrate/references/config.md` — then validate it:

```
node --experimental-strip-types <plugin-root>/skills/_shared/tracker.ts doctor
```

Fix every FAIL row yourself where you can (a pattern that does not compile, a misspelled provider);
a FAIL naming a credential is theirs — the key goes in `.env` at the repo root, never in
`orchestrate.config.json`, and the item goes to Step 7. Re-run doctor until only OK/WARN rows
remain, and quote any WARN rows in Step 8.

**Print what you wrote and name anything you guessed** — this file is committed, so a wrong command
here is wrong on every run after.

**Done when** `jq -e .` parses it and every command it names resolves.

## Step 5 — Resolve contested instructions

The pipeline runs unattended: it branches, writes the failing test first, creates files, dispatches sub-agents, commits, pushes, opens a PR — stage after stage with nobody watching.

Read every file the probe printed under `instructions`, in full. Any standing instruction that would interrupt that run — a pause, a confirmation, a refusal, a ban on something a stage does — is **contested**. Judge meaning, not wording: "ask before committing," "confirm destructive actions first," and "no autonomous git" are one conflict in three phrasings, sharing no keyword. Expect directives no list anticipates; the test never changes — when this line fires mid-run with nobody there, does the run continue?

`.claude/settings.json` outranks prose. A `permissions.deny` entry or a blocking `PreToolUse` hook is a wall, not a tendency — the stage fails outright and no reasoning recovers it.

Sort by cost: **halting** (the run stops, or `--auto` waits on an answer that never comes) against **friction** (a stage degrades and still finishes). Ask about the halting ones; friction goes to Step 8.

Per halting conflict, quote the line, name the stage it stops, and ask: **scope it** so the directive stands but exempts the pipeline (default), **remove it**, or **keep it** — a kept one stays red through Step 8.

Scope a conflict living outside this repo — `~/.claude/CLAUDE.md`, `~/.claude/rules/`, memory — by writing the exemption into the repo's own `CLAUDE.md`. Repo-local wins here and their other projects stay untouched; setup never mutates state outside the repo it was pointed at.

**Done when** every file the probe listed has been read in full, every halting conflict has a recorded verdict, and no file was edited except by an answer the user picked.

## Step 6 — Smoke the stack

functional-verify boots the app for real. Whatever is broken there surfaces mid-orchestrate with nobody watching, as `BLOCKED:no-infra`. Find it now, cold.

Start where functional-verify starts — a project skill that brings the services up, else the repo's own configs. functional-verify's own Step 1 has the derivation; use that, don't restate it.

The stack reads its config first — a `.env`, a settings file, whatever the repo ships a template for. Check it: present, and every key the template declares actually filled, since a placeholder is as unset as a missing key. Writing those values is theirs, never yours — an invented one buys a service that starts and lies. Anything missing or half-filled goes to Step 7.

Then run what you find, exactly as declared — a justfile target, a compose file, a start script. Bring the infra up, bring the services up, and fetch a route each one serves. A start command nobody has run since it was written is a failure you inherit at verify time; assume nothing is up until a response says so. Tear down what you started.

A failure here is a finding, not a fix — credentials, a missing image, a stale target, a port already held. Anything you could not bring up, or brought up only by hand, goes to Step 7 with the command and what it printed. If no stack skill exists, say so: without one, functional-verify re-derives the boot procedure on every run.

**Done when** every service the stack declares is up and has answered on a route it serves, or is recorded with the command that failed and its output — and everything started here is torn down.

## Step 7 — Hand the rest to the user

Secrets and logins are theirs. Print a numbered list of exactly the ones still red, each with the command to run — and stop there. Attempt none of them.

| Item | What to tell them |
|---|---|
| `claude-sessions` MISSING | Install the CLI, then `claude-sessions login --server <url>` and `claude-sessions install-hooks`. Ask for the server URL — there is no default to guess. |
| `claude-sessions` UNAUTHENTICATED | Run `claude-sessions login --server <url>` — it opens a browser pairing flow. |
| `asana-workspace` UNSET | Open Asana, copy the workspace GID from the URL, and add `ASANA_WORKSPACE_GID=<gid>` to the repo-root `.env`. The `ASANA_PAT` token goes there too. |
| `gh` present but unauthenticated | Run `gh auth login` — interactive. |
| `tracker` doctor FAIL on a credential | Quote the doctor line — it names the exact key (`ASANA_PAT`, `LINEAR_API_KEY`, `JIRA_API_TOKEN`, …). The value goes in the repo-root `.env`. |
| any tool needing `sudo` | Give the exact one-liner from Step 3 for their platform. |
| a service that would not start | Quote the command and its output, and name what only they can supply — a credential, a login, an image, a free port. |

**Done when** every red item from Steps 3 and 5 has a line here with a runnable command, and nothing on this list was attempted.

## Step 8 — Report

Re-run the Step 1 block and print the result as a table: item · verdict · what it unblocks. Close with the pipeline's entry point — `/orchestrate "<task>"` — and one line per on-demand item still red, naming the skill that will degrade when it is reached (`agent-browser` red → functional-verify halts on `BLOCKED:no-agent-browser`; `claude-sessions` red → publish skips).

Add a second table for Step 5: file · the directive · verdict (scoped / removed / kept) · stage affected. A kept halting conflict is a red item — say which stage stops and that the pipeline will not complete unattended until it is scoped.

Add a line per service the stack declares: up, or down with the stage it costs — a service still down means functional-verify exits `BLOCKED:no-infra`.

**Done when** both tables account for every item from Step 1, every declared service has a verdict, and no required item or kept halting conflict is left unstated.
