---
name: context-map
description: >
  Maintains docs/context/ — a tiered map of WHY the codebase is shaped as it is: architecture,
  cross-package data flows, per-package intent (deps, public surface, data in→out, inline gotchas),
  a decisions log, and self-routing prescriptive standards (S-* shards with applies_to globs, derived
  from what the repo enforces). Data flow is captured as function-level traces (indented branching trees), in
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
| `standards/<shard>.md` | root | self-routing `S-*` prescriptive rules (how code MUST be written), each with `applies_to` globs | ~1/scope |
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
- Map exists (even partial — e.g. only one package mapped) → **SYNC MODE** (Part A). A no-arg sync
  covers the WHOLE codebase (A0) and bootstraps any package that has code but no doc yet.
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
flow_fns: [file.ts::fnName, ...]   # ONLY if traces live in this doc (no sub-packages) — else omit
decisions: [D-0xx]
status: active
---

# <pkg> — <one-line role>

## Purpose            # what it owns, no code restatement
## Public surface     # entry points / key exports + 1-line contract each
## Depends on / used by
## Data flows         # SEE RULE BELOW
## Sub-packages       # index of <sub>/PACKAGE.md
## Gotchas / landmines
## Decisions          # D-* one-liners
```
**`## Data flows` rule (root doc):**
- Package **has sub-packages** → spine only: 1 line per headline flow → link to DATAFLOW.md + the
  `<sub>/PACKAGE.md § Data flows` where the full trace lives. Don't duplicate the trace here.
- Package **has NO sub-packages** (the root doc IS the workhorse — e.g. eslint-plugin, scripts) → the
  **full function-level grammar traces live HERE**, one per flow-bearing fn, and `flow_fns:` lists them.
  There is no sub-package to delegate to, so prose/1-liners are NOT acceptable — write the trees.

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

### `standards/<shard>.md` — `S-*` prescriptive, self-routing rules
DECISIONS answers "why did we choose X *once*" (descriptive, past). STANDARDS answers "how must *all*
code be written" (prescriptive, future). A standard may cite the decision behind it via `decisions:` —
link, never copy the `D-*` body. Shard by scope so injection can route by file: `global.md`
(`["**/*"]`), one per package (`["packages/<pkg>/src/**"]`), per layer (`["**/routes/**"]`), per language
(`["**/*.py","**/*.pyi"]` — mostly a pointer to the code-quality skill, do NOT restate it).
```markdown
---
id: S-<scope>
applies_to: ["packages/api/src/**", "**/routes/**"]   # globs; the injector matches the edited file against these
enforced_by: eslint                                    # eslint | tsconfig | convention
decisions: [D-0xx]                                     # underlying D-* if any (link, don't duplicate)
last_verified_sha: <short HEAD>
status: active
---
# <scope> standards
## S-<scope>-01 — <rule title>
**Rule:** <the constraint, imperative>
**Why:** <one line, or → (D-0xx)>
**Enforced by:** <eslint rule name (fails CI) | tsconfig flag | convention (not linted)>
**Smell:** <the anti-pattern to grep for>
```
`enforced_by` is the priority signal: `eslint`/`tsconfig` rules fail CI (hard); `convention` rules are
advisory (soft) and MUST be labelled so an agent never treats a habit as a law.

### `INDEX.md`, `GLOSSARY.md`
Read-order + package map; domain vocab. See tier table.

---

## Part A — SYNC MODE

### A0. Resolve scope (default = WHOLE codebase)
Scope is the set of packages this sync covers. It is independent of git-change detection.
- **Path argument given** (`$ARGUMENTS` non-empty) → scope = that path's package(s) only.
- **No argument** → scope = **the entire codebase** — every package/sub-package that has code OR a
  `PACKAGE.md`. Do NOT narrow scope to "what git changed" — a no-arg sync must reconcile the full map.

```
git ls-files '*.ts' '*.tsx' '*.py' '*.go' '*.rs' '*.js' \
  | grep -vE '__tests__|\.test\.|\.spec\.|node_modules|dist|build'
```
Group the result by package/sub-package = the in-scope units. Also include any existing `PACKAGE.md`
whose `governs:` dir still has code. **A package with code but no doc is in scope** (its doc is missing
and must be created — same as a partial prior run that only mapped one package).

If the in-scope set is large and the map is partial (some packages have code but no `PACKAGE.md`),
dispatch **one agent per undocumented package** exactly as BOOTSTRAP B2 does — bootstrap is just sync
over packages whose docs don't exist yet. Documented packages are reconciled in-line per A2.

