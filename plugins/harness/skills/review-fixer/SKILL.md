---
name: review-fixer
description: >
  Automated PR review fixer. Reads human code review comments, classifies each
  as a direct fix or orchestration task, applies fixes, runs quality gate, commits,
  pushes, and comments back on the PR. Designed to run in GitHub Actions via
  claude-code-action. Trigger when the prompt contains review comments JSON and
  asks to fix review feedback.
argument-hint: "(receives context via prompt injection from GitHub Actions workflow)"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Skill, Agent
---

# Review Fixer: Automated PR Review Response

Reads review comments from a PR, triages each as a direct fix or orchestration task, fixes the code, and comments back.

**Announce at start:** "Using the review-fixer skill to address PR review feedback."

---

## Input Parsing

Extract from the prompt context:
- **PR number** — find `PR #<number>` in the prompt
- **Repository** — find `Repository: <owner/repo>` in the prompt
- **Reviewer** — find `Reviewer: <login>` in the prompt
- **Review body** — text after `Review body:` until the next section

Store these as `PR_NUMBER`, `REPOSITORY`, `REVIEWER`, `REVIEW_BODY`.

### Fetch Review Comments

Fetch file-level review comments from the GitHub API:
```bash
gh api "repos/${REPOSITORY}/pulls/${PR_NUMBER}/comments" \
  --jq '[.[] | {id: .id, path: .path, line: (.line // .original_line), body: .body, diff_hunk: .diff_hunk}]'
```

Store the result as `COMMENTS_JSON`. Each entry has:
- `path` — file path
- `line` — line number
- `body` — reviewer's comment text
- `diff_hunk` — surrounding code context
- `id` — comment ID for replying

If the API call fails or returns an empty array, treat the review body as the sole instruction.

---

## Classification

For each comment in `COMMENTS_JSON`, classify as one of:

### DIRECT_FIX
The comment asks for a targeted change scoped to a few lines in one file.

Signals:
- Rename, typo, add validation, missing error handling
- "Change X to Y", "add null check", "this should be private"
- "Move this to...", "extract this into...", "remove this"
- Bug fix with clear solution implied

### ORCHESTRATE
The comment requires rethinking, redesigning, or multi-file architectural changes.

Signals:
- "Rethink this approach", "this whole pattern is wrong"
- "Consider using X instead of Y" (architectural shift)
- Requires new abstractions, interfaces, or significant restructuring
- Reviewer explicitly says "redesign", "rethink", "rewrite"

### QUESTION
The comment is a question, not a change request.

Signals:
- "Why did you...?", "What happens if...?", "Is this intentional?"
- No imperative action implied

Output a classification table before proceeding:

| # | File | Line | Classification | Summary |
|---|------|------|---------------|---------|
| 1 | src/auth.ts | 42 | DIRECT_FIX | Add null check for token |
| 2 | src/retry.ts | 78 | ORCHESTRATE | Redesign retry with backoff |
| 3 | src/config.ts | 15 | QUESTION | Why is this hardcoded? |

---

## Execution

### Phase 1: Direct Fixes

For each DIRECT_FIX comment:
1. Read the file at the referenced path and line
2. Understand the surrounding context from `diff_hunk`
3. Make the targeted change using Edit tool
4. Record what was changed: `{comment_id, path, lines_changed, description}`

### Phase 2: Orchestrate Items

For each ORCHESTRATE comment:
1. Invoke the orchestrate skill in auto mode:
   ```
   /orchestrate --auto "Fix review feedback: <comment body>. File: <path>, Line: <line>. Context: <diff_hunk>"
   ```
2. Record what was changed: `{comment_id, paths_changed[], description}`

If no ORCHESTRATE items exist, skip this phase.

### Phase 3: Quality Gate

After all fixes are applied:
1. Auto-detect project tooling (look for package.json, pyproject.toml, Makefile, etc.)
2. Run available checks:
   - **Typecheck:** `tsc --noEmit` / `mypy` / `pyright` (based on project)
   - **Lint:** `eslint` / `ruff` / project linter
   - **Tests:** `npm test` / `pytest` / project test command
3. If any check fails:
   - Attempt to fix (max 3 attempts per check)
   - If still failing after 3 attempts, record as failed
4. If no project tooling is detected, skip the quality gate and note "No tooling detected — quality gate skipped" in the summary
5. Track results: `{typecheck: pass/fail/skipped, lint: pass/fail/skipped, tests: pass/fail/skipped}`

### Phase 4: Commit & Push

Only commit successfully-fixed changes. If some comments failed quality gate, revert those changes before committing.

1. Stage changed files: `git add <files>`
2. Commit: `git commit -m "fix: address review feedback from @<REVIEWER>"`
3. Push: `git push`
4. Store commit SHA

### Phase 5: Comment Back

**For each comment, reply inline using `gh api`:**

For DIRECT_FIX (successful):
```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
  -f body="Fixed: <description>
Changed \`<path>\` L<lines>"
```

For ORCHESTRATE (successful):
```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
  -f body="Fixed via orchestration: <description>
Files changed: <paths>"
```

For QUESTION:
```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
  -f body="<answer to the question>"
```

For FAILED items:
```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{comment_id}/replies \
  -f body="Could not fix: <reason>. Manual attention needed."
```

**Post summary comment on PR:**
```bash
gh api repos/{owner}/{repo}/issues/{pr}/comments \
  -f body="## Review Fixes Applied

Addressed feedback from @<REVIEWER>'s review.

### Changes
| Comment | Classification | Fix |
|---------|---------------|-----|
| ... | ... | ... |

### Verification
- Typecheck: <pass/fail/skipped>
- Lint: <pass/fail/skipped>
- Tests: <pass/fail/skipped> (<count>)

Commit: \`<SHA>\`"
```

---

## Edge Cases

- **Deleted file:** If `path` references a file that doesn't exist, reply inline: "This file no longer exists in the current branch."
- **Zero comments:** If no review comments JSON, treat the review body as the instruction and apply fixes based on that.
- **All items are questions:** Reply to each, post summary saying "No code changes needed — all items were questions."
- **Partial failure:** Commit only successful fixes. Report failed items in summary with "manual attention needed."
