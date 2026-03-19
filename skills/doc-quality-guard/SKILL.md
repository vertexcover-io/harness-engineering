---
name: doc-quality-guard
description: >
  Use when the user says "check docs", "audit docs", "doc quality", "doc slop",
  "stale docs", or wants to verify documentation accuracy and tone against the
  actual codebase.
argument-hint: "[path/to/docs or blank for full scan]"
allowed-tools: Bash, Read, Glob, Grep, Agent
---

## Project-Specific Guidelines

Check if `.claude/harness/doc-quality-guard-reference.md` exists in the project root.
If it does, read it and apply its guidelines alongside the defaults below.
User-provided guidelines take precedence on conflicts with defaults.

Note: `$ARGUMENTS` is reserved for scan scope (path or blank for full scan), not reference files.


# Doc Quality Guard

Audits documentation for **accuracy** (code-doc sync, staleness) and **tone** (AI slop), then generates a fix spec and hands off to `/orchestrate`.

**Announce at start:** "Using doc-quality-guard to audit documentation..."

---

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| **Scope** | `$ARGUMENTS` or `docs/` + `README.md` files | Directory/files to scan |
| **Spec output** | `dev-docs/superpowers/specs/YYYY-MM-DD-doc-quality-fixes-spec.md` | Where the fix spec is written |

---

## Execution Flow

### Step 1: Resolve Scope

Parse `$ARGUMENTS`:
- If a path is provided, scope scans to that directory/file
- If empty, scan `docs/` and all `README.md` files in the repo
- Collect all `.md` files in scope using Glob

### Step 2: Dispatch Parallel Scanners

Launch **up to 4 agents in parallel** using the Agent tool. Only dispatch agents whose scope overlaps with the resolved scan path. Each agent reads every doc file in its section, then cross-references against the corresponding source code.

**Agent Assignment:**

| Agent | Doc Scope | Source Code to Cross-Reference |
|-------|-----------|-------------------------------|
| **A: Providers** | `docs/providers/` | `packages/tarash-gateway/src/tarash/tarash_gateway/providers/` |
| **B: Guides + Getting Started** | `docs/guides/`, `docs/getting-started/` | `packages/tarash-gateway/src/tarash/tarash_gateway/` (public API surface) |
| **C: API Reference** | `docs/api-reference/` | `packages/tarash-gateway/src/tarash/tarash_gateway/` (all exports, models, exceptions) |
| **D: READMEs + Top-level** | `README.md`, `docs/index.md`, `packages/*/README.md` | Entire repo (links, feature claims, install instructions) |

**Each agent prompt must include:**

1. The list of doc files to scan (resolved via Glob)
2. The source code paths to cross-reference
3. The accuracy checklist (see below)
4. The AI slop pattern list (see below)
5. The tone reference instructions (see below)
6. The required output format (see below)

---

### Accuracy Checklist (include in every agent prompt)

Each agent checks for:

1. **Wrong API signatures** — doc shows method/function names, parameters, or return types that don't match actual source code
2. **Removed features** — doc references providers, models, functions, or config options that no longer exist
3. **Stale examples** — code examples use import paths, class names, or parameter names that have changed
4. **Wrong parameter tables** — documented parameters don't match actual model fields
5. **Dead links** — relative links to other doc pages or source files that don't resolve
6. **Outdated install instructions** — pip extras, package names, or dependency requirements that changed

---

### AI Slop Patterns (include in every agent prompt)

Flag these 8 patterns:

| Pattern | Examples |
|---------|---------|
| AI vocabulary | "Additionally", "leverage", "delve", "landscape", "seamlessly" |
| Promotional language | "breathtaking", "vibrant", "cutting-edge", "powerful" |
| Filler phrases | "In order to", "It's worth noting that", "Due to the fact that" |
| Chatbot tone | "Great question!", "I hope this helps!", "Let me know if..." |
| Excessive hedging | "It should be noted that", "It's important to understand" |
| Em dash overuse | Multiple `—` per paragraph |
| Generic conclusions | "By following these steps, you'll be well on your way to..." |
| Copula avoidance | "serves as" instead of "is", "functions as" instead of "does" |

---

### Tone Reference (include in every agent prompt)

