---
name: tech-debt-finder
description: >
  Use when the user says "find tech debt", "audit code quality", "what needs cleanup",
  "show me debt", "code health check", "scan for smells", or wants a comprehensive
  quality assessment before planning a refactor or sprint.
argument-hint: "[path/to/scope or 'full']"
allowed-tools: Bash, Read, Glob, Grep, Agent
---

## Project-Specific Guidelines

Check if `.claude/harness/tech-debt-finder-reference.md` exists in the project root.
If it does, read it and apply its guidelines alongside the defaults below.
User-provided guidelines take precedence on conflicts with defaults.

Note: `$ARGUMENTS` is reserved for scan scope (path or 'full'), not reference files.


# Tech Debt Finder

Scans the codebase for architectural and code-level technical debt, producing a prioritized report and creating a GitHub issue with actionable findings.

**Announce at start:** "Using tech-debt-finder to scan for technical debt..."

---

## Configuration

| Setting                | Default                    | Description                     |
|------------------------|----------------------------|---------------------------------|
| **Scope**              | `$ARGUMENTS` or repo root  | Directory to scan               |
| **nesting_depth**      | 4                          | Deep nesting threshold          |

---

## Execution Flow

### Step 1: Resolve Scope

Parse `$ARGUMENTS`:
- If a path is provided, scope all scans to that directory
- If empty or `full`, scan from repo root
- Exclude: `node_modules/`, `.venv/`, `__pycache__/`, `build/`, `dist/`, `.git/`

**Detect languages in scope** and classify coverage (drives Step 2 and the report label):

- **Python** (`pyproject.toml`, `setup.py`, or `*.py` files) → deterministic backend = radon
  (+ pip-audit). Identify all Python packages.
- **TS/JS** (`package.json`, `tsconfig.json`, or `*.ts/*.tsx/*.js/*.jsx/*.mjs/*.cjs`) →
  deterministic backend = **fallow** (see `../_shared/fallow.md (relative to this skill dir)`).
- **Other** (Go, Rust, Java, Ruby, C#, …) → no deterministic backend; the language-agnostic
  LLM pattern scanner (Agent C) runs best-effort.

**Do NOT hard-stop just because there are no Python files** (this is the F9 behavior). Stop
ONLY when the scope is empty or does not exist. Track three coverage buckets for the report:
**deterministically scanned**, **pattern-only**, **skipped (empty)**.

### Step 2: Run Scanners

Two kinds of scanners run and their findings merge in Step 3: a **deterministic backend pass**
(fast tools, run via Bash) and **3 parallel LLM pattern agents**.

#### Step 2a: Deterministic backend pass (fallow, TS/JS)

If the scope contains TS/JS (Step 1), run fallow per the shared contract
(`../_shared/fallow.md (relative to this skill dir)`) — read it for the exact invocation,
TS/JS gate, exit-code handling, skip-with-note protocol, and the full envelope→finding +
severity + rule-name mapping. Run all three from the scope root:

```bash
FALLOW_AGENT_SOURCE=claude_code npx --yes fallow@2.86.0 dead-code --format json --quiet 2>/dev/null || true
FALLOW_AGENT_SOURCE=claude_code npx --yes fallow@2.86.0 dupes     --format json --quiet 2>/dev/null || true
FALLOW_AGENT_SOURCE=claude_code npx --yes fallow@2.86.0 health    --format json --quiet 2>/dev/null || true
```

Map each finding into `{category, rule, item, severity, detail, fix_hint, file, line,
auto_fixable, fallow_action}` using the contract's tables (e.g. `unused_exports[]` →
`unused-export`/code-smell/Low, `circular_dependencies[]` → `circular-dependency`/dependency/Medium,
`health.findings[]` with `cyclomatic >= 16` → `high-cyclomatic-complexity`/complexity/High). Set
`auto_fixable`/`fallow_action` from the finding's `actions[]` per the contract's auto-fixable rule
(a remediation action fallow itself marks `auto_fixable: true`, e.g. `remove-export` → `true`;
suppression actions and remediations fallow leaves `auto_fixable: false` such as `delete-file` → `false`). Preserve these structured fields — do not collapse findings to bare counts; you
persist the full list in Step 4.5 and it is the source of truth for the automated fix pass. Don't dump
raw fallow JSON into the report. If fallow skips (offline / exit 2 / no TS-JS), record the skip note and
treat TS/JS as **pattern-only** for the coverage label. Radon (Python complexity) remains in
Agent B below.

