# Tech Debt Suppression

**Date:** 2026-03-19
**Status:** Approved
**Scope:** Add a suppression mechanism so acknowledged tech-debt findings are excluded from future scans

---

## Problem

Every time the tech-debt-finder skill runs, it reports the same findings — including ones the team has already seen and intentionally deferred. There's no way to say "I know about this, stop reporting it." This creates noise and erodes trust in the audit.

## Design

### Suppression File

**Location:** `.claude/harness/tech-debt-ignore.md` (per-repo, committed to version control)

**Format:** One suppression rule per line. Comments start with `#`. Blank lines are ignored.

```markdown
# Tech Debt Suppressions
# Format: <file-pattern>:<rule-or-category>

# Suppress a specific rule for a specific file
providers/fal.py:god-module

# Suppress all findings of a category for a file
utils.py:error-handling

# Suppress a rule globally across all files
*:god-module

# Suppress all findings for a file
providers/legacy.py:*
```

### Pattern Matching

| Pattern | Matches |
|---------|---------|
| `file.py:rule` | Exact file + exact rule |
| `file.py:category` | Exact file + all rules in that category |
| `*:rule` | All files + exact rule |
| `*:category` | All files + all rules in that category |
| `file.py:*` | All findings for that file |

File paths are relative to the repo root, matching the paths used in findings. **Glob patterns are not supported** — only exact file paths and `*` (all files). No `**`, `?`, or `*.py` patterns.

**Resolution order:** When parsing the right-hand side of a rule, check if it matches a known category name first (from the Category Explainers table). If it does, treat it as a category-level suppression. Otherwise, treat it as a rule name. Category names and rule names are disjoint by design — no collisions exist.

**Matching is case-insensitive.** `God-Module` matches `god-module`. Only full-line comments are supported (lines starting with `#`), not inline comments.

### Rule Names

Rule names map to the debt types detected by scanner agents. They are lowercase, hyphenated:

| Rule name | Category | What it matches |
|-----------|----------|-----------------|
| `god-module` | architecture | God module findings |
| `business-logic-leakage` | architecture | Business logic in wrong layer |
| `import-direction-violation` | architecture | Lower layer importing from higher |
| `high-cyclomatic-complexity` | complexity | CC >= 16 |
| `moderate-cyclomatic-complexity` | complexity | CC 11-15 |
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

### How the Skill Uses It

In **Step 3 (Collect & Classify)** of the tech-debt-finder skill, after merging and deduplicating findings:

1. Check if `.claude/harness/tech-debt-ignore.md` exists in the project root
2. If it exists, parse all suppression rules
3. For each finding, check if any rule matches (file pattern + rule/category)
4. Remove matching findings from the list
5. Add to the **Notes section (Section 5)** of the issue: `**Suppressed:** {N} findings excluded by .claude/harness/tech-debt-ignore.md`
6. Proceed with report generation using the filtered list

### How Suppressions Are Added

**Method 1: @claude on the GitHub issue**

1. User checks checkbox(es) on the tech-debt issue
2. User comments: `@claude suppress the checked findings`
3. Claude reads the issue body, identifies checked items
4. Extracts suppression patterns from the `<!-- suppress:... -->` HTML comments embedded in each finding (see "Issue Format Change" below)
5. Appends patterns to `.claude/harness/tech-debt-ignore.md` (creates the file if it doesn't exist)
6. Commits directly to the default branch. If the push is rejected (branch protection), create a PR instead and inform the user.

**Method 2: Manual edit**

User edits `.claude/harness/tech-debt-ignore.md` directly.

### What the Agents Need to Change

Scanner agents (A, B, C) currently return findings as `{category, item, severity, detail, file, line}`. They need to also return a **`rule`** field — the hyphenated rule name from the table above. This is required for pattern matching.

Example finding with the new field:
```json
{
  "category": "architecture",
  "rule": "god-module",
  "item": "God module: 2288 lines spanning video, image, and TTS",
  "severity": "High",
  "detail": "Three distinct domains packed into a single file.",
  "file": "providers/fal.py",
  "line": 1
}
```

### Issue Format Change

Each finding in the GitHub issue must embed its suppression pattern as an invisible HTML comment on the explanation line. This enables Method 1 — Claude can regex for `<!-- suppress:... -->` on checked items without needing to infer rule names from human-readable text.

**Updated finding format:**

```markdown
- [ ] 🟠 HIGH · `providers/fal.py:1` — **God module: 2288 lines spanning video, image, and TTS**
  Three distinct domains packed into a single file. <!-- suppress:providers/fal.py:god-module -->
```

The `<!-- suppress:... -->` comment is invisible when rendered on GitHub. The pattern inside follows the same `file:rule` format used in the suppression file.

This requires updating `references/issue-format.md` to include the suppress comment in the finding format template.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Suppression file doesn't exist | No filtering — all findings reported (current behavior) |
| Suppression file is empty | No filtering |
| Finding matches multiple rules | One match is enough to suppress |
| Suppressed finding later gets fixed | Stale rule in ignore file is harmless — no finding to suppress |
| File is renamed after suppression | Old rule stops matching — finding reappears (correct behavior) |
| Invalid rule in suppression file | Skip it, log a warning in the Notes section |

## What Does NOT Change

- Scanner agent detection logic — unchanged, they still find everything
- Terminal report — shows filtered results (same as issue)
- Issue format — mostly unchanged; only addition is `<!-- suppress:... -->` HTML comments per finding
- Severity thresholds — unchanged
