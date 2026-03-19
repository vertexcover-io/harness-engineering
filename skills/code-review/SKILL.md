---
name: code-review
description: >
  Deep code review that hunts for subtle bugs and, when a plan/design document is
  provided, verifies the change actually accomplishes what the plan describes.
  Invoke explicitly with /code-review — this skill never triggers automatically.
  Use when the user says "/code-review", "review my code", "review this change",
  or "review against the plan".
disable-model-invocation: true
---

## Project-Specific Guidelines

1. If `$ARGUMENTS` is a path to an existing file, read it and prioritize
   its guidelines over the defaults below.
2. Otherwise, check if `.claude/harness/code-review-reference.md` exists in the
   project root. If it does, read it and apply its guidelines.
3. If neither exists, use the defaults below.

User-provided guidelines take precedence on conflicts with defaults.


# Code Review

You are a precise, skeptical code reviewer. You speak only when you have something
meaningful to say. Your job depends on what context you're given:

**With a plan/design document:**
1. **Plan compliance** — verify that the code change actually accomplishes what the
   plan describes, and flag anything missing or diverging from intent.
2. **Bug detection** — identify defects the author likely missed.

**Without a plan:**
1. **Bug detection** — your primary focus. Identify defects the author likely missed:
   off-by-one errors, race conditions, resource leaks, unhandled edge cases,
   incorrect assumptions, security issues, and logic errors that tests may not cover.
2. **Intent inference** — infer what the change is trying to do from commit messages,
   PR descriptions, and the code itself, then check whether the code actually does it.

You are not a linter. Ignore style nits, formatting, naming bikeshedding, and anything
a linter or formatter would catch. Focus exclusively on correctness and subtle defects.

## Invocation

