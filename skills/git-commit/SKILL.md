---
name: git-commit
description: "Analyzes dirty working trees, groups related changes into logical commits using hunk-level staging, and writes conventional commit messages with proper prefixes (feat, fix, refactor, etc.). Triggers when committing code, staging changes, splitting changes into commits, or organizing git changes. Use whenever the user says 'commit', 'commit this', 'commit my changes', 'create commits', 'split into commits', 'stage and commit', or asks for help with their git changes. Does not handle branch management, rebasing, merging, or pushing."
---

# Git Commit

Analyze a dirty working tree, understand the intent behind changes, group related modifications into logical commits, and write well-formed commit messages.

## Principles

1. **Never blindly `git add .`** — evaluate every file and hunk before staging.
2. **Never auto-commit untracked files** — include them in the commit plan only when they clearly belong to a change (e.g., a new test file alongside its implementation). Otherwise leave them out silently. If any untracked files are ambiguous, mention them all in a single question — never ask about each file individually.
3. **One logical concern per commit** — a single file may contribute hunks to different commits. A single commit may span multiple files.
4. **Tests and implementation travel together** — if a test and its corresponding source both changed for the same feature/fix, they belong in one commit.
5. **When in doubt, ask** — ambiguous hunks, mixed concerns, unclear intent: ask the user.

## Workflow

### Step 1: Reconnaissance

Gather the full picture before making decisions.

```bash
git status --porcelain
git diff -U5
git diff --cached --stat
git log --oneline -10
```

Also check for commit convention configs (`commitlint.config.*`, `.czrc`, `CONTRIBUTING.md`). Match whatever conventions the project already uses — consistency with the repo matters more than any spec.

Classify every path: modified tracked files, untracked files, deletions, already-staged changes, binaries, submodules.

### Step 2: Understand Intent

Read the diffs and figure out what the developer was trying to do. Start with test files — test names are the strongest signal for intent (`test('should reject invalid email')` tells you this is about email validation).

Then read implementation diffs. Use file proximity as a grouping signal — changes in the same module/directory usually belong together unless the diff shows otherwise.

### Step 3: Group Changes Into Commits

Each commit should represent one logical concern. Grouping priorities:

1. **Feature + its tests = one commit.**
2. **Refactor is separate from feature.** Restructured code AND new behavior → split them.
3. **Config/tooling changes are separate** unless inseparable from a feature.
4. **Dependency updates are separate** unless a new dep is required by a feature in the same commit.
5. **Bug fixes are atomic.** A fix and its regression test = one commit.
6. **Lock files travel with their manifest.** Never commit a lock file separately.

When a single file has mixed concerns, use hunk-level staging to split it across commits. See `references/hunk-staging.md` for techniques.

**Present the plan before executing.** Show which files/hunks go into each commit, note anything ambiguous. If untracked files exist that don't obviously belong to any commit, list them once at the end of the plan and ask. Wait for user confirmation.

### Step 4: Execute Commits

For each commit in the approved plan, in order:

1. Stage the relevant files/hunks (use `git add <file>` for whole files, patch-based staging for partial files)
2. Verify with `git diff --cached --stat`
3. Commit using HEREDOC format for proper formatting:

```bash
git commit -m "$(cat <<'EOF'
<type>(<scope>): <short description>

<optional body — explain WHY if not obvious>
EOF
)"
```

After all commits, show `git log --oneline -N` as a summary.

Respect any already-staged changes — incorporate them into the plan rather than unstaging them.

## Commit Message Format

Follow [Conventional Commits](https://www.conventionalcommits.org/).

### Prefixes

| Type       | When to use                                                  |
|------------|--------------------------------------------------------------|
| `feat`     | New feature or capability for the user/system                |
| `fix`      | Bug fix — something was broken, now it's not                 |
| `refactor` | Code restructuring with no behavior change                   |
| `test`     | Adding or updating tests only (no production code change)    |
| `docs`     | Documentation, comments, README changes only                 |
| `chore`    | Build config, deps, tooling, CI scripts, housekeeping        |
| `style`    | Formatting, whitespace, semicolons — no logic change         |
| `perf`     | Performance improvement with no behavior change              |
| `ci`       | CI/CD pipeline configuration changes                         |
| `revert`   | Reverting a previous commit                                  |

### Classifying Changes

```
Did behavior change?
├── No  → Did code structure change?
│         ├── Yes → refactor
│         └── No  → Formatting only? → style
│                   Docs/comments only? → docs
│                   Config/deps? → chore
│                   CI/CD? → ci
│                   Tests only? → test
└── Yes → New capability?
          ├── Yes → feat
          └── No  → Was old behavior wrong/broken?
                    ├── Yes → fix
                    └── No  → Faster? → perf
                              Otherwise → feat
```

### Rules

- **Imperative mood**: "add validation" not "added validation"
- **Lowercase** first letter, no trailing period
- **Max 72 characters** for the subject line (type + scope + colon + space + description)
- **Scope** from module/directory/feature area (`auth`, `api`, `web`). Check `git log` for existing scope conventions.
- **Body** only when the "why" isn't obvious. Explain motivation/tradeoffs, not line-by-line changes.
- **Footer**: `BREAKING CHANGE: <desc>` for breaking changes, `Refs: #123` / `Closes: #456` for issues.

## Edge Cases

- **Generated files** (compiled output, timestamped migrations): flag them, they might be accidental.
- **Large changesets (50+ files)**: batch by directory/module, propose high-level grouping first, suggest multiple PRs.
- **Already-staged changes**: ask whether to incorporate or leave as-is.
- **Monorepo**: use package name as scope (`feat(api): ...`, `fix(web): ...`).

## Scope Boundaries

This skill creates commits from the current working tree. It does not manage branches, rebase, squash, amend, push, or force-add ignored files.
