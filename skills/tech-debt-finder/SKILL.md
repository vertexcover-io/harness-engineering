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
- Identify all Python packages (look for `pyproject.toml` or `src/` dirs)
- Exclude: `node_modules/`, `.venv/`, `__pycache__/`, `build/`, `dist/`, `.git/`

### Step 2: Dispatch Parallel Scanners

Launch **3 agents in parallel** using the Agent tool. Each agent receives the resolved scope path and configuration. Each agent returns structured findings as a list of `{category, item, severity, detail, file, line}`.

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

Return findings with category `dependency`.

---

**Agent B — Structural & Complexity Scanner**

Detect debt in these categories:

| Debt Type | What It Looks Like | Severity |
|-----------|--------------------|----------|
| **God module** | Python file that is excessively long — too many responsibilities in one module | High |
| **High cyclomatic complexity** | Function with complexity >= 16 (use `radon` if available) | High |
| **Moderate cyclomatic complexity** | Function with complexity 11–15 | Medium |
| **Deep nesting** | Code indented beyond `nesting_depth` levels | Medium |
| **Business logic leakage** | ORM/DB calls, HTTP client calls, or validation logic in controller/handler/view files instead of the appropriate layer | High |
| **Import direction violation** | Lower layer importing from higher layer (e.g. models importing from providers, utils importing from domain code) | High |
| **Code duplication** | Substantial blocks of near-identical code across files — same logic with only minor variations (variable names, literals). Look for duplicated functions, repeated conditional chains, and copy-pasted blocks | Medium |

Return findings with category `architecture`, `complexity`, or `duplication`.

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

Return findings with their respective categories.

---

### Step 3: Collect & Classify

Merge all agent results into a single list. Classify by severity:

| Severity     | Criteria                                                                  |
|-------------|---------------------------------------------------------------------------|
| **Critical** | Known CVEs, bare `except:` with `pass`                                   |
| **High**     | God modules, swallowed exceptions, blocking in async, layer violations, mutable defaults |
| **Medium**   | High complexity (radon), `Any` overuse, deep nesting, magic numbers, duplication |
| **Low**      | Unused deps, commented-out code                                          |

**Deduplication:** If the same `file:line` appears in multiple categories, keep the highest severity instance.

**Sorting:** Within each severity group, sort by file path then line number.

### Step 4: Print Report to Terminal

Output the report directly to the user:

```
## Tech Debt Report — {scope}
**Scanned:** {file_count} files | **Date:** {YYYY-MM-DD}
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

### Step 5: Create GitHub Issue

Automatically create a GitHub issue with the findings. No confirmation needed.

**5a. Ensure the `tech-debt` label exists:**

```bash
gh label create "tech-debt" --color "D93F0B" --description "Technical debt findings" 2>/dev/null || true
```

**5b. Build the issue body.**

Read `references/issue-format.md` and follow the format specification exactly to build the issue body from the collected findings.

**5c. Handle body size limit.**

Follow the truncation rules in `references/issue-format.md`. Summary: if body exceeds 60000 characters, truncate Low findings first, then Medium. Never truncate Critical or High.

**5d. Create the issue:**

```bash
gh issue create \
  --title "Tech Debt Audit — {YYYY-MM-DD} — {scope}" \
  --label "tech-debt" \
  --body "$(cat <<'EOF'
{issue body}
EOF
)"
```

**5e. Print the issue URL** to the user after creation.

---

## Error Handling

| Scenario | Action |
|----------|--------|
| `radon` not installed | Skip complexity checks. Note in report: "Complexity checks skipped — install `radon`" |
| `pip-audit` not installed | Skip CVE checks. Note in report: "CVE checks skipped — install `pip-audit`" |
| Scope path doesn't exist | Report error and **stop** |
| No Python files in scope | Report "no files to scan" and **stop** |
| An agent fails | Report partial results from successful agents. Note which scanner failed and why |
| `gh` not authenticated | Print report to terminal. Warn: "GitHub issue creation skipped — run `gh auth login`" |
| Issue body exceeds limit | Truncate Low then Medium findings (see Step 5c) |

---

## What This Skill Does NOT Do

- Does not fix debt — use `/refactor` or `/orchestrate` for that
- Does not replace `ruff` or `pyright` — complements them with higher-level analysis
- Does not run tests or measure coverage — use `/coverage-guard` for that
- Does not modify any source files
- Does not track debt over time — each run is a fresh scan
- Does not analyze git history for bug hotspots