#### Step 2b: Dispatch Parallel Scanners

Launch **3 agents in parallel** (Claude Code: `Agent` tool; Codex: invoke the `worker` agent at `.codex/agents/worker.toml` — see `references/codex-tools.md`). Each agent receives the resolved scope path and configuration. Each agent returns structured findings as a list of `{category, rule, item, severity, detail, fix_hint, file, line}`. The `rule` field is the hyphenated rule name from `references/suppression-rules.md` (e.g., `god-module`, `high-cyclomatic-complexity`, `swallowed-exception`). LLM-agent findings are always `auto_fixable: false` (no deterministic remediation) — they are tracked as issues, never auto-fixed.

**For TS/JS files, the deterministic fallow pass (2a) owns dead code, duplication, and
cyclomatic complexity** — the LLM agents should NOT re-report those for TS/JS (fallow is
authoritative; dedup in Step 3 would drop overlaps anyway). The agents still apply their
error-handling, async, and code-smell pattern checks to every language, including TS/JS and
languages with no deterministic backend.

The `fix_hint` field is a one-liner describing why the finding matters and a suggested fix direction (e.g., "Re-raise or log with context before continuing"). If a finding has no clear fix direction, omit `fix_hint`.

Each agent is free to use whatever detection approach works best — grep, AST parsing, external tools (radon, ruff, pip-audit), file reading, or any combination. The goal is accurate detection, not a specific technique.

**Calibration:** This codebase generally follows established practices (DRY, single responsibility, explicit error handling). Set a high bar for findings — flag genuine violations, not borderline cases.

---

**Agent A — Dependency & Environment Scanner**

Detect debt in these categories:

| Debt Type | What It Looks Like | Severity |
|-----------|--------------------|----------|
| **Known CVE** | A dependency has a published security vulnerability (use `pip-audit` or `safety` if available) | Critical |
| **Outdated dependency** | Package >1 major version behind latest | High |
| **Outdated dependency** | Package >1 minor version behind latest | Medium |
| **Unused dependency** | Dependency declared in `pyproject.toml` but never imported in source or tests | Low |
| **Circular dependency signal** | `if TYPE_CHECKING:` blocks or function-level imports used as circular import workarounds | Medium |
| **Pinning gap** | Dependency with no upper bound on major version (e.g. `>=2.0` with no `<3`) | Low |

Return findings with category `dependency`. Include a `fix_hint` for each finding — a brief "why this matters + fix direction" one-liner.

---

**Agent B — Structural & Complexity Scanner**

Detect debt in these categories:

| Debt Type | What It Looks Like | Severity |
|-----------|--------------------|----------|
| **God module** | Python file that is excessively long — too many responsibilities in one module | High |
| **High cyclomatic complexity** | Function with complexity >= 16 | High |
| **Moderate cyclomatic complexity** | Function with complexity 11–15 | Medium |
| **Deep nesting** | Code indented beyond `nesting_depth` levels | Medium |
| **Business logic leakage** | ORM/DB calls, HTTP client calls, or validation logic in controller/handler/view files instead of the appropriate layer | High |
| **Import direction violation** | Lower layer importing from higher layer (e.g. models importing from providers, utils importing from domain code) | High |
| **Code duplication** | Substantial blocks of near-identical code across files — same logic with only minor variations (variable names, literals). Look for duplicated functions, repeated conditional chains, and copy-pasted blocks | Medium |

