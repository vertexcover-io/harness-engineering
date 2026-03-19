# Tech Debt Suppression — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a suppression mechanism so acknowledged tech-debt findings are excluded from future scans, with support for @claude-driven suppression on GitHub issues.

**Architecture:** Three changes: (1) add a `rule` field to scanner agent output and a suppression filtering step in SKILL.md, (2) embed `<!-- suppress:... -->` HTML comments in the issue format reference, (3) add a suppression rules reference file documenting the ignore file format and all rule names.

**Tech Stack:** Markdown (GitHub-flavored)

**Spec:** `docs/superpowers/specs/2026-03-19-tech-debt-suppression-design.md`

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `skills/tech-debt-finder/references/suppression-rules.md` | Documents the `.claude/harness/tech-debt-ignore.md` file format, pattern matching, all rule names, and resolution order |
| Modify | `skills/tech-debt-finder/references/issue-format.md` | Add `<!-- suppress:... -->` HTML comment to finding format template and example |
| Modify | `skills/tech-debt-finder/SKILL.md` | Add `rule` field to agent output, add suppression filtering in Step 3, reference the new suppression-rules file |

---

## Task 1: Create the suppression rules reference file

**Files:**
- Create: `skills/tech-debt-finder/references/suppression-rules.md`

- [ ] **Step 1: Create the reference file**

Create `skills/tech-debt-finder/references/suppression-rules.md` with these sections:

1. **Header** — This file defines the suppression mechanism for tech-debt-finder. The suppression file lives at `.claude/harness/tech-debt-ignore.md` in the target project's repo.

2. **File format** — One rule per line, `#` for full-line comments, blank lines ignored. Show the example:
   ```
   # Suppress a specific rule for a specific file
   providers/fal.py:god-module

   # Suppress all findings of a category for a file
   utils.py:error-handling

   # Suppress a rule globally across all files
   *:god-module

   # Suppress all findings for a file
   providers/legacy.py:*
   ```

3. **Pattern matching table** — The 5 patterns from the spec:
   - `file.py:rule` — Exact file + exact rule
   - `file.py:category` — Exact file + all rules in that category
   - `*:rule` — All files + exact rule
   - `*:category` — All files + all rules in that category
   - `file.py:*` — All findings for that file

   Include: no globs (only exact paths and `*`), case-insensitive matching, resolution order (check category names first, then fall back to rule names).

4. **Rule names table** — All 21 rules from the spec with their categories:
   - `god-module` (architecture)
   - `business-logic-leakage` (architecture)
   - `import-direction-violation` (architecture)
   - `high-cyclomatic-complexity` (complexity)
   - `moderate-cyclomatic-complexity` (complexity)
   - `deep-nesting` (complexity)
   - `code-duplication` (duplication)
   - `bare-except` (error-handling)
   - `swallowed-exception` (error-handling)
   - `generic-catch` (error-handling)
   - `any-overuse` (code-smell)
   - `blocking-in-async` (async)
   - `mutable-default` (code-smell)
   - `magic-number` (code-smell)
   - `dead-code` (code-smell)
   - `global-mutable-state` (code-smell)
   - `known-cve` (dependency)
   - `outdated-dependency` (dependency)
   - `unused-dependency` (dependency)
   - `circular-dependency` (dependency)
   - `pinning-gap` (dependency)

5. **Category names** — The 7 valid category names: `architecture`, `complexity`, `code-smell`, `error-handling`, `duplication`, `dependency`, `async`.

6. **How suppressions are added** — Two methods:
   - Method 1: @claude on GitHub issue — user checks boxes, comments `@claude suppress the checked findings`, Claude extracts patterns from `<!-- suppress:... -->` comments and commits to the suppression file directly (or creates a PR if branch is protected).
   - Method 2: Manual edit of `.claude/harness/tech-debt-ignore.md`.

7. **Edge cases** — From the spec: file doesn't exist (no filtering), empty file (no filtering), finding matches multiple rules (one match is enough to suppress), stale rules (harmless), file renamed (old rule stops matching — finding reappears), invalid rules (skip + warn in Notes).

- [ ] **Step 2: Verify the reference file**

Read back and verify:
- All 21 rule names present with correct categories
- All 7 category names listed
- Pattern matching table has all 5 patterns
- Both suppression methods documented
- Edge cases covered

- [ ] **Step 3: Commit**

```bash
git add skills/tech-debt-finder/references/suppression-rules.md
git commit -m "docs(tech-debt): add suppression rules reference file

Documents .claude/harness/tech-debt-ignore.md format, pattern matching,
all 21 rule names, and @claude-driven suppression workflow."
```

---

## Task 2: Update issue format with suppress comments

**Files:**
- Modify: `skills/tech-debt-finder/references/issue-format.md` (Finding Format section + example)

- [ ] **Step 1: Update the Finding Format template**

In `references/issue-format.md`, replace the Finding Format section's template (lines 131-133):

Current:
```markdown
- [ ] {full_badge} · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters}
```

New:
```markdown
- [ ] {full_badge} · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters} <!-- suppress:{file}:{rule} -->
```

Also update the description line (line 136) from:
```
The `detail` field returned by scanner agents provides the explanation line.
```
To:
```
The `detail` field returned by scanner agents provides the explanation line. The `<!-- suppress:{file}:{rule} -->` HTML comment is invisible when rendered on GitHub but enables @claude-driven suppression (see `references/suppression-rules.md`). Note: `{file}` in the suppress comment uses the full relative path from repo root (e.g., `providers/google.py`), which may differ from the short name shown in the finding's display location.
```

