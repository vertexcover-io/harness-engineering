---
name: context-map
description: >
  Maintains docs/context/ — a tiered map of WHY the codebase is shaped as it is: architecture,
  cross-package data flows, per-package intent (deps, public surface, data in→out, inline gotchas),
  and a decisions log. Data flow is captured as function-level traces (indented branching trees), in
  both DATAFLOW.md (cross-package) and each sub-package. Use when the user says "sync context",
  "update context map", "generate context docs", or as the mandatory pre-quality-gate sync step. If no
  map exists, fans out one exploration agent per package to map the whole codebase. Code is
  authoritative; context docs are advisory and staleness-checked.
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

## Flow-trace grammar (used in Data flows, DATAFLOW.md, ARCHITECTURE.md)

How data flows is shown as an **indented text tree at function granularity** — NOT flat in/out lists,
NOT ASCII box-art. The tree IS the information: it maps a concrete input through each transform to a
concrete output, branching where the code branches.

```
<fn>(<args>) → <return>:
  <input> → <step> → <step>
    ├─ <condition>  → <transform> → <output>        (D-xx)
    └─ <condition>  → <transform> → <output>
       (<edge case / legacy / contract note>)
```
Rules:
- 2 spaces per nesting level; `├─` / `└─` for branches; `→` for sequential transforms.
- Name sources/sinks concretely: `Redis run-state`, `run_archives`, `run_logs`, a table, a queue — not "the DB".
- Put the deciding decision inline on its branch as `(D-xx)`; keep the body in DECISIONS.md.
- One trace **per flow-bearing function only** — a function with branching, a multi-step transform, or a
  boundary crossing (DB/Redis/queue/HTTP/another package). Pure getters / thin CRUD / passthroughs get a
  single `## Public surface` line, NOT a trace (slop guard).

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
## Data flows         # the package's headline flows, 1-line each → link to DATAFLOW.md + sub-pkg traces
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
flow_fns: [file.ts::fnName, ...]   # the flow-bearing fns traced below — sync watches these for drift
decisions: [D-0xx]
status: active
---

# <sub>/ — <one-line>

## Purpose
## Public surface          # fn(args) → effect, 1 line each (the NON-flow-bearing ones live only here)
## Depends on / used by     # Uses: ...  Used by: ...
## Data flows               # function-level traces in the flow-trace grammar — one per flow-bearing fn
  <fn>(<args>) → <return>:
    <input> → <step>
      ├─ <condition> → <transform> → <output>   (D-xx)
      └─ <condition> → <transform> → <output>
  <fn2>(<args>) → <return>:
    ...
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

### `DATAFLOW.md` — named cross-package flows, traced end-to-end
Each named flow is a **function-level trace in the flow-trace grammar**, following the data from its
entry function across every package hop to its terminal output — branching where the system branches.
Name the actual functions and stores at each hop (`route → service::fn → repo::fn → table → queue →
(other package) worker::fn`). Put deciding `D-*` inline on the branch. End each flow with a `Detail:`
line linking the sub-package traces (`routes/PACKAGE.md § Data flows`, …) for the per-hop depth — link,
don't duplicate. The cross-package trace shows the SPINE; the sub-package trace shows the inside of a hop.

### `ARCHITECTURE.md` — shape + boundaries + module-level traces
- One small, stable system-shape block is fine (the only place ASCII boxes are allowed).
- **Boundaries & contracts** as text.
- **Module-level traces** in the flow-trace grammar: how a request descends the layers, e.g.
  `request → app.ts gate → route handler → service::fn → repository::fn → Postgres → response`,
  branching on the gate / public-vs-admin / live-vs-terminal splits. Function granularity, not prose.

### `DECISIONS.md` — `D-*` entries
Each: **Why**, **Tradeoff**, **Governs** (file/dir list). Referenced by id; never copied into a doc.

### `INDEX.md`, `GLOSSARY.md`
Read-order + package map; domain vocab. See tier table.

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
- A flow changed → re-trace the affected `## Data flows` function(s) and update the cross-package
  trace in `DATAFLOW.md` / module trace in `ARCHITECTURE.md`.
- A file gained a file-specific silent landmine → add a `files/` exception doc (rare).