### A1. Within scope, find what to re-verify
For documented packages, use `git diff --name-only <doc's last_verified_sha>..HEAD` (per doc, falling
back to `HEAD` working-tree diff) to find files changed since each doc was last verified — these get a
full re-read. Files unchanged since `last_verified_sha` need only an existence/orphan check, not a
re-trace. Map each changed code file to its **owning package/sub-package** (not a per-file doc).

### A2. Reconcile each in-scope package against its `PACKAGE.md`
- Doc exists → re-read the changed files. Update Purpose/surface/data-flow/gotchas/decisions only if
  the *why* changed. Refresh `key_files`, `last_verified_sha`.
- **In-scope package has code but NO `PACKAGE.md`** (e.g. a prior run only mapped one package) →
  dispatch a B2 exploration agent for it and create its docs. This is the common no-arg case after a
  partial bootstrap — sync must close the gap, not silently skip undocumented packages.
- Sub-package gained non-obvious intent and has no doc → create its `PACKAGE.md`.
- New cross-cutting decision → add a `D-*` to `DECISIONS.md`; reference it (don't inline the body
  except as a one-line gotcha).
- A flow changed → re-trace the affected `## Data flows` function(s) and update the cross-package
  trace in `DATAFLOW.md` / module trace in `ARCHITECTURE.md`.
- A file gained a file-specific silent landmine → add a `files/` exception doc (rare).
- **Standards re-derive** → if the package's `eslint.config.*`/`tsconfig`/`pyproject` changed, or a
  layering boundary shifted, re-run step 6b for it and update the matching `standards/*.md` shard (rules,
  `applies_to`, `enforced_by`). A newly-mapped package gets its `standards/<pkg>.md` created.

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
- **Standard staleness**: an `S-*` with `enforced_by: eslint|tsconfig` whose named rule/flag no longer
  exists in the config → flag stale (config wins, same as orphan). An `S-*` whose `applies_to` dirs no
  longer exist → update or drop.
- **Drifted roots**: packages/boundaries changed → update `ARCHITECTURE.md`/`INDEX.md`.
- **Scope coverage (no-arg sync)**: every in-scope package with code now has a `PACKAGE.md`. Any
  package with code and still no doc is a FAIL (it was skipped) — list it. A scoped (path-arg) sync
  only asserts coverage for the given path.
- **Cross-package recheck (scoped sync MUST still do this)**: a change in package A can invalidate a
  flow trace in package B's `DATAFLOW.md` or a `D-*` whose `governs` spans A. So even a path-scoped sync
  re-verifies any `DATAFLOW.md` flow and any `DECISIONS.md` `D-*` whose trace/governs **names a changed
  package** — not just the in-scope docs. Flag a now-wrong cross-package trace for re-trace. (Scoped sync
  stays fast on PACKAGE.md/standards but never lets cross-package drift pass silently.)

### A4. Emit the sync-report (required — the gate reads this)
Write `docs/context/.sync-report.md`:
```
context-map sync @ <sha>
- scope: whole codebase   (or: packages/api — scoped to argument)
- packages in scope: 4    (documented: 4, newly mapped this run: 0, uncovered: 0)
- updated: packages/pipeline/social/PACKAGE.md (LTF gotcha + key_files)
- created: packages/api/routes/PACKAGE.md
- dataflow: updated "daily digest" (new publish hop)
- orphan-fixed: 1 (sub-package renamed)
- standards: created 1 (standards/web.md), updated 1 (standards/api.md — new eslint rule), stale 0
- stale-refs: 0
- trace-needs-review: 1 (services.ts::buildRunObservability changed — re-traced)
- no-change: 3 packages reviewed
verdict: PASS   (no unresolved orphans, stale symbols, dangling refs, or uncovered in-scope packages)
```
Verdict is `FAIL` on any unresolved orphan / stale symbol / dangling ref / **in-scope package with code
but no doc**. `trace-needs-review` is a WARNING (does not fail the gate). **Quality-gate must block on a
missing report or a FAIL verdict.**

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
Each agent gets: its package root, the tier formats above, the flow-trace grammar, the slop guard, and
the rule that PACKAGE.md is the default. Give it the **package root, not a fixed file list** — the agent
re-runs `git ls-files <pkg>` itself so a stale or partial list can't cause it to miss files. Each agent MUST:
1. **Discover and read every code file in its package** (`git ls-files`), skim mundane, study
   logic/decision-bearing ones. **Never describe or claim a fact about a file you did not open** — if a
   trace or gotcha depends on a helper in another file, open that file or hedge the claim explicitly.
