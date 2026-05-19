# Suppression Rules Reference

This file defines the suppression mechanism for the tech-debt-finder skill. Suppressions allow teams to exclude acknowledged findings from future scans.

The suppression file lives at `.claude/harness/tech-debt-ignore.md` in the target project's repo (not in the skill directory).

---

## File Format

One suppression rule per line. Lines starting with `#` are comments. Blank lines are ignored.

```
# Tech Debt Suppressions
# Format: <file-path>:<rule-or-category>

# Suppress a specific rule for a specific file
providers/fal.py:god-module

# Suppress all findings of a category for a file
utils.py:error-handling

# Suppress a rule globally across all files
*:god-module

# Suppress all findings for a file
providers/legacy.py:*
```

---

## Pattern Matching

| Pattern | Matches |
|---------|---------|
| `file.py:rule` | Exact file + exact rule |
| `file.py:category` | Exact file + all rules in that category |
| `*:rule` | All files + exact rule |
| `*:category` | All files + all rules in that category |
| `file.py:*` | All findings for that file |

**File paths** are relative to the repo root, matching the paths used in findings. **Glob patterns are not supported** — only exact file paths and `*` (all files). No `**`, `?`, or `*.py` patterns.

**Matching is case-insensitive.** `God-Module` matches `god-module`.

**Only full-line comments** are supported (lines starting with `#`). Inline comments are not supported.

**Resolution order:** When parsing the right-hand side of a rule, check if it matches a known category name first (from the Category Names list below). If it does, treat it as a category-level suppression. Otherwise, treat it as a rule name. Category names and rule names are disjoint by design.

---

## Rule Names

| Rule name | Category | What it matches |
|-----------|----------|-----------------|
| `god-module` | architecture | God module findings |
| `business-logic-leakage` | architecture | Business logic in wrong layer |
| `import-direction-violation` | architecture | Lower layer importing from higher |
| `high-cyclomatic-complexity` | complexity | CC >= 16 |
| `moderate-cyclomatic-complexity` | complexity | CC 11–15 |
| `deep-nesting` | complexity | Nesting beyond threshold |
| `code-duplication` | duplication | Near-identical code blocks |
| `bare-except` | error-handling | `except:` with no type |
| `swallowed-exception` | error-handling | `except Exception: pass` |
| `generic-catch` | error-handling | `except Exception` without re-raise |
| `any-overuse` | code-smell | `-> Any` or `: Any` |
| `blocking-in-async` | async | Blocking calls in async functions |
| `mutable-default` | code-smell | Mutable default arguments |
| `magic-number` | code-smell | Undocumented numeric literals |
| `dead-code` | code-smell | Commented-out code |
| `global-mutable-state` | code-smell | Module-level mutable collections |
| `known-cve` | dependency | Published security vulnerability |
| `outdated-dependency` | dependency | Package behind latest |
| `unused-dependency` | dependency | Declared but never imported |
| `circular-dependency` | dependency | TYPE_CHECKING workarounds |
| `pinning-gap` | dependency | No upper bound on major version |

---

## Category Names

The 7 valid category names for category-level suppression:

`architecture`, `complexity`, `code-smell`, `error-handling`, `duplication`, `dependency`, `async`

---

## How Suppressions Are Added

### Method 1: @claude on the GitHub issue

1. User checks checkbox(es) on the tech-debt issue
2. User comments: `@claude suppress the checked findings`
3. Claude reads the issue body, identifies checked items
4. Extracts suppression patterns from the `<!-- suppress:... -->` HTML comments embedded in each finding
5. Appends patterns to `.claude/harness/tech-debt-ignore.md` (creates the file if it doesn't exist)
6. Commits directly to the default branch. If the push is rejected (branch protection), creates a PR instead and informs the user.

### Method 2: Manual edit

User edits `.claude/harness/tech-debt-ignore.md` directly.

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Suppression file doesn't exist | No filtering — all findings reported |
| Suppression file is empty | No filtering |
| Finding matches multiple rules | One match is enough to suppress |
| Suppressed finding later gets fixed | Stale rule is harmless — no finding to suppress |
| File is renamed after suppression | Old rule stops matching — finding reappears |
| Invalid rule in suppression file | Skip it, log a warning in the Notes section |
