---
name: using-git-worktrees
description: Use when starting feature work that needs isolation from current workspace or before executing implementation plans - creates isolated git worktrees with smart directory selection and safety verification
---

# Using Git Worktrees

## Overview

Git worktrees create isolated workspaces sharing the same repository, allowing work on multiple branches simultaneously without switching.

**Core principle:** Systematic directory selection + safety verification = reliable isolation.

**Announce at start:** "I'm using the using-git-worktrees skill to set up an isolated workspace."

**First action: read `orchestrate.config.json` at the repo root.** Every command and package path this skill uses comes from it, resolved per `skills/orchestrate/references/config.md`.

---

## Directory Selection Process

Follow this priority order:

### 1. Check Existing Directories

```bash
# Check in priority order
ls -d .worktrees 2>/dev/null # Preferred (hidden)
ls -d worktrees 2>/dev/null # Alternative
```

**If found:** Use that directory. If both exist, `.worktrees` wins.

### 2. Check CLAUDE.md

```bash
grep -i "worktree.*director" CLAUDE.md 2>/dev/null
```

**If preference specified:** Use it without asking.

### 3. Default to `.worktrees/`

With no directory present and no CLAUDE.md preference, create `.worktrees/` — project-local and
hidden, the same choice priority 1 already prefers.

---

## Safety Verification

### For Project-Local Directories (.worktrees or worktrees)

**MUST verify .gitignore before creating worktree:**

```bash
# Check if directory pattern in .gitignore
grep -q "^\\.worktrees/$" .gitignore || grep -q "^worktrees/$" .gitignore
```

**If NOT in .gitignore:**

1. Add the appropriate line to .gitignore
2. Leave it unstaged and name it in what you report back — committing on the user's behalf is
   theirs to decide
3. Proceed with worktree creation

**Why critical:** Prevents accidentally committing worktree contents to repository.

### For Global Directory (~/.config/superpowers/worktrees)

No .gitignore verification needed - outside project entirely.

---

## Creation Steps

### 1. Detect Project Name

```bash
project=$(basename "$(git rev-parse --show-toplevel)")
```

### 2. Create Worktree

```bash
# Determine full path
case $LOCATION in
.worktrees|worktrees)
  path="$LOCATION/$BRANCH_NAME"
  ;;
~/.config/superpowers/worktrees/*)
  path="~/.config/superpowers/worktrees/$project/$BRANCH_NAME"
  ;;
esac

# Create worktree with new branch
git worktree add "$path" -b "$BRANCH_NAME"
cd "$path"
```

### 3. Handle Environment Files

Check for `.env*` files (`.env`, `.env.local`, `.env.development`, etc.) in the source project root. These contain local secrets, API keys, and configuration that aren't committed to git — without them the worktree often won't run.

Symlink each one into the worktree. A worktree is a temporary view of the same project, so it wants
the same secrets from the same source — an edit in either place stays true for both:

```bash
SOURCE_ROOT=$(git rev-parse --show-toplevel)

for f in "$SOURCE_ROOT"/.env*; do
  [ -f "$f" ] && ln -s "$f" "$path/$(basename "$f")"
done
```

Skip this step entirely if no `.env*` files exist — not every project uses them.

### 4. Run Project Setup

Worktrees share git objects but not installed dependencies, so install them here: the `bootstrap` command of each
package the caller named, resolved per `skills/orchestrate/references/config.md`.

**With no config:** install by the lockfile the project ships, then report that you guessed and name `setup-harness`.

### 5. Verify Clean Baseline

Run each package's `test_all` to confirm the worktree starts clean.

**If tests fail:** Report failures, ask whether to proceed or investigate.

**If tests pass:** Report ready.

### 6. Report Location

```
Worktree ready at <path>
Tests passing (<n> tests, 0 failures)
Ready to implement <feature>
```

---

## Quick Reference

| Situation | Action |
|-----------|--------|
| `.worktrees/` exists | Use it (verify .gitignore) |
| `worktrees/` exists | Use it (verify .gitignore) |
| Both exist | Use `.worktrees/` |
| Neither exists | Check CLAUDE.md → Ask user |
| Directory not in .gitignore | Add it immediately + commit |
| `.env*` files in source root | Ask: copy, symlink, or skip |
| No `.env*` files | Skip silently |
| Tests fail during baseline | Report failures + ask |
| Package declares no `bootstrap` or `test_all` | Skip that step, say so |

---

## Common Mistakes

**Skipping .gitignore verification**
- **Problem:** Worktree contents get tracked, pollute git status
- **Fix:** Always grep .gitignore before creating project-local worktree

**Assuming directory location**
- **Problem:** Creates inconsistency, violates project conventions
- **Fix:** Follow priority: existing > CLAUDE.md > ask

**Proceeding with failing tests**
- **Problem:** Can't distinguish new bugs from pre-existing issues
- **Fix:** Report failures, get explicit permission to proceed

**Hardcoding setup commands**
- **Problem:** Breaks on projects using different tools, and puts a different toolchain behind the same branch next run
- **Fix:** Run what `orchestrate.config.json` declares

---

## Example Workflow

```
You: I'm using the using-git-worktrees skill to set up an isolated workspace.
[Check .worktrees/ - exists]
[Verify .gitignore - contains .worktrees/]
[Create worktree: git worktree add .worktrees/auth -b feature/auth]
[Found .env, .env.local — user chose symlink]
[Symlinked .env, .env.local → .worktrees/auth/]
[Run the package's bootstrap]
[Run the package's test_all - 47 passing]

Worktree ready at /Users/jesse/myproject/.worktrees/auth
Symlinked 2 env files (.env, .env.local)
Tests passing (47 tests, 0 failures)
Ready to implement auth feature
```

---

## Red Flags

**Never:**
- Create worktree without .gitignore verification (project-local)
- Skip baseline test verification
- Proceed with failing tests without asking
- Assume directory location when ambiguous
- Skip CLAUDE.md check

**Always:**
- Follow directory priority: existing > CLAUDE.md > ask
- Verify .gitignore for project-local
- Run the setup the config declares
- Verify clean test baseline

---

## Integration

**Called by:**
- **planning** - REQUIRED when the plan is approved and implementation follows
- Any skill needing isolated workspace

**Pairs with:**
- **finishing-a-development-branch** - REQUIRED for cleanup after work complete
- **executing-plans** or **subagent-driven-development** - Work happens in this worktree