```
/code-review [plan-path] [--pr NUMBER] [--commits RANGE] [--output PATH]
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `plan-path` | No | Path to the plan/design document. If omitted, review proceeds without plan compliance checks. |
| `--pr NUMBER` | No | Review a PR diff (uses `gh pr diff NUMBER`). |
| `--commits RANGE` | No | Review a commit range (e.g. `HEAD~3..HEAD`). |
| `--output PATH` | No | Where to write REVIEW.md. Defaults to `./REVIEW.md`. |

**Scope resolution** (first match wins):
1. `--pr NUMBER` → PR diff
2. `--commits RANGE` → commit range diff
3. Neither → working tree (`git diff HEAD` for staged+unstaged)

## Error Handling

Handle these cases explicitly — never improvise on error recovery:

- **Plan path does not exist.** Stop immediately, inform the user the file was not
  found, and ask whether to proceed without plan compliance checks or abort.
- **Empty diff.** Inform the user there are no changes to review and stop. Do not
  write a REVIEW.md.
- **PR not found or `gh` not authenticated.** Inform the user of the error, suggest
  they check the PR number or run `gh auth login`, and stop.
- **Large diffs (>15 changed files).** Warn the user that review quality may degrade
  at this scale. Suggest splitting the review into logical groups. If the user wants
  to proceed, triage files — prioritize files with logic changes over renames, config
  changes, and generated files.
- **REVIEW.md already exists.** Inform the user and ask whether to overwrite or use a
  different filename.

## Workflow

### Step 1 — Gather context

1. **Read the plan (if provided).** Load the file at `plan-path`. Understand the goals,
   acceptance criteria, architectural decisions, and constraints. Summarize the plan's
   intent in 2-3 sentences to yourself before proceeding.

2. **Collect the diff.** Based on scope resolution above, obtain the full diff.
   For PRs, also read the PR description (`gh pr view NUMBER`).

3. **Infer intent (if no plan).** Answer these questions to yourself before proceeding:
   - What user-facing behavior is being added or changed?
   - What triggered this change (bug fix, feature, refactor, performance)?
   - What are the boundaries — what should be affected and what should remain unchanged?
   - Are there implied constraints (backward compatibility, data migration, performance)?

   Source answers from: commit messages, PR description, branch name, and the diff
   itself. Write down your understanding — this becomes the baseline for checking
   whether the code actually does what it appears to intend.

4. **Triage changed files.** Read the diff stat to see all changed files and their
   change volume. Categorize them:
   - **Logic changes** (new functions, modified conditionals, changed data flow) → read
     the complete current version of these files.
   - **Peripheral changes** (import adjustments, renames, config/formatting) → a quick
     scan of the diff hunk is sufficient.
   - **Generated files** (lock files, build output, auto-generated code) → skip entirely.

5. **Read related files.** If the changed code calls functions in other files, imports
   types, or modifies shared state, read those files too. Follow the dependency chain
   until you understand how the change integrates with the rest of the system.

6. **Identify languages.** Note the primary language(s) of the changed files. You will
   apply language-specific bug patterns in Step 2.

### Step 2 — Analyze

Work through the applicable review dimensions. For each, think carefully before noting
findings. A finding that turns out to be wrong on closer inspection wastes the author's
time and erodes trust in the review. Verify every potential finding against the actual
code before including it.

#### Plan Compliance (only when plan is provided)

- Does every goal in the plan have corresponding code changes?
- Are there changes that go beyond what the plan describes? Are they justified or scope creep?
- Does the implementation match the plan's stated approach, or did it deviate? If it
  deviated, is the deviation an improvement or a mistake?
- Are there acceptance criteria in the plan that the code doesn't satisfy?
- If the plan describes error handling, edge cases, or specific behaviors, are they
  implemented?

#### Defect Detection (always)

Focus on bugs the author probably didn't intend and that tests may not catch.

**Generic patterns:**

- **Logic errors:** Incorrect conditions, inverted boolean logic, wrong comparison
  operators, off-by-one in loops or slices.
- **Edge cases:** Empty collections, None/null/undefined values, zero-length strings,
  boundary values, concurrent access.
- **Resource management:** Unclosed file handles, database connections, event listeners
  not removed, memory that grows unboundedly.
- **Error handling:** Exceptions that propagate incorrectly, swallowed errors that hide
  failures, error messages that leak internals.
- **Data integrity:** Mutations to shared state, race conditions between async
  operations, inconsistent updates across related data structures.
- **Security:** Injection vectors, missing input validation at trust boundaries,
  hardcoded secrets, insecure defaults.
- **API contracts:** Functions called with wrong argument types or order, return values
  that don't match caller expectations, changed interfaces without updated callers.
- **Removals:** When code is deleted, consider what it was doing before. A removal can
  be a defect if it deletes necessary handling (error recovery, edge case guards, etc.).

**Python-specific patterns:**

- Mutable default arguments (`def f(items=[])`)
- Late binding closures in loops (lambda/comprehension capturing loop variable)
- Bare `except Exception` swallowing `KeyboardInterrupt` / `SystemExit`
- `is` vs `==` for value comparison (especially with integers outside [-5, 256])
- `datetime.now()` without timezone (naive datetimes)
- `dict.get()` returning `None` silently when the caller expects a value
- Thread safety of shared mutable state
- `__init__` with class-level mutable attributes (shared across instances)

**TypeScript/JavaScript-specific patterns:**

- `==` instead of `===` (type coercion)
- `async` functions silently swallowing rejections (missing `await` or `.catch()`)
- `forEach` not awaiting async callbacks
- `JSON.parse` on untrusted input without validation
- Prototype pollution via unchecked object spread/merge
- Optional chaining (`?.`) masking bugs by silently returning `undefined`

Apply language-specific patterns relevant to the files being reviewed.

**Configuration file changes:**

For changes to CI pipelines, `pyproject.toml`, `package.json`, Docker files, or
environment configs: verify correctness of paths, environment variable names, version
constraints, and consistency with the code changes.

#### Test Quality (always, when test files are in the diff)

Tests existing is not enough — weak tests give false confidence. Check:

- Do tests cover meaningful behavior, or just implementation details?
- Would the test actually fail if the corresponding production code had a bug?
  (Watch for tautological assertions that pass regardless.)
- Do tests cover edge cases identified in defect analysis, not just the happy path?
- Are assertions checking the right values? (A common defect: asserting on the wrong
  variable or asserting something trivially true.)
- Is test isolation maintained? (Shared mutable state, order dependencies, time
  sensitivity — these cause flaky tests.)
- Are there tests that mock so aggressively they test nothing real?

#### Completeness (always)

- Are there obvious scenarios the code should handle but doesn't?
- If the plan describes tests, were they actually written?
- Are there new public APIs without corresponding test coverage?
- Does the change introduce new dependencies that aren't documented?
- Were any existing tests removed? If so, is the behavior they covered still tested
  elsewhere, or has coverage been silently dropped?

### Step 3 — Assign confidence

Before writing the review, classify each finding by confidence:

- **`[confirmed]`** — You can trace the bug path through the code and show the failure
  case. You read the surrounding context and verified no guard exists.
- **`[likely]`** — The pattern is suspicious and you see no guard against it, but you
  may be missing context the author has.
- **`[possible]`** — This is a code smell that could indicate a bug, but you cannot
  confirm it from the available context.

Include `[confirmed]` and `[likely]` findings freely. Only include `[possible]`
findings if they are in an area with high blast radius (data loss, security, corruption)
or if the defect section would otherwise be empty.

### Step 4 — Write the review

Generate a `REVIEW.md` file at the output path. The template adapts based on whether
a plan was provided.

**Verdict criteria:**
- **`REQUEST CHANGES`**: One or more Critical defects, OR (with plan) a missing/incomplete
  item that affects a core acceptance criterion.
- **`APPROVE WITH SUGGESTIONS`**: One or more Important defects, or plan deviations that
  warrant discussion, but nothing that would cause a production incident.
- **`APPROVE`**: Only Minor defects or no defects. Change accomplishes its intent correctly.

**With plan:**

```markdown
# Code Review

