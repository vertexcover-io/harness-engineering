---
name: context-map
description: >
  Maintains docs/context/ — a tiered map of WHY the codebase is shaped as it is: architecture,
  cross-package data flows, per-package intent (deps, public surface, data in→out, inline gotchas),
  and a decisions log. Use when the user says "sync context", "update context map", "generate
  context docs", or as the mandatory pre-quality-gate sync step. If no map exists, fans out one
  exploration agent per package to map the whole codebase. Code is authoritative; context docs are
  advisory and staleness-checked.
argument-hint: "[path/to/scope or blank for full project]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# Context Map

Keep `docs/context/` — a tiered map of the *why* behind the code — accurate and current. Code
answers *what*; the context map answers *why this shape, what flows where, what breaks if you change it*.

**Rule that governs everything:** code is authoritative. Context docs are advisory. On any conflict,
code wins and the doc is flagged stale — never the reverse.

**Announce at start:** "Syncing context map." (or "Bootstrapping context map — none found.")

---

## The tier model (intent lives at the module + decision level, NOT per file)

| File | Tier | Holds | Count |
|---|---|---|---|
| `INDEX.md` | root | read-order + package map | 1 |
| `ARCHITECTURE.md` | root | system shape, package boundaries, system contracts | 1 |
| `DATAFLOW.md` | root | named flows across packages; links into each hop's `§ Data in → out` | 1 |
| `DECISIONS.md` | root | append-only `D-*` cross-cutting why/tradeoff/landmine log | 1 |
| `GLOSSARY.md` | root | domain vocabulary | 1 |
| `packages/<pkg>/PACKAGE.md` | tier-2 (**default**) | per package; index of sub-packages | ~1/pkg |
| `packages/<pkg>/<sub>/PACKAGE.md` | tier-2 (**default**) | the workhorse — deps, public surface, deep data in→out, inline gotchas | where intent differs |
| `files/<mirrored/path>.md` | exception (**rare**) | a single file's silent-failure landmine that does NOT generalize to its package | 0–few |

**Default is `PACKAGE.md`.** Per-file docs are the rare exception, only for a file-specific,
silent-data-loss landmine easy to reintroduce (e.g. an escaping order). Never mirror files 1:1.

**Slop guard:** a package/sub-package with no non-obvious intent gets a *thin* PACKAGE.md (purpose +
surface + data-flow only) — never padded. A mundane file gets NO `files/` doc. Absence is valid.

---

## Mode select (first thing, always)

```
test -d docs/context && ls docs/context/*.md >/dev/null 2>&1
```
- Map exists → **SYNC MODE** (Part A).
- No `docs/context/` or empty → **BOOTSTRAP MODE** (Part B), then one SYNC pass.

This skill always runs when invoked. If nothing needs changing it still emits a sync-report and
reports "no changes needed" — the invocation itself is the gate.

---

## Formats (both modes produce exactly these)

### Root `PACKAGE.md` (per package)
```markdown
---
governs: packages/<pkg>/src/
last_verified_sha: <short HEAD>
sub_packages: [a, b, c]
decisions: [D-0xx]
status: active
---

# <pkg> — <one-line role>

## Purpose            # what it owns, no code restatement
## Public surface     # entry points / key exports + 1-line contract each
## Depends on / used by
## Data in → out      # see DATAFLOW.md → <flow> for the cross-package trace
## Sub-packages       # index of <sub>/PACKAGE.md
## Gotchas / landmines
## Decisions          # D-* one-liners
```

### Sub-package `PACKAGE.md` (the workhorse — richest tier)
```markdown
---
governs: packages/<pkg>/src/<sub>/
last_verified_sha: <short HEAD>
key_files: [x.ts, y/z.ts]
decisions: [D-0xx]
status: active
---

# <sub>/ — <one-line>

## Purpose
## Public surface          # fn(args) → effect, 1 line each
## Depends on / used by     # Uses: ...  Used by: ...
## Data in → out
  In:  <shape of inputs + source>
  Out: <shape of outputs + destination + side effects>
  Boundary contract: <what it must never do / idempotency>
## Gotchas / landmines      # INLINE the relevant decision (don't force a DECISIONS.md fetch), keep D-* ref for depth
## Decisions
```

### `files/<mirrored/path>.md` (exception only)
```markdown
---
mirrors: packages/<pkg>/src/.../file.ts
last_verified_sha: <short HEAD>
symbols: [exportedSymbol]
decisions: [D-0xx]
status: active
reason_for_file_level: <why this file earns its own doc>
---

# file.ts — intent (exception doc)
## Why this file has its own doc   # 99% don't; justify
## The landmine
## The invariant
```

### `DATAFLOW.md` — named flows, map-level only
Each flow: the package-to-package hops, key handoffs (with `D-*`), and a `Detail:` line linking the
relevant `PACKAGE.md § Data in → out`. NEVER copy a package's inner detail here — link to it.

### `DECISIONS.md` — `D-*` entries
Each: **Why**, **Tradeoff**, **Governs** (file/dir list). Referenced by id; never copied into a doc.

### `INDEX.md`, `ARCHITECTURE.md`, `GLOSSARY.md`
Read-order + package map; system shape/boundaries/contracts; domain vocab. See tier table.

---

## Part A — SYNC MODE

### A1. Find changed code
`git diff --name-only HEAD` (or base branch). Keep code files only. Map each to its **owning
package/sub-package** (not a per-file doc).

### A2. Reconcile each touched package against its `PACKAGE.md`
- Doc exists → re-read the changed files. Update Purpose/surface/data-flow/gotchas/decisions only if
  the *why* changed. Refresh `key_files`, `last_verified_sha`.