### A3. Detect orphans & staleness (the safety check)
- **Orphan**: a `PACKAGE.md` whose `governs:` dir, or a `files/` doc whose `mirrors:` file, no longer
  exists → move (if renamed) or delete.
- **Stale key_files/symbols**: any listed file/symbol not found (`grep`) → update or flag.
- **Flow-trace drift (soft flag)**: for each `flow_fns:` entry, if its file appears in this run's
  `git diff` (changed since the doc's `last_verified_sha`), the trace MAY be stale even though the
  function still exists — re-read that function and re-trace it; if you cannot confirm it this run,
  list it under `trace-needs-review:` in the report. This is a WARNING, not a FAIL (grep can't verify
  internal logic — code stays authoritative).
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
- trace-needs-review: 1 (services.ts::buildRunObservability changed — re-traced)
- no-change: 3 packages reviewed
verdict: PASS   (no unresolved orphans, stale symbols, or dangling refs)
```
Verdict is `FAIL` on any unresolved orphan / stale symbol / dangling ref. `trace-needs-review` is a
WARNING (does not fail the gate). **Quality-gate must block on a missing report or a FAIL verdict.**

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
   distinct intent (deps, public surface, gotchas).
3. **Trace the flow-bearing functions** — for each function with branching / multi-step transform /
   boundary crossing, write a `## Data flows` trace in the flow-trace grammar (function-level, branches
   as a tree, stores named, `D-*` inline). List the traced fns in `flow_fns:`. Pure getters/CRUD do NOT
   get traced. Trace from the real code, not a guess.
4. Account for **every file**: each is either reflected in a PACKAGE.md's `key_files`/surface, or
   listed in `skipped: [{path, reason}]` (mundane) — so coverage is provable.
5. Propose only a `files/` exception doc where a single file has a non-generalizable silent landmine.
6. Surface cross-cutting decisions as candidate `D-*` (id, title, why, tradeoff, governs).
7. Return the cross-package flows this package participates in as **function-level traces** (entry fn →
   each hop fn/store → output, with branches) for `DATAFLOW.md`; a 2–4 line summary + the layer-descent
   trace for `ARCHITECTURE.md`; and any domain terms for `GLOSSARY.md`.

Return shape per agent (structured):
```
{ package, files_total,
  package_docs: [{path, md_body}],          # PACKAGE.md (package + sub-packages)
  file_exceptions: [{path, md_body}],       # rare
  skipped: [{path, reason}],
  decisions: [{title, why, tradeoff, governs}],
  flows: [{name, trace}],          # trace = function-level flow-trace-grammar string, entry→hops→output
  arch_trace, arch_summary, glossary_terms }
```

### B3. Merge & write the tree
- Assign stable `D-*` ids across all agents; write `DECISIONS.md`.
- Write every `package_docs[].md_body` to `docs/context/packages/<...>/PACKAGE.md`, rewriting `D-*`
  refs to the assigned ids; ensure each sub-package doc's `## Data flows` traces and `flow_fns:` are present.
- Write `file_exceptions` to `docs/context/files/<mirrored/path>.md`.
- Compose `DATAFLOW.md` by stitching agents' `flows[].trace` into end-to-end cross-package traces
  (entry package → each hop → terminal output), branching where the system branches, with `Detail:`
  links into the sub-package `## Data flows`. Link, don't duplicate the per-hop interior.
- Compose `ARCHITECTURE.md` (small shape block + boundaries + the layer-descent `arch_trace`s),
  `INDEX.md` (read-order + map), `GLOSSARY.md` (merged terms).
- Stamp every doc: `last_verified_sha` = current HEAD; populate `key_files`/`symbols`/`flow_fns`.

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
- Don't duplicate a hop's interior into `DATAFLOW.md` — the cross-package trace is the spine; link to
  the sub-package `## Data flows` for the inside of a hop.
- Don't write flat In/Out/contract lists for data flow — use function-level traces in the flow-trace
  grammar (the tree IS the information). Don't use ASCII box-art (one small shape block in ARCHITECTURE excepted).
- Don't trace pure getters / thin CRUD / passthroughs — only flow-bearing functions (slop guard).
- Don't let a context doc override code — on conflict, code wins, flag the doc.
- Don't skip a package or leave any code file unaccounted (documented or explicitly skipped).
- Don't pad a thin module into slop; don't restate code — capture only the *why*, flow, and landmine.
