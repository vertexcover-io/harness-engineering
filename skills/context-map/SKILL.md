---
name: context-map
description: >
  Maintains .harness/knowledge/context/ — a tiered map of WHY the codebase is shaped as it is: architecture,
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

Keep `.harness/knowledge/context/` — a tiered map of the *why* behind the code — accurate and current. Code
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
| `DECISIONS.md` | root | a `D-* → file` index for ALL decisions + full bodies for **cross-package** ones only | 1 |
| `standards/<shard>.md` | root | self-routing `S-*` prescriptive rules (how code MUST be written), each with `applies_to` globs | ~1/scope |
| `GLOSSARY.md` | root | domain vocabulary | 1 |
| `packages/<pkg>/PACKAGE.md` | tier-2 (**default**) | per package; index of sub-packages | ~1/pkg |
| `packages/<pkg>/<sub>/PACKAGE.md` | tier-2 (**default**) | the workhorse — deps, public surface, deep data in→out, inline gotchas | where intent differs |
| `files/<mirrored/path>.md` | exception (**rare**) | a single file's silent-failure landmine that does NOT generalize to its package | 0–few |

**Default is `PACKAGE.md`.** Per-file docs are the rare exception, only for a file-specific,
silent-data-loss landmine easy to reintroduce (e.g. an escaping order). Never mirror files 1:1.

**Slop guard:** a package/sub-package with no non-obvious intent gets a *thin* PACKAGE.md (purpose +
surface + data-flow only) — never padded. A mundane file gets NO `files/` doc. Absence is valid.

**Per-doc rules** (the literal templates live in `references/doc-formats.md` — read it before writing any doc):
- `## Data flows` = flow-trace grammar (below), one trace per `flow_fns` entry. Root doc *with* sub-packages
  = spine + link; root doc with *no* sub-packages = full traces live in it.
- `DATAFLOW.md` = cross-package spine (link to sub-package traces, don't duplicate). `ARCHITECTURE.md` =
  shape block + boundaries + layer-descent traces.
- `D-*` decisions tiered by `Governs` span: cross-package/system-wide → root `DECISIONS.md` (which also
  holds a `D-*→file` index for ALL ids); single-package → that `PACKAGE.md ## Decisions`. IDs global +
  stable; each body Why/Tradeoff/Governs; reference by id, never copy a body.
- `standards/<shard>.md` = `S-*` rules with `applies_to` globs + `enforced_by` (`eslint`/`tsconfig` fail
  CI = hard; `convention` = advisory, must be labelled).

---

## Mode select (first thing, always)

**Step 0 — layout guard** (contract: `../_shared/knowledge.md`). Standalone invocations
must not write a map into an ignored or pre-migration tree:

```bash
node "<plugin-root>/skills/_shared/knowledge.mjs" verify
```

- Exit 2 (`.harness/knowledge` gitignored) → **STOP** and surface the fix from the
  envelope — a map written there would be silently uncommitted.
- A pre-migration map root exists (the old context dir under the docs tree) but
  `.harness/knowledge/context/` is empty → the repo is unmigrated. Run
  `node "<plugin-root>/skills/_shared/knowledge.mjs" migrate` first (it moves the
  existing map with history preserved), then continue.

```
test -d .harness/knowledge/context && ls .harness/knowledge/context/*.md >/dev/null 2>&1
```
- Map exists (even partial — e.g. only one package mapped) → **SYNC MODE** (Part A). A no-arg sync
  covers the WHOLE codebase (A0) and bootstraps any package that has code but no doc yet.
- No `.harness/knowledge/context/` or empty → **BOOTSTRAP MODE** (Part B), then one SYNC pass.

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

---

## Part A — SYNC MODE

### A0. Resolve scope (default = WHOLE codebase)
Scope is the set of packages this sync covers. It is independent of git-change detection.
- **Path argument(s) given** (`$ARGUMENTS` non-empty) → scope = those paths' package(s) only.
- **No argument** → scope = **the entire codebase** — every package/sub-package that has code OR a
  `PACKAGE.md`. Do NOT narrow scope to "what git changed" — a no-arg sync must reconcile the full map.
- **A `.harness/features/<name>/` path among the args** is not a scope — it's a **decision source** (see A2
  "Decision sources"): read its `design.md`/`plan.md` to transcribe recorded decisions. Code paths set
  scope; the spec dir sets the rationale source.

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
When creating or updating any doc, consult `references/doc-formats.md` for the exact block to copy.
- Doc exists → re-read the changed files. Update Purpose/surface/data-flow/gotchas/decisions only if
  the *why* changed. Refresh `key_files`, `last_verified_sha`.