- Sub-package gained non-obvious intent and has no doc → create its `PACKAGE.md`.
- New cross-cutting decision → add a `D-*` to `DECISIONS.md`; reference it (don't inline the body
  except as a one-line gotcha).
- A flow changed → update `DATAFLOW.md` and the affected `§ Data in → out` sections.
- A file gained a file-specific silent landmine → add a `files/` exception doc (rare).

### A3. Detect orphans & staleness (the safety check)
- **Orphan**: a `PACKAGE.md` whose `governs:` dir, or a `files/` doc whose `mirrors:` file, no longer
  exists → move (if renamed) or delete.
- **Stale key_files/symbols**: any listed file/symbol not found (`grep`) → update or flag.
- **Dangling refs**: any `D-*` in a doc missing from `DECISIONS.md`; any package named in
  `DATAFLOW.md` that no longer exists → flag.
- **Drifted roots**: packages/boundaries changed → update `ARCHITECTURE.md`/`INDEX.md`.

### A4. Emit the sync-report (required — the gate reads this)
Write `docs/context/.sync-report.md`:
```
context-map sync @ <sha>
- updated: packages/pipeline/social/PACKAGE.md (LTF gotcha + key_files)
- created: packages/api/routes/PACKAGE.md
- dataflow: updated "daily digest" (new publish hop)
- orphan-fixed: 1 (sub-package renamed)
- stale-refs: 0
- no-change: 3 packages reviewed
verdict: PASS   (no unresolved orphans, stale symbols, or dangling refs)
```
Verdict is `FAIL` on any unresolved orphan / stale symbol / dangling ref. **Quality-gate must block
on a missing report or a FAIL verdict.**

---

## Part B — BOOTSTRAP MODE (no map yet)

Goal: cover **every package and code file** — none unexplored — and generate the tiered map above.

### B1. Partition by package
```
git ls-files '*.ts' '*.tsx' '*.py' '*.go' '*.rs' '*.js' \
  | grep -vE '__tests__|\.test\.|\.spec\.|node_modules|dist|build'
```
Group by package, then by major sub-directory. Form **one exploration agent per package**
(api, pipeline, web, shared, …). Split any package with many sub-dirs so each agent owns a coherent
slice; record the partition so coverage is auditable. **No package may be skipped** — if a package
has files, it gets an agent.

### B2. Dispatch exploration agents in parallel (one per package)
Each agent gets: its package's file list, the tier formats above, the slop guard, and the rule that
PACKAGE.md is the default. Each agent MUST:
1. Read every file in its package (skim mundane, study logic/decision-bearing ones).
2. Produce **one `PACKAGE.md` for the package** + a `PACKAGE.md` for each sub-package that has
   distinct intent (deps, public surface, deep data in→out, inline gotchas).
3. Account for **every file**: each is either reflected in a PACKAGE.md's `key_files`/surface, or
   listed in `skipped: [{path, reason}]` (mundane) — so coverage is provable.
4. Propose only a `files/` exception doc where a single file has a non-generalizable silent landmine.
5. Surface cross-cutting decisions as candidate `D-*` (id, title, why, tradeoff, governs).
6. Return the package's data-flow (in/out + the named flows it participates in) for `DATAFLOW.md`,
   and a 2–4 line summary for `ARCHITECTURE.md`, plus any domain terms for `GLOSSARY.md`.

Return shape per agent (structured):
```
{ package, files_total,
  package_docs: [{path, md_body}],          # PACKAGE.md (package + sub-packages)
  file_exceptions: [{path, md_body}],       # rare
  skipped: [{path, reason}],
  decisions: [{title, why, tradeoff, governs}],
  flows: [{name, hops, handoffs}], data_in_out, arch_summary, glossary_terms }
```

### B3. Merge & write the tree
- Assign stable `D-*` ids across all agents; write `DECISIONS.md`.
- Write every `package_docs[].md_body` to `docs/context/packages/<...>/PACKAGE.md`, rewriting `D-*`
  refs to the assigned ids.
- Write `file_exceptions` to `docs/context/files/<mirrored/path>.md`.
- Compose `DATAFLOW.md` from all agents' `flows` (map-level; link into the `§ Data in → out`).
- Compose `ARCHITECTURE.md` (shape + boundaries + contracts), `INDEX.md` (read-order + map),
  `GLOSSARY.md` (merged terms).
- Stamp every doc: `last_verified_sha` = current HEAD; populate `key_files`/`symbols`.

### B4. Coverage assertion (no package, no file left behind)
Assert: every package with code has ≥1 PACKAGE.md; `documented ∪ skipped == all code files`. Report
anything unaccounted — never silently drop.
```
Bootstrap coverage: 4 packages → 14 PACKAGE.md, 2 file-exceptions; 439 files → 0 unaccounted.
```
Then run one A3/A4 pass so the map ships with a clean sync-report.

---

## Output
- **Sync:** `.sync-report.md` contents + one-line verdict.
- **Bootstrap:** the coverage assertion + counts (PACKAGE.md, exceptions, decisions, flows), then the
  sync verdict.

## What NOT to do
- Don't mirror files 1:1 — PACKAGE.md is the default; per-file docs are rare exceptions.
- Don't copy a decision body into multiple docs — define once in `DECISIONS.md`, reference by id
  (a one-line inline gotcha for safety is fine).
- Don't copy a package's inner data-flow into `DATAFLOW.md` — link to its `§ Data in → out`.
- Don't let a context doc override code — on conflict, code wins, flag the doc.
- Don't skip a package or leave any code file unaccounted (documented or explicitly skipped).
- Don't pad a thin module into slop; don't restate code — capture only the *why*, flow, and landmine.
