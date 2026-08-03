---
name: setup-harness
description: "Preflight the harness in a repo — probe for the tools, git wiring, and tracker credentials the pipeline needs, install what's missing, and hand the user the short list only they can do. Use when the user says 'set up the harness', is running a harness skill in this repo for the first time, or when a skill halts on BLOCKED:no-agent-browser or an unset tracker credential."
argument-hint: "[optional: project root — defaults to cwd]"
allowed-tools: Bash, Read, Edit, Write, AskUserQuestion
user-invocable: true
---

# Setup Harness

A **preflight**: every item is checked, then fixed, then re-checked. Items are **required** (the pipeline cannot run without them) or **on-demand** (only one branch of the pipeline needs them — a missing one is a warning, never a halt).

Two kinds of red, and the split decides who acts:

- **Yours** — a missing binary or a `.gitignore` line. Install or edit it in Step 3 without asking.
- **Theirs** — anything holding a secret or a browser login: authentication, tokens, workspace ids. Never attempt these; collect them into the Step 4 summary.

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
grep -qxF '.harness/' .gitignore 2>/dev/null && p ignore-harness OK || p ignore-harness MISSING
```

Required: `git`, `node`, `jq`, `curl`, `ignore-harness`.
On-demand: `just`, `mani`, `wt` (the repo's own task/multi-repo/worktree commands) · `agent-browser` (functional-verify's UI proofs) · `gh` (code-review on a PR, orchestrate's PR stage) · `claude-sessions` and `asana-workspace` (functional-verify's publish step, best-effort — it skips in one line when either is red).

The `wt` line reports which name answered — on Windows worktrunk installs as `git-wt`, since Windows Terminal owns `wt`.

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

Prefer the path that needs no `sudo`. When the only route is a system package manager that will prompt for a password, install nothing: put the exact command in the Step 4 summary and let the user run it.

`fallow` and `radon` need no install — tech-debt-finder fetches them on demand and skips cleanly when offline.

**Done when** every tool Step 1 printed MISSING is either installed and re-probed OK, or listed in Step 4 with the reason it could not be installed here.

## Step 4 — Hand the rest to the user

Secrets and logins are theirs. Print a numbered list of exactly the ones still red, each with the command to run — and stop there. Attempt none of them.

| Item | What to tell them |
|---|---|
| `claude-sessions` MISSING | Install the CLI, then `claude-sessions login --server <url>` and `claude-sessions install-hooks`. Ask for the server URL — there is no default to guess. |
| `claude-sessions` UNAUTHENTICATED | Run `claude-sessions login --server <url>` — it opens a browser pairing flow. |
| `asana-workspace` UNSET | Open Asana, copy the workspace GID from the URL, and add `ASANA_WORKSPACE_GID=<gid>` to the repo-root `.env`. The `ASANA_PAT` token goes there too. |
| `gh` present but unauthenticated | Run `gh auth login` — interactive. |
| any tool needing `sudo` | Give the exact one-liner from Step 3 for their platform. |

**Done when** every red item from Step 3 has a line here with a runnable command, and nothing on this list was attempted.

## Step 5 — Report

Re-run the Step 1 block and print the result as a table: item · verdict · what it unblocks. Close with the pipeline's entry point — `/orchestrate "<task>"` — and one line per on-demand item still red, naming the skill that will degrade when it is reached (`agent-browser` red → functional-verify halts on `BLOCKED:no-agent-browser`; `claude-sessions` red → publish skips).

**Done when** the table accounts for every item from Step 1, with no required item red.