The existing docs use a direct, factual, code-heavy style:
- Short sentences, no adjectives
- Tables for parameters
- Examples over explanations
- No filler, no fluff

Reference files for tone: `docs/getting-started/quickstart.md` and `docs/providers/openai.md`. Flag anything that deviates from this established voice.

---

### Agent Output Format

Each agent returns findings as structured text:

```
file: docs/providers/fal.md
issues:
  - type: accuracy
    severity: critical
    line: 42
    description: "References `generate_video_async` but method is now `agenerate_video`"
    suggested_fix: "Replace method name with `agenerate_video`"
  - type: slop
    severity: medium
    line: 15
    description: "AI vocabulary: 'Additionally' + 'seamlessly'"
    suggested_fix: "Rewrite to match direct tone of other provider docs"
```

If an agent finds no issues in its section, it returns: `No issues found.`

---

### Step 3: Aggregate & Classify

Merge all agent results into a single list. Classify by severity:

| Severity | What qualifies |
|----------|---------------|
| **Critical** | Wrong API signatures, references to removed features/providers, broken code examples |
| **High** | Stale parameters, dead internal links, outdated install instructions |
| **Medium** | AI slop patterns, tone deviations |
| **Low** | Minor style inconsistencies |

**Deduplication:** Same file + same line = keep highest severity.

**If zero issues found:** Print "Docs are clean — no accuracy or tone issues detected." and **stop**. No spec, no orchestrate.

### Step 4: Print Report to Terminal

```
## Doc Quality Report — {scope}
**Scanned:** {file_count} files | **Date:** {YYYY-MM-DD}
**Findings:** {critical} critical, {high} high, {medium} medium, {low} low

### Critical ({count})
| File | Line | Issue | Suggested Fix |
|------|------|-------|---------------|
| ... | ... | ... | ... |

### High ({count})
| File | Line | Issue | Suggested Fix |
|------|------|-------|---------------|
| ... | ... | ... | ... |

### Medium ({count})
| File | Line | Issue | Suggested Fix |
|------|------|-------|---------------|
| ... | ... | ... | ... |

### Low ({count})
| File | Line | Issue | Suggested Fix |
|------|------|-------|---------------|
| ... | ... | ... | ... |
```

### Step 5: Generate Fix Spec

Write to `dev-docs/superpowers/specs/YYYY-MM-DD-doc-quality-fixes-spec.md`:

```markdown
# Doc Quality Fixes Spec

## Goal
Fix {N} documentation issues found by doc-quality-guard audit.

## Context
- Existing doc tone: direct, factual, code-heavy, no adjectives
- Reference files for tone: docs/getting-started/quickstart.md, docs/providers/openai.md
- All accuracy fixes must be verified against actual source code

## Issues by File

### {file_path}
- **[critical]** Line {N}: {description} — Fix: {suggested_fix}
- **[high]** Line {N}: {description} — Fix: {suggested_fix}
- **[medium]** Line {N}: {description} — Fix: {suggested_fix}

(repeat for each file with issues)

## Acceptance Criteria
- [ ] All critical issues resolved
- [ ] All high issues resolved
- [ ] Medium issues addressed where possible
- [ ] No new AI slop introduced in fixes
- [ ] Code examples verified to match current source
```

### Step 6: Invoke Orchestrate

Hand off to `/orchestrate` with:

```
Run the spec at dev-docs/superpowers/specs/YYYY-MM-DD-doc-quality-fixes-spec.md

IMPORTANT: Skip brainstorm and QA stages — all context, file locations, and fix instructions are already in the spec. Go directly to planning.
```

---

## Error Handling

| Scenario | Action |
|----------|--------|
| Scope path doesn't exist | Report error and **stop** |
| No `.md` files in scope | Report "no markdown files found" and **stop** |
| An agent fails | Report partial results from successful agents. Note which scanner failed |
| All agents find no issues | Print clean message and **stop** |

---

## What This Skill Does NOT Do

- Does not fix docs itself — delegates to `/orchestrate`
- Does not check code quality — use `/tech-debt-finder`
- Does not check test coverage — use `/coverage-guard`
- Does not track quality over time — each run is a fresh scan
- Does not check external links (only internal relative links)
