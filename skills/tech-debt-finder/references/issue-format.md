# Issue Format Reference

This file defines the GitHub issue body format for the tech-debt-finder skill. When building the issue body in Step 5b, follow this specification exactly.

---

## Layout

Build the issue body in this order:

```
1. Title + scan metadata
2. Hotspots table
3. Category sections (collapsible)
4. Recommended actions
5. Notes
```

---

## Section 1: Title + Metadata

```markdown
# Tech Debt Audit — {scope}

**Scanned:** {file_count} files | **Date:** {YYYY-MM-DD}
**Findings:** {critical} critical | {high} high | {medium} medium | {low} low
```

---

## Section 2: Hotspots

Files with 3+ findings, sorted by finding count descending. **Omit this section entirely if no file has 3+ findings.**

```markdown
## Hotspots

| File | Findings | Highest |
|------|----------|---------|
| `{file}` | {count} | {severity} |
```

---

## Section 3: Category Sections

Each category is a collapsible `<details>` block. **Omit categories with 0 findings entirely.**

### Severity Badges

Two forms are used depending on context:

| Severity | Full badge (in findings) | Short badge (in headers) |
|----------|--------------------------|--------------------------|
| Critical | `🔴 CRITICAL` | `🔴 critical` |
| High | `🟠 HIGH` | `🟠 high` |
| Medium | `🟡 MEDIUM` | `🟡 medium` |
| Low | `🟢 LOW` | `🟢 low` |

Critical and High use different emoji (🔴 vs 🟠) so they are always distinguishable.

### Category Ordering

Categories are ordered by highest severity found, then by total finding count:

1. Categories with Critical findings first
2. Then categories with High findings
3. Then Medium-only
4. Then Low-only

Within the same tier, more findings sorts first.

### Category Explainers

Agents return hyphenated lowercase category keys. Display names in the issue use title-case.

| Agent category key | Display name | Explainer |
|--------------------|--------------|-----------|
| `architecture` | Architecture | Modules or layers with too many responsibilities — hard to navigate, test, and modify safely. |
| `complexity` | Complexity | Functions with too many branches or deeply nested logic — harder to test, review, and modify safely. |
| `code-smell` | Code Smell | Patterns that aren't bugs today but signal weak typing or hidden state — making future changes riskier. |
| `error-handling` | Error Handling | Exceptions being silenced or caught too broadly — hiding failures and making production issues harder to diagnose. |
| `duplication` | Duplication | Near-identical code blocks that must be changed in lockstep — when one copy gets fixed and others don't, bugs diverge silently. |
| `dependency` | Dependency | Issues with how external packages are declared — missing bounds, unused packages, or circular import workarounds. |
| `async` | Async | Blocking calls inside async functions — stalling the event loop and degrading throughput for all concurrent requests. |

### Outer Level — Category

The severity counts in the header use the **short badge** form. Only include severity tiers that have findings in this category.

```html
<details>
<summary><strong>{Display Name}</strong> — {total} findings ({N} {short_badge}, {M} {short_badge})</summary>

> {Category explainer from table above}

<!-- file sub-groups here -->

</details>
```

Separate each category `<details>` block with a `---` horizontal rule.

### Inner Level — File/Module Sub-group

Each file within a category gets a nested `<details>` block. **If a category has findings in only one file, skip the inner `<details>` and render findings directly under the category explainer.**

File sub-groups are ordered by:
1. Highest severity finding first
2. Then finding count descending
3. Then alphabetically

```html
<details>
<summary><code>{file_path}</code> — {count} findings</summary>

- [ ] 🟠 HIGH · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters} <!-- suppress:{file}:{rule} -->

- [ ] 🟡 MEDIUM · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters} <!-- suppress:{file}:{rule} -->

</details>
```

### Finding Format

Each finding is a checkbox with the **full badge** form, a middle dot separator, file location, bold title, and a one-line explanation:

```markdown
- [ ] {full_badge} · `{file}:{line}` — **{short title}**
  {one-line explanation of why this matters} <!-- suppress:{file}:{rule} -->
```

The `detail` field returned by scanner agents provides the explanation line. The `<!-- suppress:{file}:{rule} -->` HTML comment is invisible when rendered on GitHub but enables @claude-driven suppression (see `references/suppression-rules.md`). Note: `{file}` in the suppress comment uses the full relative path from repo root (e.g., `providers/google.py`), which may differ from the short name shown in the finding's display location.

---

## Section 4: Recommended Actions

Only include severity tiers that have actual findings. Omit tiers with 0 findings.

