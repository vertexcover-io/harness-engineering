---
name: setup-harness
description: "Preflight the harness in a repo — probe for the tools, git wiring, and tracker credentials the pipeline needs, install what's missing, and hand the user the short list only they can do. Use when the user says 'set up the harness', is running a harness skill in this repo for the first time, or when a skill halts on BLOCKED:no-agent-browser or BLOCKED:no-infra, an unset tracker credential, or a standing CLAUDE.md/memory instruction that stops a pipeline stage."
argument-hint: "[optional: project root — defaults to cwd]"
allowed-tools: Bash, Read, Edit, Write, AskUserQuestion
user-invocable: true
---

# Setup Harness

A **preflight**: every item is checked, then fixed, then re-checked. Items fall in three bands, and the band sets what a red one costs:

- **Required** — the pipeline cannot start. A red one stops setup.
- **Conditionally required** — one branch needs it, and that branch **halts** without it. Red is not a warning: install it in Step 3, or Step 7 states outright which branch is blocked.
- **Degrading** — the branch finishes with less. Red is a warning, recorded and carried.

Three kinds of red, and the split decides who acts:

- **Yours** — a missing binary or a `.gitignore` line. Install or edit it in Step 3 without asking.
- **Contested** — a standing instruction in their `CLAUDE.md`, memory, or settings that countermands something the pipeline does unattended. Yours to fix, theirs to approve: propose the edit in Step 4, apply only the answer they pick.
- **Theirs** — anything holding a secret or a browser login: authentication, tokens, workspace ids. Never attempt these; collect them into the Step 6 summary.

## Step 0 — Anchor to the main repo root

Every later step reads and writes relative to the working directory, so resolve it once, first. `.gitignore` lives at the main repo root, and the memory path in Step 1 is derived from `$PWD` — run this from a worktree and both silently address the wrong tree.

```bash
R=$(git -C "${1:-$PWD}" rev-parse --show-toplevel 2>/dev/null) || { echo "not a git repo"; exit 1; }
[ "$(git -C "$R" rev-parse --git-dir)" = "$(git -C "$R" rev-parse --git-common-dir)" ] ||
  { echo "$R is a linked worktree — rerun from the main repo root"; exit 1; }
cd "$R" && pwd
```

The optional argument is the project root; with none, the current directory. The `--git-dir` vs `--git-common-dir` comparison is what distinguishes a linked worktree — they differ only inside one.

**Done when** the printed path is the main repo root and every later block runs from it.

## Step 1 — Probe

Run the checklist in one block and read the printed verdicts. Derive nothing you did not print.

```bash
p(){ printf '%-16s %s\n' "$1" "$2"; }
for t in git node npm jq curl gh agent-browser ffmpeg; do
  case $t in ffmpeg) V=-version;; *) V=--version;; esac
  if ! command -v "$t" >/dev/null 2>&1; then p "$t" MISSING
  elif v=$("$t" $V 2>&1); then p "$t" "OK ($(printf %s "$v" | head -1))"
  else p "$t" "BROKEN ($(printf %s "$v" | head -1))"; fi; done
command -v gh >/dev/null 2>&1 &&
  { gh auth status >/dev/null 2>&1 && p gh-auth OK || p gh-auth UNAUTHENTICATED; }
if command -v claude-sessions >/dev/null 2>&1; then
  claude-sessions status >/dev/null 2>&1 && p claude-sessions OK || p claude-sessions UNAUTHENTICATED
else p claude-sessions MISSING; fi
W="${ASANA_WORKSPACE_GID:-$(grep -hs '^ASANA_WORKSPACE_GID=' .env | tail -1 | cut -d= -f2-)}"
[ -n "$W" ] && p asana-workspace "OK ($W)" || p asana-workspace UNSET
if [ -n "${ASANA_PAT:-}" ]; then p asana-pat "OK (exported)"
elif grep -qs '^ASANA_PAT=' .env.harness; then p asana-pat "UNEXPORTED (present in .env.harness)"
else p asana-pat UNSET; fi
git check-ignore -q .harness/probe && p ignore-harness OK || p ignore-harness MISSING
git ls-files --error-unmatch .harness >/dev/null 2>&1 &&
  p harness-tracked "$(git ls-files .harness | wc -l | tr -d ' ') file(s) still tracked"
M=~/.claude/projects/"$(printf %s "$PWD" | tr '/.' '--')"/memory
F=$({ git ls-files -z --cached --others --exclude-standard '*CLAUDE.md' '*AGENTS.md'
      printf '%s\0' CLAUDE.local.md \
        .claude/settings.json .claude/settings.local.json \
        ~/.claude/settings.json ~/.claude/settings.local.json \
        ~/.claude/CLAUDE.md ~/.claude/rules/*.md "$M"/*.md
    } | while IFS= read -r -d '' f; do [ -f "$f" ] && printf '%s\n' "$f"; done | sort -u)
[ -n "$F" ] && printf '%s\n' "$F" | while IFS= read -r f; do p instructions "$f"; done \
             || p instructions NONE
true
```