2. Produce **one `PACKAGE.md` for the package** + a `PACKAGE.md` for each sub-package that has
   distinct intent (deps, public surface, gotchas).
3. **Trace the flow-bearing functions INSIDE the PACKAGE.md body.** For each function with branching /
   multi-step transform / boundary crossing, write a trace in the flow-trace grammar (function-level,
   branches as a tree with `├─`/`└─`/`→`, stores named, `D-*` inline) **into that doc's `## Data flows`
   section of `md_body`** — NOT as prose, NOT a numbered list, and NOT in the top-level `flows[]` array.
   The `## Data flows` section is a sequence of grammar traces, one per flow-bearing fn. Then list every
   traced fn in the doc's `flow_fns:` frontmatter as `file.ts::fnName`. Pure getters/CRUD do NOT get
   traced (they get one `## Public surface` line). Trace from the real code, not a guess.
   **`flow_fns` and the `## Data flows` traces must agree** — every fn in `flow_fns` has a trace and vice
   versa. A package whose only flows are in-package still puts them here; `flows[]` (step 7) stays empty.
4. Account for **every file**: each is either reflected in a PACKAGE.md's `key_files`/surface, or
   listed in `skipped: [{path, reason}]` (mundane) — so coverage is provable.
5. Propose only a `files/` exception doc where a single file has a non-generalizable silent landmine.
6. Surface cross-cutting decisions as candidate `D-*` (id, title, why, tradeoff, governs).
6b. **Derive prescriptive standards (`S-*`) — from what the repo ENFORCES, never invent.** In priority order:
   (1) **Config as ground truth — but verify it actually fails CI.** Read `eslint.config.*`
   (`no-restricted-imports` blocks, custom rules), `tsconfig` strict flags, `pyproject`/pyright. A rule
   only earns `enforced_by: eslint|tsconfig` if its **severity is `error`** (a `warn` rule does NOT fail
   CI → mark it `convention`) AND lint/typecheck actually runs in CI (check the CI workflow / lint script
   exists). If you cannot confirm CI runs it, downgrade to `convention` — never claim "fails CI" on faith.
   Put the real rule name + severity in **Enforced by**. (2) **Observed invariants** that hold across the *whole*
   package (every route delegates to a service; every repo returns a typed result) → `enforced_by:
   convention`, explicitly labelled "not linted." (3) **Language strictness** → a single `S-*` that
   *points at the code-quality skill ref*, never restating it. Give each candidate an `applies_to` glob
   set scoped to where it holds, and cite any underlying `D-*` in `decisions`. When unsure a rule is real,
   drop it — a wrong "standard" misleads every future agent.
7. Return in top-level `flows[]` **ONLY cross-package flows** — a flow that starts in this package and
   crosses into another package (route → service → repo → table → queue → other-package worker), as a
   function-level trace for `DATAFLOW.md`. **If every flow in this package stays inside the package
   (lint-time rules, standalone scripts, pure utilities), return `flows: []`** — those traces already
   live in the PACKAGE.md `## Data flows` (step 3) and must NOT be duplicated here. Also return a 2–4
   line summary + the layer-descent trace for `ARCHITECTURE.md`; and any domain terms for `GLOSSARY.md`.

Return shape per agent (structured):
```
{ package, files_total,
  package_docs: [{path, md_body}],   # PACKAGE.md (package + sub-pkgs). md_body MUST contain the
                                     #   `## Data flows` grammar traces AND a `flow_fns:` frontmatter
                                     #   listing them. This is where ALL in-package traces live.
  file_exceptions: [{path, md_body}],       # rare — single-file silent landmine only
  skipped: [{path, reason}],                # every file not in a doc's surface/key_files, with reason
  decisions: [{title, why, tradeoff, governs}],
  standards: [{applies_to:[glob], enforced_by, decisions:[D-id], rules:[{title, rule, why, smell}]}],
                            #   derived from config/observed (step 6b); applies_to scopes where it holds
  flows: [{name, trace}],   # CROSS-PACKAGE flows ONLY (this pkg → another pkg), for DATAFLOW.md.
                            #   EMPTY ([]) if all flows stay in-package — do NOT put in-package traces
                            #   here; they belong in package_docs[].md_body `## Data flows`.
  arch_trace, arch_summary, glossary_terms }