**Cyclomatic complexity detection via `radon`:**

```bash
# Step 1: Check if radon is available, install if missing
radon --version || pip install radon

# Step 2: Run cyclomatic complexity analysis (threshold B = CC >= 11)
radon cc -s -n B <scope_path>

# Step 3: For JSON output (easier to parse)
radon cc -s -n B -j <scope_path>
```

- `-s` shows the complexity score
- `-n B` filters to grade B and worse (CC >= 11), covering both Moderate (11–15) and High (>=16)
- `-j` outputs JSON for structured parsing
- Classify CC >= 16 as High severity, CC 11–15 as Medium severity

If `radon` is not found and `pip install radon` fails, skip complexity checks and note in report: "Complexity checks skipped — radon install failed".

Return findings with category `architecture`, `complexity`, or `duplication`. Include a `fix_hint` for each finding — a brief "why this matters + fix direction" one-liner.

---

**Agent C — Code Pattern Scanner**

Detect debt in these categories:

| # | Debt Type | What It Looks Like | Example | Severity | Category |
|---|-----------|-------------------|---------|----------|----------|
| 1 | **Bare except** | `except:` with no exception type — catches SystemExit, KeyboardInterrupt | `except:\n    pass` | Critical | error-handling |
| 2 | **Swallowed exception** | `except Exception` where the body is only `pass` or `continue` — no logging, no re-raise | `except Exception:\n    pass` | High | error-handling |
| 3 | **Generic catch without re-raise** | `except Exception` block that never re-raises — callers never know the operation failed | `except Exception as e:\n    logger.error(e)` | Medium | error-handling |
| 4 | **Any overuse** | `-> Any` or `: Any` in non-test files, especially `dict[str, Any]` where a TypedDict/model would be better | `def get_config() -> Any:` | Medium | code-smell |
| 5 | **Blocking call in async** | `time.sleep`, synchronous `requests.*`, or blocking file I/O inside an `async def` | `async def fetch():\n    time.sleep(5)` | High | async |
| 6 | **Mutable default argument** | `def f(x=[])` or `def f(x={})` — the default is shared across all calls, a correctness bug | `def add(item, items=[]):` | High | code-smell |
| 7 | **Magic numbers** | Numeric literals >2 digits in non-test source, excluding common constants (0, 1, 100, HTTP status codes) | `timeout = 8473` | Medium | code-smell |
| 8 | **Dead code — commented out** | Commented-out function defs, imports, returns, or class definitions. Git has the history | `# def old_handler():` | Low | code-smell |
| 9 | **Global mutable state** | Module-level mutable collections (dicts, lists, sets) that get mutated at runtime — thread-safety risk in async contexts | `CACHE = {}\n...\nCACHE[key] = val` | Medium | code-smell |

Return findings with their respective categories. Include a `fix_hint` for each finding — a brief "why this matters + fix direction" one-liner.

---

### Step 3: Collect & Classify

Merge the deterministic backend findings (Step 2a) and all LLM agent results (Step 2b) into a
single list. Classify by severity:

| Severity     | Criteria                                                                  |
|-------------|---------------------------------------------------------------------------|
| **Critical** | Known CVEs, bare `except:` with `pass`                                   |
| **High**     | God modules, swallowed exceptions, blocking in async, layer violations, mutable defaults |
| **Medium**   | High complexity (radon), `Any` overuse, deep nesting, magic numbers, duplication |
| **Low**      | Unused deps, commented-out code                                          |

**Deduplication:** If the same `file:line` appears in multiple categories, keep the highest severity instance.

**Sorting:** Within each severity group, sort by file path then line number.

**Stable IDs:** Assign each finding a stable `id` of `{category}:{rule}:{file}:{line}`. This id is
how the automated fix pass tracks the finding to a terminal disposition (Step 4.5, Step 6), so it
must be deterministic across runs and survive into the manifest unchanged.