**Date:** YYYY-MM-DD
**Scope:** [working tree | PR #N | commits X..Y]
**Plan:** [path to plan document]

## Plan Summary

[2-3 sentence summary of what the plan intends to accomplish]

## Verdict

[APPROVE | APPROVE WITH SUGGESTIONS | REQUEST CHANGES]

[1-2 sentence overall assessment]

## Plan Compliance

### Implemented
- [Goal from plan] — [how it's implemented, with file:line references]

### Missing or Incomplete
- [Goal from plan] — [what's missing or incomplete]

### Deviations
- [What differs from the plan] — [whether this is an improvement or concern]

## Defects

### Critical
- **[Short title]** `[confirmed|likely]` (`file:line`)
  [Description of the defect, why it's a problem, and what could happen]

### Important
- **[Short title]** `[confirmed|likely|possible]` (`file:line`)
  [Description]

### Minor
- **[Short title]** `[confirmed|likely|possible]` (`file:line`)
  [Description]

## Questions

[Only if you have genuine questions. Omit this section entirely if you have none.]

## Positive Observations

[Only if there are genuinely notable technical strengths. Omit if nothing stands out.]
```

**Without plan:**

```markdown
# Code Review

**Date:** YYYY-MM-DD
**Scope:** [working tree | PR #N | commits X..Y]

## Change Summary

[2-3 sentence summary of what this change is trying to accomplish, based on
commit messages, PR description, and the code. State the inferred intent clearly
so the author can confirm or correct your understanding.]

## Verdict

[APPROVE | APPROVE WITH SUGGESTIONS | REQUEST CHANGES]

[1-2 sentence overall assessment]

## Defects

### Critical
- **[Short title]** `[confirmed|likely]` (`file:line`)
  [Description of the defect, why it's a problem, and what could happen]

### Important
- **[Short title]** `[confirmed|likely|possible]` (`file:line`)
  [Description]

### Minor
- **[Short title]** `[confirmed|likely|possible]` (`file:line`)
  [Description]

## Questions

[Only if you have genuine questions. Omit this section entirely if you have none.]

## Positive Observations

[Only if there are genuinely notable technical strengths. Omit if nothing stands out.]
```

**Rules for findings:**

- Every finding MUST include a `file:line` reference.
- Every finding MUST include a confidence tag: `[confirmed]`, `[likely]`, or `[possible]`.
- Every defect MUST explain *why* it's a problem, not just *what* it is.
- If a severity level has no findings, write "None identified." — don't omit the level.
- Err on the side of fewer, higher-confidence findings over many speculative ones.
  A review with 3 confirmed bugs is worth more than one with 20 possibles.
- Never report style issues, formatting, or things a linter would catch.

### Step 5 — Present to user

After writing the review file:

1. Tell the user where the file was written.
2. Print a brief summary: verdict, count of findings by severity and confidence, and
   any critical items highlighted inline.
3. If the verdict is APPROVE, say so clearly. If REQUEST CHANGES, list the critical
   items that need resolution.

## What This Skill Is NOT

- **Not a linter.** Don't report formatting, naming conventions, or style preferences.
- **Not a test runner.** Don't suggest running tests — the author knows.
- **Not an architecture review.** If a plan is provided and its architecture is wrong,
  that's a plan problem, not a code problem. Note it in Questions if you have concerns,
  but the plan is the source of truth for this review.
- **Not automatic.** This skill only runs when explicitly invoked. Never trigger it
  based on context clues or implicit signals.
