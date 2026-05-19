# Issue Format Reference

This file defines the GitHub issue body formats for the tech-debt-finder skill. The skill creates **sub-issues** (one per category) and a **parent issue** linking them.

When building issue bodies in Step 5, follow this specification exactly.

---

## Layout

Two issue types are created:

**A. Sub-Issue (one per category):**
```
1. Category header + metadata
2. Findings with code snippets (grouped by file)
3. Notes
```

**B. Parent Issue (one per scan):**
```
1. Title + scan metadata
2. Hotspots table
3. Categories task list (linking sub-issues)
4. Recommended actions
5. Notes
```

---

## Severity Badges

Two forms are used depending on context:

| Severity | Full badge (in findings) | Short badge (in headers) |
|----------|--------------------------|--------------------------|
| Critical | `🔴 CRITICAL` | `🔴 critical` |
| High | `🟠 HIGH` | `🟠 high` |
| Medium | `🟡 MEDIUM` | `🟡 medium` |
| Low | `🟢 LOW` | `🟢 low` |

Critical and High use different emoji (🔴 vs 🟠) so they are always distinguishable.

---

## Category Explainers

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

---

## Finding Format

Each finding is a checkbox with the **full badge** form, a permalink to the source, bold title, explanation, optional fix hint, and a code snippet:

```markdown
- [ ] {full_badge} · [`{file}:{line}`](https://github.com/{owner}/{repo}/blob/{sha}/{file}#L{start}-L{end}) — **{short title}**
  {one-line explanation of why this matters} <!-- suppress:{file}:{rule} -->
  **Fix:** {fix_hint}

  ```{language}
  {start} | {code_line}
  ...
  {end}   | {code_line}
  ```
```

- The `detail` field provides the explanation line
- The `fix_hint` field provides the Fix line. **Omit the `**Fix:**` line entirely if `fix_hint` is absent.**
- The `<!-- suppress:{file}:{rule} -->` comment stays on the same line as the `detail` text to preserve compatibility with suppression parsing (see `suppression-rules.md`)
- `{file}` in the suppress comment uses the full relative path from repo root
- **Every finding MUST include a code snippet.** The only acceptable reason to omit one is if the file cannot be read (deleted, binary, permission error)
- For file-level findings (e.g., god modules at line 1), show lines 1-10 to give context on file structure
- The `{file}:{line}` text is a clickable permalink to the exact commit SHA

---

## Section A: Sub-Issue Format

One sub-issue is created per category that has findings.

### Sub-Issue Title

```
Tech Debt: {Category Display Name} — {YYYY-MM-DD} — {scope}
```

### Sub-Issue Body

```markdown
## {Category Display Name}

> {Category explainer from table above}

**Findings:** {count} | **Highest severity:** {severity badge}

---

### Findings

<!-- file sub-groups or flat findings here -->

---

**Notes:** {notes about skipped checks, suppressed findings for this category}
```

### File Sub-Grouping Within Sub-Issues

If a category has findings in **multiple files**, group findings under collapsible `<details>` blocks per file:

```html
<details>
<summary><code>{file_path}</code> — {count} findings</summary>

<!-- findings here using Finding Format -->

</details>
```

If a category has findings in **only one file**, render findings directly under the `### Findings` header without any `<details>` wrapper.

File sub-groups are ordered by:
1. Highest severity finding first
2. Then finding count descending
3. Then alphabetically

Within each file group, findings are sorted by severity (critical first), then line number.

### Sub-Issue Truncation

GitHub issues have a 65536 character body limit. If a sub-issue body exceeds 60000 characters:

1. Truncate **Low** findings first, replacing with: `... and {N} more 🟢 LOW findings`
2. If still too large, truncate **Medium** findings similarly
3. Never truncate Critical or High findings

---

## Section B: Parent Issue Format

One parent issue is created per scan run, after all sub-issues exist.

### Parent Issue Title

```
Tech Debt Audit — {YYYY-MM-DD} — {scope}
```

### Parent Issue Body

Build in this order:

#### 1. Title + Metadata

```markdown
# Tech Debt Audit — {scope}

**Scanned:** {file_count} files | **Date:** {YYYY-MM-DD} | **Commit:** {short_sha}
**Findings:** {critical} critical | {high} high | {medium} medium | {low} low
```

#### 2. Hotspots

Files with 3+ findings, sorted by finding count descending. **Omit this section entirely if no file has 3+ findings.** Severity uses badge format for consistency.

```markdown
## Hotspots

| File | Findings | Highest |
|------|----------|---------|
| `{file}` | {count} | {severity badge} |
```

#### 3. Categories Task List

Links to the sub-issues created in Step 5e. Ordered by highest severity found, then by total finding count (same ordering as sub-issue creation).

```markdown
## Categories

- [ ] #{issue_number} — {Category Display Name} ({count} findings, highest: {severity badge})
```

#### 4. Recommended Actions

Only include severity tiers that have actual findings. Omit tiers with 0 findings.