**Suppression filtering:**

After deduplication and sorting, check if `.claude/harness/tech-debt-ignore.md` exists in the project root. If it does, read `references/suppression-rules.md` for the full pattern matching specification, then:

1. Parse all suppression rules from the ignore file
2. For each finding, check if any rule matches (using the finding's `file` and `rule` fields against the suppression patterns)
3. Mark matching findings `disposition: "suppressed"` (record the matched rule) and exclude them from the report tables and GitHub issues — but **keep them in the findings manifest** (Step 4.5) so they stay counted, not silently dropped
4. Track the suppression count for the Notes section

If any suppression rules reference unknown rule names or categories, skip them and note in the report: "Warning: {N} invalid suppression rules skipped."

### Step 4: Print Report to Terminal

Output the report directly to the user:

```
## Tech Debt Report — {scope}
**Scanned:** {file_count} files | **Date:** {YYYY-MM-DD}
**Coverage:** deterministic: {Python via radon, TS/JS via fallow — list what ran} | pattern-only: {languages with no deterministic backend, e.g. Go, Rust} | {fallow skip note if any}
**Findings:** {critical} critical, {high} high, {medium} medium, {low} low

### Critical ({count})
| File | Line | Finding | Category |
|------|------|---------|----------|
| ... | ... | ... | ... |

### High ({count})
| File | Line | Finding | Category |
|------|------|---------|----------|
| ... | ... | ... | ... |

### Medium ({count})
| File | Line | Finding | Category |
|------|------|---------|----------|
| ... | ... | ... | ... |

### Low ({count})
| File | Line | Finding | Category |
|------|------|---------|----------|
| ... | ... | ... | ... |

### Summary

| Category        | Critical | High | Medium | Low | Total |
|-----------------|----------|------|--------|-----|-------|
| dependency      | ...      | ...  | ...    | ... | ...   |
| architecture    | ...      | ...  | ...    | ... | ...   |
| complexity      | ...      | ...  | ...    | ... | ...   |
| error-handling  | ...      | ...  | ...    | ... | ...   |
| code-smell      | ...      | ...  | ...    | ... | ...   |
| async           | ...      | ...  | ...    | ... | ...   |
| duplication     | ...      | ...  | ...    | ... | ...   |

### Hotspots (files with 3+ findings)

| File | Findings | Highest Severity |
|------|----------|------------------|
| ... | ... | ... |
```

### Step 4.5: Persist the structured findings manifest

Before creating issues, write the full normalized finding list — including suppressed findings —
to a machine-readable manifest. This is the source of truth that any downstream automated fix pass
consumes (see `references/auto-fix-handoff.md`); it is what stops findings from silently vanishing
between scan and PR.

```bash
mkdir -p .harness/runtime/tech-debt/{YYYY-MM-DD}
# write the array of findings (with id, auto_fixable, fallow_action, disposition) to:
#   .harness/runtime/tech-debt/{YYYY-MM-DD}/findings.json
```

Each entry carries the fields assigned across Steps 2–3 plus a starting `disposition`:

- `disposition: "suppressed"` for findings filtered in Step 3,
- `disposition: "pending"` for everything else (Step 5 updates these to `"issue"` once filed).

Manifest entry shape:

```json
{
  "id": "code-smell:unused-export:packages/web/src/lib/format.ts:42",
  "category": "code-smell", "rule": "unused-export",
  "file": "packages/web/src/lib/format.ts", "line": 42,
  "severity": "Low", "detail": "...", "fix_hint": "...",
  "auto_fixable": true, "fallow_action": "remove-export",
  "source": "fallow", "issue_number": null, "disposition": "pending"
}
```

Print the manifest path after writing it. `.harness/runtime/` is gitignored, which is
fine — the fix pass reads it from the same checkout within the same run.

### Step 5: Create GitHub Issues

Automatically create GitHub issues with the findings. No confirmation needed. Creates one sub-issue per category, then a parent issue linking them all.

**5a. Extract code snippets for all findings.**

**Every finding MUST have an embedded code snippet.** For each finding, use the Read tool to read the source file and extract 3 lines before and 3 lines after `file:line` (7 lines total). Format as a fenced code block with the language inferred from file extension (`.py` → `python`, `.ts` → `typescript`, etc.).

- If multiple findings in the same file are within 5 lines of each other, merge into one snippet
- If a file can't be read (deleted, binary, permission error), fall back to `file:line` with no snippet — this is the ONLY acceptable reason to omit a snippet
- Include line numbers in the snippet: `{line_num} | {code}`
- For file-level findings (e.g., god modules at line 1), read lines 1-10 to show the file header, imports, and class/function structure

**5b. Get current commit SHA:**

```bash
git rev-parse HEAD
```

Store the full SHA for permalink construction.

**5c. Get repo info:**

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
```

Permalink format: `https://github.com/{nameWithOwner}/blob/{sha}/{file}#L{start}-L{end}`
where `start` = `line - 3` and `end` = `line + 3`.

**5d. Ensure labels exist:**

```bash
gh label create "tech-debt" --color "D93F0B" --description "Technical debt findings" 2>/dev/null || true
gh label create "tech-debt:{YYYY-MM-DD}" --color "D93F0B" --description "Tech debt audit run {YYYY-MM-DD}" 2>/dev/null || true
```

The run-specific label groups all issues from one scan for easy filtering and cleanup.

**5e. Create sub-issues (one per category).**

For each category that has findings (after suppression filtering), create a GitHub issue. Process categories in the same order as the terminal report (by highest severity, then count). Collect the issue number from each creation.

Read `references/issue-format.md` Section A (Sub-Issue Format) and follow it exactly to build each sub-issue body.

If findings were suppressed for this category, include in the Notes line:
`**Suppressed:** {N} findings excluded by .claude/harness/tech-debt-ignore.md`

Handle body size per sub-issue: if body exceeds 60000 characters, truncate Low findings first, then Medium. Never truncate Critical or High.

```bash
gh issue create \
  --title "Tech Debt: {Category Display Name} — {YYYY-MM-DD} — {scope}" \
  --label "tech-debt" \
  --label "tech-debt:{YYYY-MM-DD}" \
  --body-file /tmp/tech-debt-sub-{category}.md
```

Write the body to a temp file first to avoid shell argument length limits.

**5f. Create parent issue.**

After all sub-issues are created, build the parent issue body. Read `references/issue-format.md` Section B (Parent Issue Format) and follow it exactly.

The Categories task list references the sub-issue numbers collected in Step 5e:
```markdown
- [ ] #{issue_number} — {Category Display Name} ({count} findings, highest: {severity badge})
```

```bash
gh issue create \
  --title "Tech Debt Audit — {YYYY-MM-DD} — {scope}" \
  --label "tech-debt" \
  --label "tech-debt:{YYYY-MM-DD}" \
  --body-file /tmp/tech-debt-parent.md
```

**5g. Link sub-issues to parent using GitHub's native sub-issues API.**

For each sub-issue, get its node ID and add it as a sub-issue of the parent:

```bash
# Get the node ID of a sub-issue
SUB_NODE_ID=$(gh api graphql -f query='{ repository(owner:"{owner}", name:"{repo}") { issue(number: {sub_issue_number}) { id } } }' -q '.data.repository.issue.id')

# Add as sub-issue of parent
gh api repos/{owner}/{repo}/issues/{parent_number}/sub_issues \
  --method POST \
  -f sub_issue_id="$SUB_NODE_ID"
```

This creates a native parent-child relationship — GitHub shows sub-issues under the parent with a progress bar, and each sub-issue shows a breadcrumb back to the parent automatically.

If the sub-issue API call fails (e.g., feature not available on the repo), fall back to editing the sub-issue body to append `**Parent issue:** #{parent_number}`.

**5h. Print the parent issue URL** to the user after creation.

**5i. Write dispositions back to the manifest.** For every finding that went into a sub-issue, set
its `issue_number` to that sub-issue's number and its `disposition` to `"issue"` in
`.harness/runtime/tech-debt/{YYYY-MM-DD}/findings.json`. Suppressed findings keep `disposition: "suppressed"`.
After this step no finding is left `pending` — every finding is either `issue` or `suppressed`, ready
for the fix pass to take over.

---

## Step 6: Automated-fix hand-off (CI / `--auto` only)

When `tech-debt-finder` runs as the scan half of an automated fix pipeline (e.g. the CI "Code
Health" job that then calls `orchestrate --auto` to open a PR), the fix half MUST follow
`references/auto-fix-handoff.md`. In short: the fixer reads `findings.json` directly (never
re-derives the fix list from the report prose), fixes only `auto_fixable: true` findings, and writes
a `fix-manifest.json` giving **every** finding a terminal disposition (`fixed` / `issue` /
`suppressed` / `dropped`, with a reason required for `dropped`). It then reconciles and fails loudly if
any `auto_fixable` finding was dropped without justification. Read that contract before driving any
automated fix from this scan.

When run interactively for a human (the default), stop after Step 5 — do not fix anything.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| `radon` not installed | Install with `pip install radon` and retry. If install fails, skip complexity checks. Note in report: "Complexity checks skipped — radon install failed" |
| `pip-audit` not installed | Skip CVE checks. Note in report: "CVE checks skipped — install `pip-audit`" |
| `fallow` unavailable (offline / npx fails / exit 2 / `{"error":true}`) | Skip the fallow pass per the shared contract's skip-with-note protocol; treat TS/JS as pattern-only. Never fail the run. |
| Scope path doesn't exist | Report error and **stop** |
| Scope is empty (no source files at all) | Report "no files to scan" and **stop** |
| Scope has files but none in a deterministic-backend language (e.g. only Go/Rust) | Do NOT stop. Run the LLM pattern scanner best-effort, label all such files "pattern-only" in the Coverage line (F9) |
| An agent fails | Report partial results from successful agents. Note which scanner failed and why |
| `gh` not authenticated | Print report to terminal. Warn: "GitHub issue creation skipped — run `gh auth login`" |
| Code snippet read fails | Skip snippet for that finding, use `file:line` only |
| Agent omits `fix_hint` | Omit the `**Fix:**` line for that finding |
| Sub-issue body exceeds limit | Truncate Low then Medium findings per sub-issue (see Step 5e) |
| Sub-issue creation fails | Skip it, note in parent's Notes section |
| Parent creation fails | Print all sub-issue URLs directly to terminal |
| Sub-issue API linking fails | Fall back to editing sub-issue body with `**Parent issue:** #{parent_number}` |
| `.harness/runtime/` not writable | Write the manifest under the system temp dir instead and print its path; never skip persisting it — the fix pass requires it |
| Issue creation skipped (`gh` unauthenticated) | Still write `findings.json` (Step 4.5) with `disposition: "pending"`; the manifest does not depend on GitHub |

---

## What This Skill Does NOT Do

- Does not fix debt itself — it persists a structured `findings.json` and files issues; the fix is
  done by `/orchestrate` (or `/refactor`) consuming that manifest per `references/auto-fix-handoff.md`
- Does not replace `ruff` or `pyright` — complements them with higher-level analysis
- Deterministic backends cover Python (radon) and TS/JS (fallow) only. Other languages
  (Go, Rust, Java, Ruby, …) get best-effort LLM pattern scanning, not tool-backed
  dead-code/complexity/duplication. Adding such backends is future work.
- Does not run tests or measure coverage — use `/coverage-guard` for that
- Does not modify any source files
- Does not track debt over time — each run is a fresh scan
- Does not analyze git history for bug hotspots