```markdown
## Recommended Actions

1. **Critical** — fix immediately, security/correctness risks
2. **High** — schedule for current sprint, use `/refactor` for code-level fixes
3. **Medium** — plan for next sprint, use `/planning` for architectural items
4. **Low** — address opportunistically during related work
```

---

## Section 5: Notes

Rendered after Recommended Actions as the final section. Include any skipped checks or tool availability issues.

```markdown
**Notes:** {notes about skipped checks, missing tools, etc.}
```

---

## Truncation Rules

GitHub issues have a 65536 character body limit. If the body exceeds 60000 characters:

1. Truncate **Low** findings first, replacing with: `... and {N} more 🟢 LOW findings`
2. If still too large, truncate **Medium** findings similarly
3. Never truncate Critical or High findings

---

## Full Example

A minimal example demonstrating all patterns: multi-file category, single-file shortcut, mixed severities, and all badge types.

```markdown
# Tech Debt Audit — myproject (repo root)

**Scanned:** 42 files | **Date:** 2026-03-18
**Findings:** 1 critical | 3 high | 4 medium | 2 low

## Hotspots

| File | Findings | Highest |
|------|----------|---------|
| `providers/google.py` | 4 | High |
| `registry.py` | 3 | Medium |

---

<details>
<summary><strong>Complexity</strong> — 4 findings (2 🟠 high, 2 🟡 medium)</summary>

> Functions with too many branches or deeply nested logic — harder to test, review, and modify safely.

<details>
<summary><code>providers/google.py</code> — 2 findings</summary>

- [ ] 🟠 HIGH · `google.py:308` — **CC=29 in `_convert_request`**
  29 independent code paths — nearly impossible to test exhaustively. <!-- suppress:providers/google.py:high-cyclomatic-complexity -->

- [ ] 🟡 MEDIUM · `google.py:560` — **CC=15 in `_handle_error`**
  Error classification logic with 15 branches. Easy to miss an error type. <!-- suppress:providers/google.py:moderate-cyclomatic-complexity -->

</details>

<details>
<summary><code>providers/runway.py</code> — 2 findings</summary>

- [ ] 🟠 HIGH · `runway.py:297` — **CC=22 in `_convert_request`**
  22 code paths in request conversion, likely candidates for extract-method refactoring. <!-- suppress:providers/runway.py:high-cyclomatic-complexity -->

- [ ] 🟡 MEDIUM · `runway.py:580` — **CC=13 in `_poll_until_complete`**
  Polling loop with 13 branches handling various completion/failure states. <!-- suppress:providers/runway.py:moderate-cyclomatic-complexity -->

</details>

</details>

---

<details>
<summary><strong>Error Handling</strong> — 1 finding (1 🔴 critical)</summary>

> Exceptions being silenced or caught too broadly — hiding failures and making production issues harder to diagnose.

- [ ] 🔴 CRITICAL · `utils.py:42` — **Bare `except:` with `pass` in `_parse_config`**
  Catches SystemExit and KeyboardInterrupt silently. Masks every possible failure. <!-- suppress:utils.py:bare-except -->

</details>

---

<details>
<summary><strong>Dependency</strong> — 3 findings (1 🟠 high, 2 🟢 low)</summary>

> Issues with how external packages are declared — missing bounds, unused packages, or circular import workarounds.

<details>
<summary><code>pyproject.toml</code> — 2 findings</summary>

- [ ] 🟢 LOW · `pyproject.toml:11` — **Pinning gap: `pydantic>=2.0.0` no upper bound**
  A future pydantic 3.0 could break serialization without warning. <!-- suppress:pyproject.toml:pinning-gap -->

- [ ] 🟢 LOW · `pyproject.toml:20` — **Unused dependency: `google-cloud-aiplatform` never imported**
  Dead weight in the dependency tree. <!-- suppress:pyproject.toml:unused-dependency -->

</details>

<details>
<summary><code>models.py</code> — 1 finding</summary>

- [ ] 🟠 HIGH · `models.py:5` — **Outdated dependency: `requests` 1.x (latest 3.x)**
  Two major versions behind — breaking API changes likely. <!-- suppress:models.py:outdated-dependency -->

</details>

</details>

---

## Recommended Actions

1. **Critical** — fix immediately, security/correctness risks
2. **High** — schedule for current sprint, use `/refactor` for code-level fixes
3. **Medium** — plan for next sprint, use `/planning` for architectural items
4. **Low** — address opportunistically during related work

**Notes:** CVE checks skipped — `pip-audit` not installed.
```