```markdown
## Recommended Actions

1. **Critical** — fix immediately, security/correctness risks
2. **High** — schedule for current sprint, use `/refactor` for code-level fixes
3. **Medium** — plan for next sprint, use `/planning` for architectural items
4. **Low** — address opportunistically during related work
```

#### 5. Notes

```markdown
**Notes:** {notes about skipped checks, missing tools, suppressed count}
```

If findings were suppressed:
`**Suppressed:** {N} findings excluded by .claude/harness/tech-debt-ignore.md`

#### Parent Truncation

Parent issues are unlikely to hit the 65536 character limit. If they do, remove Low-severity category entries from the Categories task list first, then Medium.

---

## Full Examples

### Example Sub-Issue: Complexity

```markdown
## Complexity

> Functions with too many branches or deeply nested logic — harder to test, review, and modify safely.

**Findings:** 4 | **Highest severity:** 🟠 HIGH

---

### Findings

<details>
<summary><code>providers/google.py</code> — 2 findings</summary>

- [ ] 🟠 HIGH · [`providers/google.py:308`](https://github.com/myorg/myproject/blob/abc123/providers/google.py#L305-L311) — **CC=29 in `_convert_request`**
  29 independent code paths — nearly impossible to test exhaustively. <!-- suppress:providers/google.py:high-cyclomatic-complexity -->
  **Fix:** Extract sub-functions for each request type to reduce branching.

  ```python
  305 |     def _convert_request(self, req):
  306 |         if req.type == "text":
  307 |             return self._text(req)
  308 |         elif req.type == "image":
  309 |             return self._image(req)
  310 |         elif req.type == "video":
  311 |             return self._video(req)
  ```

- [ ] 🟡 MEDIUM · [`providers/google.py:560`](https://github.com/myorg/myproject/blob/abc123/providers/google.py#L557-L563) — **CC=15 in `_handle_error`**
  Error classification logic with 15 branches. Easy to miss an error type. <!-- suppress:providers/google.py:moderate-cyclomatic-complexity -->

  ```python
  557 |     def _handle_error(self, err):
  558 |         if isinstance(err, TimeoutError):
  559 |             return RetryableError(err)
  560 |         elif isinstance(err, AuthError):
  561 |             return FatalError(err)
  562 |         elif isinstance(err, RateLimitError):
  563 |             return RetryableError(err)
  ```

</details>

<details>
<summary><code>providers/runway.py</code> — 2 findings</summary>

- [ ] 🟠 HIGH · [`providers/runway.py:297`](https://github.com/myorg/myproject/blob/abc123/providers/runway.py#L294-L300) — **CC=22 in `_convert_request`**
  22 code paths in request conversion. <!-- suppress:providers/runway.py:high-cyclomatic-complexity -->
  **Fix:** Use a dispatch table mapping request types to handler functions.

  ```python
  294 |     def _convert_request(self, req):
  295 |         if req.model == "gen3":
  296 |             payload = self._gen3(req)
  297 |         elif req.model == "gen2":
  298 |             payload = self._gen2(req)
  299 |         elif req.model == "turbo":
  300 |             payload = self._turbo(req)
  ```

- [ ] 🟡 MEDIUM · [`providers/runway.py:580`](https://github.com/myorg/myproject/blob/abc123/providers/runway.py#L577-L583) — **CC=13 in `_poll_until_complete`**
  Polling loop with 13 branches handling various completion/failure states. <!-- suppress:providers/runway.py:moderate-cyclomatic-complexity -->

  ```python
  577 |     async def _poll_until_complete(self, job_id):
  578 |         while True:
  579 |             status = await self._check(job_id)
  580 |             if status == "complete":
  581 |                 return await self._result(job_id)
  582 |             elif status == "failed":
  583 |                 raise JobFailed(job_id)
  ```

</details>

---

**Notes:** Complexity checks run via `radon cc -s -n B`.
```

---

### Example Parent Issue

```markdown
# Tech Debt Audit — myproject (repo root)

**Scanned:** 42 files | **Date:** 2026-03-18 | **Commit:** abc1234
**Findings:** 1 critical | 3 high | 4 medium | 2 low

## Hotspots

| File | Findings | Highest |
|------|----------|---------|
| `providers/google.py` | 4 | 🟠 HIGH |
| `registry.py` | 3 | 🟡 MEDIUM |

## Categories

- [ ] #42 — Complexity (4 findings, highest: 🟠 HIGH)
- [ ] #43 — Error Handling (1 finding, highest: 🔴 CRITICAL)
- [ ] #44 — Dependency (3 findings, highest: 🟠 HIGH)
- [ ] #45 — Code Smell (2 findings, highest: 🟡 MEDIUM)

## Recommended Actions

1. **Critical** — fix immediately, security/correctness risks
2. **High** — schedule for current sprint, use `/refactor` for code-level fixes
3. **Medium** — plan for next sprint, use `/planning` for architectural items
4. **Low** — address opportunistically during related work

**Notes:** CVE checks skipped — `pip-audit` not installed.
```