Probe only what the harness itself runs. The stack the *project* runs on — `just`, `make`, `docker compose`, a `dev` script — is not preflighted here; Step 5 derives it from the repo and finds a missing one by failing to boot.

Required: `git`, `node`, `npm`, `jq`, `curl`, `ignore-harness`.
Conditionally required: `agent-browser` (functional-verify's UI proofs — halts on `BLOCKED:no-agent-browser`) · `gh` + `gh-auth` (code-review on a PR, orchestrate's PR stage) · `ffmpeg` (functional-verify's video build).
Degrading: `claude-sessions`, `asana-workspace`, `asana-pat` (functional-verify's publish step — it skips in one line when any is red).

**MISSING and BROKEN are different verdicts and take different repairs.** A version manager's shim satisfies `command -v` while the tool behind it is uninstalled — hence the probe verdicts on the version call's exit status, not on the binary's presence. BROKEN means the shim resolves to nothing: repair the version manager (`mise use -g <tool>`), don't reinstall over it.

`harness-tracked` prints only when files under `.harness/` are still in the index — Step 2 acts on it.

Each `instructions` line is one file Step 4 must read — that print is the read list, and `instructions NONE` is itself a verdict, not an empty result to go hunting behind.

**Done when** every line above is printed with a verdict and the block exits 0.

## Step 2 — Wire git

`.gitignore` carries `.harness/` — the whole tree, no exceptions. Every artifact the pipeline writes stays local; reviewers read them out-of-band.

Add the line if the probe printed MISSING, and remove any narrower `.harness/*` + `!…` exception lines a previous setup left behind.

**An ignore rule does not untrack.** If the probe printed `harness-tracked`, those files are in the index and stay committed no matter what `.gitignore` says — and the exception lines that kept them there are what you just removed, so the next commit that touches them is a surprise. Name the files and ask before running `git rm -r --cached .harness/`; it drops them from git while leaving them on disk, and it rewrites what the repo publishes. Untracking is theirs to approve, not yours to assume.

**Done when** `git check-ignore -q .harness/anything` exits 0 and `git ls-files .harness` is either empty or carries a recorded decision to keep those files tracked.

## Step 3 — Install what's yours

Read the platform once, then install from the matching column. Never guess the package manager:

```bash
uname -s; command -v brew apt-get dnf pacman zypper apk winget 2>/dev/null
```

| Tool | brew (macOS/Linux) | Native | Fallback |
|---|---|---|---|
| `agent-browser` | — | — | `npm i -g agent-browser && agent-browser install` |
| `ffmpeg` | `brew install ffmpeg` | `apt install ffmpeg` · `dnf install ffmpeg` · `pacman -S ffmpeg` · `winget install Gyan.FFmpeg` | — |
| `gh` | `brew install gh` | `apt install gh` · `dnf install gh` · `pacman -S github-cli` · `winget install GitHub.cli` | — |
| `jq`, `curl` | `brew install jq` | `apt install jq` · `dnf install jq` · `pacman -S jq` · `apk add jq` | — |
| `node`, `npm` | `brew install node` | the repo's version manager if one is configured (`mise`, `nvm`, `fnm`, `.node-version`, `.nvmrc`) | — |

Prefer the path that needs no `sudo`. When the only route is a system package manager that will prompt for a password, install nothing: put the exact command in the Step 6 summary and let the user run it.

`fallow` and `radon` are not preflighted — tech-debt-finder provisions them itself and records a skip when it can't. It fetches `fallow` per-run with `npx --yes`, but `radon` it *installs*: `radon --version || pip install radon`, which fails outright on an externally-managed Python (PEP 668 — the Homebrew and Debian default). On such a machine complexity checks skip every run; if the user wants them, the fix is theirs to run — `pipx install radon` — and it belongs in Step 6, not here.

**Done when** every tool Step 1 printed MISSING is either installed and re-probed OK, or listed in Step 6 with the reason it could not be installed here.

## Step 4 — Resolve contested instructions

The pipeline runs unattended: it branches, writes the failing test first, creates files, dispatches sub-agents, commits, pushes, opens a PR — stage after stage with nobody watching.

Read every file the probe printed under `instructions`, in full. Any standing instruction that would interrupt that run — a pause, a confirmation, a refusal, a ban on something a stage does — is **contested**. Judge meaning, not wording: "ask before committing," "confirm destructive actions first," and "no autonomous git" are one conflict in three phrasings, sharing no keyword. Expect directives no list anticipates; the test never changes — when this line fires mid-run with nobody there, does the run continue?

Settings outrank prose. A `permissions.deny` entry or a blocking `PreToolUse` hook is a wall, not a tendency — the stage fails outright and no reasoning recovers it. **Read the user-global pair too, not just the repo's** — `~/.claude/settings.json` and `~/.claude/settings.local.json` are where a deny list usually lives, they apply to every repo, and a wall there is invisible from inside this one. The probe lists all four; a wall in any of them counts.

Sort by cost: **halting** (the run stops, or `--auto` waits on an answer that never comes) against **friction** (a stage degrades and still finishes). Ask about the halting ones; friction goes to Step 7.

Per halting conflict, quote the line, name the stage it stops, and ask: **scope it** so the directive stands but exempts the pipeline (default), **remove it**, or **keep it** — a kept one stays red through Step 7.

Scope a **prose** conflict living outside this repo — `~/.claude/CLAUDE.md`, `~/.claude/rules/`, memory — by writing the exemption into the repo's own `CLAUDE.md`. Their other projects stay untouched: setup never edits an instruction or settings file outside the repo it was pointed at. (Step 3 installs tools globally by nature — that is not what this rule governs.)

A **settings** wall does not yield to that remedy. Prose exemptions do not override `permissions.deny` or a `PreToolUse` hook — by the paragraph above, no reasoning recovers it — and a user-global deny can only be lifted in the user-global file. So there are exactly two honest outcomes: the user edits their own settings, or the affected stage is declared blocked in Step 7. Never write a repo-local exemption and report the conflict resolved; it will still fail, just later and unattended.

**Done when** every file the probe listed has been read in full, every halting conflict has a recorded verdict, and no file was edited except by an answer the user picked.

## Step 5 — Smoke the stack

functional-verify boots the app for real. Whatever is broken there surfaces mid-orchestrate with nobody watching, as `BLOCKED:no-infra`. Find it now, cold.

Start where functional-verify starts — a project skill that brings the services up, else the repo's own configs. functional-verify's own Step 1 has the derivation; use that, don't restate it.

The stack reads its config first — a `.env`, a settings file, whatever the repo ships a template for. Check it: present, and every key the template declares actually filled, since a placeholder is as unset as a missing key. Writing those values is theirs, never yours — an invented one buys a service that starts and lies. Anything missing or half-filled goes to Step 6.

**Boot it under functional-verify's rules, not your own.** This step exists to prove fv can bring the stack up; boot it a different way and a green result proves nothing about fv. Two of its rules govern here:

- **Always start your own instance.** A port already answering is somebody else's — another worktree, the user's own dev server. Leave it alone, allocate a free port, start fresh. Record it as `already up (not ours)`; that is a pass, not the failure the old wording called it.
- **You start it, so you tear it down** — and *only* what you started. Never `compose down` a project you did not bring up, never kill a PID you did not spawn. A stack that was already running must still be running when this step ends.

Before starting anything, write down the four things a service needs to be startable — **up command, readiness URL, timeout, down command**. A declaration missing any of them is the finding; record it and start nothing. This is also what keeps a foreground server from hanging the run: a command with no down command has to be backgrounded with its PID and log captured, or it is not runnable here.

Then run what you find, exactly as declared. Readiness is a polled response, not a sleep — request the URL until it answers or the timeout expires, and assume nothing is up until one does. A start command nobody has run since it was written is a failure you inherit at verify time.

A failure here is a finding, not a fix — a credential, a missing image, a stale target. Anything you could not bring up, or brought up only by hand, goes to Step 6 with the command and the last lines it printed. If no stack skill exists, say so: without one, functional-verify re-derives the boot procedure on every run.

**Done when** every service the stack declares has answered on a route it serves — started here or already up and left alone — or is recorded with the command that failed and its output, and every process this step started has been torn down while every process it did not start is still running.

## Step 6 — Hand the rest to the user

Secrets and logins are theirs. Print a numbered list of exactly the ones still red, each with the command to run — and stop there. Attempt none of them.

| Item | What to tell them |
|---|---|
| `claude-sessions` MISSING | Install the CLI, then `claude-sessions login --server <url>` and `claude-sessions install-hooks`. Ask for the server URL — there is no default to guess. |
| `claude-sessions` UNAUTHENTICATED | Run `claude-sessions login --server <url>` — it opens a browser pairing flow. |
| `asana-workspace` UNSET | Open Asana, copy the workspace GID from the URL, and add `ASANA_WORKSPACE_GID=<gid>` to the repo-root `.env` — that is where publish reads it from. |
| `asana-pat` UNSET | The token goes in repo-root **`.env.harness`** (gitignored, `chmod 600`) — never `.env`, never a committed file. That is the repo-wide credential convention; `library-probe` documents the file. |
| `asana-pat` UNEXPORTED | The token is in `.env.harness` but publish reads `$ASANA_PAT` from the **environment**, with no file fallback — unlike the GID. Source the file into the shell that runs the pipeline, or the publish step will skip with the token sitting right there. |
| `gh-auth` UNAUTHENTICATED | Run `gh auth login` — interactive. |
| a tool printed BROKEN | Their version manager resolves the name to nothing. Give the repair for the manager in play — `mise use -g <tool>`, `asdf install <tool>` — not a reinstall, which leaves the shim just as empty. |
| any tool needing `sudo` | Give the exact one-liner from Step 3 for their platform. |
| a settings wall from Step 4 | Quote the `permissions.deny` entry or hook and the file it lives in. Only they can edit it, and no repo-local exemption substitutes — say which stage stays blocked until they do. |
| a service that would not start | Quote the command and its output, and name what only they can supply — a credential, a login, an image, a free port. |

**Done when** every red item from Steps 3 and 5 has a line here with a runnable command, and nothing on this list was attempted.

## Step 7 — Report

Re-run the Step 1 block and print the result as a table: item · verdict · band · what it unblocks. Close with the pipeline's entry point — `/orchestrate "<task>"`.

Then one line per item still red, and the band decides the wording. A **conditionally required** item does not degrade, it stops a branch — say so in those words (`agent-browser` red → functional-verify halts on `BLOCKED:no-agent-browser`; `gh-auth` red → the PR stage cannot open a PR; `ffmpeg` red → the video build has no fallback and the report links at files that were never written). A **degrading** item names what thins out instead (`claude-sessions` or `asana-pat` red → publish skips in one line).

Add a second table for Step 4: file · the directive · verdict (scoped / removed / kept) · stage affected. A kept halting conflict is a red item — say which stage stops and that the pipeline will not complete unattended until it is scoped.

Add a line per service the stack declares: up, or down with the stage it costs — a service still down means functional-verify exits `BLOCKED:no-infra`.

**Done when** both tables account for every item from Step 1, every declared service has a verdict, and no required item or kept halting conflict is left unstated.