```
**Self-check before returning:** (a) every flow-bearing fn has a grammar trace in its PACKAGE.md
`## Data flows` and an entry in `flow_fns:`; (b) `flows[]` holds only package-crossing flows (else `[]`);
(c) `documented ∪ skipped == every file you were given` — nothing dropped; (d) no claim about a file
you did not open (if a referenced helper wasn't in your file list, hedge it, don't assert it).

### B3. Merge & write the tree
- **Validate each returned doc before writing** (repair or re-dispatch the agent if it fails): the
  `## Data flows` section is grammar traces (has `→` and tree branches), NOT prose or numbered lists;
  `flow_fns:` is present and matches the traced fns; `flows[]` contains only package-crossing traces
  (move any in-package trace that leaked into `flows[]` back into the doc's `## Data flows`). A doc with
  a flow-bearing fn but a prose/empty `## Data flows`, or with a missing `flow_fns`, is non-conforming.
- Assign stable `D-*` ids across all agents; write `DECISIONS.md`.
- **Merge `standards` into `docs/context/standards/*.md`**: group candidate rules by scope into shards
  (`global.md` for `["**/*"]` rules, one `<pkg>.md` per package, layer shards like `routes.md`, language
  shards). Assign stable `S-*` ids (`S-<scope>-NN`), dedupe identical rules across packages, write each
  shard with its `applies_to`/`enforced_by` frontmatter, cross-link `decisions:`. A shard with no real
  rules is not written (no empty slop).
- Write every `package_docs[].md_body` to `docs/context/packages/<...>/PACKAGE.md`, rewriting `D-*`
  refs to the assigned ids; ensure each sub-package doc's `## Data flows` traces and `flow_fns:` are present.
- Write `file_exceptions` to `docs/context/files/<mirrored/path>.md`.
- Compose `DATAFLOW.md` by stitching agents' `flows[].trace` into end-to-end cross-package traces
  (entry package → each hop → terminal output), branching where the system branches, with `Detail:`
  links into the sub-package `## Data flows`. Link, don't duplicate the per-hop interior.
- Compose `ARCHITECTURE.md` (small shape block + boundaries + the layer-descent `arch_trace`s),
  `INDEX.md` (read-order + map), `GLOSSARY.md` (merged terms).
- Stamp every doc (incl. `standards/*.md`): `last_verified_sha` = current HEAD; populate
  `key_files`/`symbols`/`flow_fns`/`applies_to`.

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
- **Bootstrap:** the coverage assertion + counts (PACKAGE.md, exceptions, decisions, standards, flows),
  then the sync verdict.

The map is **consumed at runtime**: a `SessionStart` hook injects the roots' headlines, and the
orchestrate/tdd coder dispatch injects each phase's owning `PACKAGE.md` + the `standards/*.md` shards
whose `applies_to` matches the phase's files. A clean `.sync-report.md` verdict directly improves the
context every coder sub-agent starts with — staleness here propagates into generated code.

## What NOT to do
- Don't mirror files 1:1 — PACKAGE.md is the default; per-file docs are rare exceptions.
- Don't invent a "standard" from a habit — derive `S-*` from config (eslint/tsconfig) or a whole-package
  invariant; mark anything not linted `enforced_by: convention`; drop it when unsure. Don't restate the
  code-quality skill or CLAUDE.md universals; don't copy a `D-*` body into a standard (link by id).
- Don't copy a decision body into multiple docs — define once in `DECISIONS.md`, reference by id
  (a one-line inline gotcha for safety is fine).
- Don't duplicate a hop's interior into `DATAFLOW.md` — the cross-package trace is the spine; link to
  the sub-package `## Data flows` for the inside of a hop.
- Don't write flat In/Out/contract lists or prose/numbered steps for data flow — use function-level
  traces in the flow-trace grammar (the tree IS the information). Don't use ASCII box-art (one small
  shape block in ARCHITECTURE excepted).
- Don't put in-package traces in the agent's `flows[]` — that field is cross-package ONLY; in-package
  traces live in the PACKAGE.md `## Data flows` body. Don't write a `## Data flows` trace without also
  listing the fn in `flow_fns:`.
- Don't claim anything about a file the agent didn't open — open it or hedge (code is authoritative).
- Don't trace pure getters / thin CRUD / passthroughs — only flow-bearing functions (slop guard).
- Don't let a context doc override code — on conflict, code wins, flag the doc.
- Don't skip a package or leave any code file unaccounted (documented or explicitly skipped).
- Don't pad a thin module into slop; don't restate code — capture only the *why*, flow, and landmine.