- [ ] **Step 2: Update the Inner Level template**

In the Inner Level — File/Module Sub-group section (lines 114-124), update the example findings to include suppress comments:

Current:
```html
- [ ] 🟠 HIGH · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters}

- [ ] 🟡 MEDIUM · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters}
```

New:
```html
- [ ] 🟠 HIGH · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters} <!-- suppress:{file}:{rule} -->

- [ ] 🟡 MEDIUM · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters} <!-- suppress:{file}:{rule} -->
```

- [ ] **Step 3: Update the Full Example**

In the Full Example section, add suppress comments to every finding. The suppress comment always uses the **full relative path** (from the file sub-group header, e.g., `providers/google.py`) even though the finding's display location uses the short name (`google.py:308`).

Here is the complete mapping for all 8 findings in the example:

| Finding display | Suppress comment |
|----------------|-----------------|
| `google.py:308` — CC=29 | `<!-- suppress:providers/google.py:high-cyclomatic-complexity -->` |
| `google.py:560` — CC=15 | `<!-- suppress:providers/google.py:moderate-cyclomatic-complexity -->` |
| `runway.py:297` — CC=22 | `<!-- suppress:providers/runway.py:high-cyclomatic-complexity -->` |
| `runway.py:580` — CC=13 | `<!-- suppress:providers/runway.py:moderate-cyclomatic-complexity -->` |
| `utils.py:42` — Bare except | `<!-- suppress:utils.py:bare-except -->` |
| `pyproject.toml:11` — Pinning gap pydantic | `<!-- suppress:pyproject.toml:pinning-gap -->` |
| `pyproject.toml:20` — Unused dependency | `<!-- suppress:pyproject.toml:unused-dependency -->` |
| `models.py:5` — Outdated dependency | `<!-- suppress:models.py:outdated-dependency -->` |

Append each suppress comment to the end of the explanation line for its finding (after the text, before the line break).

- [ ] **Step 4: Verify issue-format.md**

Read back and verify:
- Finding Format template has `<!-- suppress:{file}:{rule} -->`
- Inner Level template has suppress comments
- All findings in the Full Example have suppress comments with correct file paths and rule names
- No other sections were accidentally modified

- [ ] **Step 5: Commit**

```bash
git add skills/tech-debt-finder/references/issue-format.md
git commit -m "feat(tech-debt): embed suppress metadata in finding format

Each finding now includes an invisible <!-- suppress:file:rule --> HTML
comment enabling @claude-driven suppression from GitHub issues."
```

---

## Task 3: Update SKILL.md with rule field and suppression filtering

**Files:**
- Modify: `skills/tech-debt-finder/SKILL.md` (Step 2 agent output, Step 3 filtering)

- [ ] **Step 1: Add `rule` field to agent output format**

In SKILL.md line 49, change the agent return format from:

```
Each agent returns structured findings as a list of `{category, item, severity, detail, file, line}`.
```

To:

```
Each agent returns structured findings as a list of `{category, rule, item, severity, detail, file, line}`. The `rule` field is the hyphenated rule name from `references/suppression-rules.md` (e.g., `god-module`, `high-cyclomatic-complexity`, `swallowed-exception`).
```

- [ ] **Step 2: Add suppression filtering to Step 3**

In SKILL.md, after the existing Step 3 content (after line 125 "**Sorting:** Within each severity group, sort by file path then line number."), add:

```markdown

**Suppression filtering:**

After deduplication and sorting, check if `.claude/harness/tech-debt-ignore.md` exists in the project root. If it does, read `references/suppression-rules.md` for the full pattern matching specification, then:

1. Parse all suppression rules from the ignore file
2. For each finding, check if any rule matches (using the finding's `file` and `rule` fields against the suppression patterns)
3. Remove matching findings from the list
4. Track the suppression count for the Notes section

If any suppression rules reference unknown rule names or categories, skip them and note in the report: "Warning: {N} invalid suppression rules skipped."
```

- [ ] **Step 3: Add suppression note to Step 5**

After Step 5b in SKILL.md (line 187), add:

```markdown

If findings were suppressed, include in the Notes section (Section 5) of the issue body:
`**Suppressed:** {N} findings excluded by .claude/harness/tech-debt-ignore.md`
```

- [ ] **Step 4: Verify SKILL.md**

Read back and verify:
- Line 49 area: agent return format includes `rule` field
- Step 3: suppression filtering block is present after sorting
- Step 5: suppression note instruction is present
- Steps 1, 2, 4, 5a, 5c, 5d, 5e are unchanged
- Agent A/B/C tables are unchanged
- File reads coherently end-to-end

- [ ] **Step 5: Commit**

```bash
git add skills/tech-debt-finder/SKILL.md
git commit -m "feat(tech-debt): add rule field and suppression filtering

Scanner agents now return a 'rule' field. Step 3 filters findings
against .claude/harness/tech-debt-ignore.md before report generation."
```

---

## Done When

- [ ] `skills/tech-debt-finder/references/suppression-rules.md` exists with complete format spec, all 21 rule names, and both suppression methods
- [ ] `skills/tech-debt-finder/references/issue-format.md` has `<!-- suppress:... -->` in finding format, inner level template, and full example
- [ ] `skills/tech-debt-finder/SKILL.md` has `rule` field in agent output, suppression filtering in Step 3, and suppression note in Step 5
- [ ] All three commits are clean