- **In-scope package has code but NO `PACKAGE.md`** (e.g. a prior run only mapped one package) →
  dispatch a B2 exploration agent for it and create its docs. This is the common no-arg case after a
  partial bootstrap — sync must close the gap, not silently skip undocumented packages.
- Sub-package gained non-obvious intent and has no doc → create its `PACKAGE.md`.
- New decision → assign a global `D-*` id, **route by `Governs`** (cross-package → root `DECISIONS.md`;
  single-package → that `PACKAGE.md ## Decisions`), add a row to the root index. Source the rationale per
  "Decision sources" below (transcribe from the spec, don't re-derive).
- A flow changed → re-trace the affected `## Data flows` function(s) and update the cross-package
  trace in `DATAFLOW.md` / module trace in `ARCHITECTURE.md`.
- A file gained a file-specific silent landmine → add a `files/` exception doc (rare).
- **Standards re-derive** → if the package's `eslint.config.*`/`tsconfig`/`pyproject` changed, or a
  layering boundary shifted, re-derive its standards (the B2 standards-derivation rule) and update the
  matching `standards/*.md` shard (rules, `applies_to`, `enforced_by`). A newly-mapped package gets its
  `standards/<pkg>.md` created.

#### Decision sources — transcribe the recorded *why*, don't re-derive it
The rationale is *already written* in `.harness/features/<name>/design.md` (+ `plan.md`) — ingest it, don't
reconstruct from code (which loses the *why* and the rejected alternatives). If a spec dir is available
(orchestrate passes its path; else use a recently-touched one), transcribe each recorded **cross-cutting**
decision's **Why/Tradeoff** into its `D-*`, set **Governs** to what it touches, then **verify against code**
(code wins on conflict → flag stale). `design.md` = authoritative for *why*; code = for *what shipped*.
No spec → fall back to deriving from the diff (lossy, last resort).

### A3. Detect orphans & staleness (the safety check)
- **Orphan**: a `PACKAGE.md` whose `governs:` dir, or a `files/` doc whose `mirrors:` file, no longer
  exists → move (if renamed) or delete.
- **Stale key_files/symbols**: any listed file/symbol not found (`grep`) → update or flag.
- **Flow-trace drift (soft flag)**: for each `flow_fns:` entry, if its file appears in this run's
  `git diff` (changed since the doc's `last_verified_sha`), the trace MAY be stale even though the
  function still exists — re-read that function and re-trace it; if you cannot confirm it this run,
  list it under `trace-needs-review:` in the report. This is a WARNING, not a FAIL (grep can't verify
  internal logic — code stays authoritative).
- **Dangling refs**: any `D-*` referenced in a doc that is missing from the root `DECISIONS.md` **index**
  (the index lists every id and its home file — resolve through it, not by assuming the body is in
  `DECISIONS.md`); any package named in `DATAFLOW.md` that no longer exists → flag. Also flag an index
  row whose `lives in` file no longer contains that `D-*` body.
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
Write `.harness/knowledge/context/.sync-report.md`:
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

### A5. Refresh the knowledge index
If this run created, updated, or deleted any `standards/*.md` shard, the Tier-0 knowledge index
(`.harness/knowledge/INDEX.md` — derived from lesson + standards frontmatter, injected at SessionStart,
read by lesson routing) is now stale. Refresh it (contract: `../_shared/knowledge.md`):

```bash
node "<plugin-root>/skills/_shared/knowledge.mjs" reindex
```

Surface its `{stale}` entries as a warning line in the report. On failure, record
`knowledge skipped — <reason>` and continue — this step never fails the sync.

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
Give each agent the **package root, not a fixed file list** (it re-runs `git ls-files <pkg>` itself so a
stale list can't make it miss files), plus the per-doc rules + flow-trace grammar above and
**`references/doc-formats.md` (it MUST read this for the literal templates)**. Each agent MUST:
1. **Discover and read every code file in its package** (`git ls-files`), skim mundane, study
   logic/decision-bearing ones. **Never describe or claim a fact about a file you did not open** — if a
   trace or gotcha depends on a helper in another file, open that file or hedge the claim explicitly.
2. Produce **one `PACKAGE.md` for the package** + one per sub-package with distinct intent (templates in
   `references/doc-formats.md`).
3. **Trace the flow-bearing fns INSIDE the PACKAGE.md body** — grammar traces in the doc's `## Data flows`
   section (NOT prose/numbered, NOT the top-level `flows[]`), one per fn, each listed in `flow_fns:`.
   `flow_fns` ↔ `## Data flows` must agree. Pure getters/CRUD get a `## Public surface` line, not a trace.
   Trace from real code, not a guess. In-package flows stay here even if `flows[]` (step 8) is empty.
4. Account for **every file**: each is either reflected in a PACKAGE.md's `key_files`/surface, or
   listed in `skipped: [{path, reason}]` (mundane) — so coverage is provable.
5. Propose only a `files/` exception doc where a single file has a non-generalizable silent landmine.
6. Surface cross-cutting decisions as candidate `D-*` (id, title, why, tradeoff, governs).
7. **Derive prescriptive standards (`S-*`) — from what the repo ENFORCES, never invent.** In priority order:
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
8. Return in top-level `flows[]` **ONLY cross-package flows** — a flow that starts in this package and
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
                            #   derived from config/observed (step 7); applies_to scopes where it holds
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
- Assign **global stable** `D-*` ids across all agents. **Route each by `Governs` span**: cross-package
  (or system-wide) → full body in root `DECISIONS.md`; single-package → full body in that package's
  `PACKAGE.md ## Decisions`. Write the root `DECISIONS.md` with the `D-* → file` index (every id) plus the
  cross-package bodies; write package-local bodies into their `PACKAGE.md` (format in `references/doc-formats.md`).
- **Merge `standards` into `.harness/knowledge/context/standards/*.md`**: group candidate rules by scope into shards
  (`global.md` for `["**/*"]` rules, one `<pkg>.md` per package, layer shards like `routes.md`, language
  shards). Assign stable `S-*` ids (`S-<scope>-NN`), dedupe identical rules across packages, write each
  shard with its `applies_to`/`enforced_by` frontmatter, cross-link `decisions:`. A shard with no real
  rules is not written (no empty slop).
- Write every `package_docs[].md_body` to `.harness/knowledge/context/packages/<...>/PACKAGE.md`, rewriting `D-*`
  refs to the assigned ids; ensure each sub-package doc's `## Data flows` traces and `flow_fns:` are present.
- Write `file_exceptions` to `.harness/knowledge/context/files/<mirrored/path>.md`.
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

## Top failure modes (each is enforced in the step above — this is the quick checklist)
- `flow_fns` and the `## Data flows` traces must agree; `flows[]` is cross-package ONLY (in-package traces live in PACKAGE.md).
- Never claim a fact about a file you didn't open; on any code↔doc conflict, code wins and the doc is flagged.
- Don't invent a standard from a habit (mark non-linted ones `convention`); don't copy a `D-*` body anywhere — reference by id.
- Slop guard: no per-file mirroring, no tracing pure getters/CRUD, no padding a thin module, no restating code.

## References
- `references/doc-formats.md` — the literal format/template for every `.harness/knowledge/context/` doc (read before writing one).
