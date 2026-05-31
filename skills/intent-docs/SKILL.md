---
name: intent-docs
description: >
  Maintains a parallel intent-docs tree (docs/intent/) that records WHY code exists —
  decisions, tradeoffs, invariants — mirrored per-file. Use when the user says "sync intent
  docs", "update intent", "generate intent docs", or as the mandatory pre-quality-gate sync
  step. If no intent docs exist yet, fans out exploration agents to map the whole codebase and
  bootstrap the tree. Code is authoritative; intent docs are advisory and staleness-checked.
argument-hint: "[path/to/scope or blank for full project]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# Intent Docs

Keep `docs/intent/` — a parallel tree recording the *why* behind the code — accurate and current.
Code answers *what*; intent docs answer *why this decision, what breaks if you change it*.

**Rule that governs everything:** code is authoritative. Intent docs are advisory context. On any
conflict, code wins and the doc is flagged stale — never the reverse.

**Announce at start:** "Syncing intent docs." (or "Bootstrapping intent docs — no tree found.")

---

## Mode select (first thing, always)

```
test -d docs/intent && ls docs/intent/*.md >/dev/null 2>&1
```

- Tree exists → **SYNC MODE** (Part A).
- No `docs/intent/` or empty → **BOOTSTRAP MODE** (Part B), then fall through to one SYNC pass.

This skill must always run when invoked. If nothing needs changing, it still produces a
sync-report and reports "no changes needed" — the invocation itself is the gate.

---

## Format (both modes produce exactly this)

**Per-file** `docs/intent/<mirrored/path>/<file>.md` — mirrors the code file's path and name
(`packages/api/src/auth/session.ts` → `docs/intent/packages/api/src/auth/session.md`):

```markdown
---
mirrors: packages/api/src/auth/session.ts
last_verified_sha: <git rev-parse --short HEAD>
symbols: [createSession, SESSION_TTL]
decisions: [D-003]
status: active
---

# session.ts — intent

## Purpose
One line. Not a restatement of the code.

## Key decisions (why)
- **[D-003] <decision>** — why; tradeoff accepted. (cross-cutting → defined in DECISIONS.md)

## Invariants / landmines
- <thing that MUST hold, or what breaks>
```

**Directory** `<dir>/PACKAGE.md` — when the *why* is about the module, not one file.

**Roots** in `docs/intent/`:
- `ARCHITECTURE.md` — components, boundaries, data flow.
- `DECISIONS.md` — append-only `D-*` log for cross-cutting tradeoffs. Per-file docs reference
  these by ID; never copy a decision into multiple files.
- `GLOSSARY.md` — domain terms (optional, grows on demand).

**Slop guard (hard rule):** a file with no non-obvious decision gets **no** `.md`. Absence means
"nothing worth saying," not "TODO." Never create a stub just to mirror a file.

---

## Part A — SYNC MODE

### A1. Find changed code
`git diff --name-only HEAD` (or against base branch). Keep code files only (drop docs, lockfiles,
generated). Resolve each to its mirror path.

### A2. Reconcile each changed file against its `.md`
- **Doc exists** → re-read code. Update Purpose/decisions/invariants only if the *why* changed.
  Refresh `symbols`. Set `last_verified_sha` to current HEAD.
- **Doc missing + file has a non-obvious decision** (new tradeoff, invariant, surprising design)
  → create it. Add a `D-*` to `DECISIONS.md` if cross-cutting.
- **Doc missing + file is mundane** → do nothing (slop guard).

### A3. Detect orphans & staleness (the safety check)
- **Orphan**: an `.md` whose `mirrors:` target no longer exists (file renamed/deleted) → move it
  to the new path if the file was renamed, else delete it.
- **Stale symbols**: any `symbols:` entry not found in the mirrored file (`grep`) → the doc's *why*
  may be outdated; update or flag.
- **Drifted root docs**: if packages/boundaries changed, update `ARCHITECTURE.md`.

### A4. Emit the sync-report (required — the gate reads this)
Write `docs/intent/.sync-report.md`:
```
intent-docs sync @ <sha>
- updated: docs/intent/.../session.md (refreshed symbols)
- created: docs/intent/.../archives-search.md → D-011
- orphan-fixed: connection.md moved (file renamed)
- stale-symbols: 0
- no-change: 12 files reviewed, mundane
verdict: PASS  (no unresolved orphans or stale symbols)
```
Verdict is `FAIL` if any orphan or stale-symbol is left unresolved. **Quality-gate must block on a
missing report or a FAIL verdict.**

---

## Part B — BOOTSTRAP MODE (no tree yet)

Goal: map **every code file**, leaving none unexplored, and generate an accurate, current tree in
the format above. Done by strategic parallel exploration — not one agent reading 400 files.

### B1. Partition the codebase
List all code files, grouped by natural area (package, then top-level source dir):
```
git ls-files '*.ts' '*.tsx' '*.py' '*.go' '*.rs' '*.js' \
  | grep -vE '__tests__|\.test\.|\.spec\.|node_modules|dist|build'
```
Form **one exploration agent per package/major area** (e.g. api, pipeline, web, shared). Split any
area with >~60 files into sub-areas (by directory) so no agent is overloaded. Record the partition
so coverage is auditable.

### B2. Dispatch exploration agents in parallel (one per area)
Each agent gets: its exact file list, the format spec above, and the slop guard. Each agent MUST:
1. Read every file in its area (skim mundane ones, study ones with logic/decisions).
2. Identify, per file, whether there is a **non-obvious decision, tradeoff, or invariant**.
3. For files that have one → return a complete per-file `.md` body in the exact format.
4. For mundane files → return them in a `skipped: [...]` list with a one-word reason (so coverage
   is provable — every file is either documented or explicitly skipped).
5. Surface cross-cutting decisions as candidate `D-*` entries (id, title, why, tradeoff, governs).
6. Return a 2–4 line area summary for `ARCHITECTURE.md` (purpose, boundaries, data flow in/out).

Return shape per agent (structured):
```
{ area, files_total, documented: [{path, md_body}], skipped: [{path, reason}],
  decisions: [{title, why, tradeoff, governs}], arch_summary }
```

### B3. Merge & write the tree
- Assign stable `D-*` ids across all agents' decisions; write `DECISIONS.md`.
- Write each `documented[].md_body` to its mirror path (`docs/intent/<path>/<file>.md`), rewriting
  per-file `decisions:` refs to the assigned `D-*` ids.
- Add a `PACKAGE.md` per area from its `arch_summary` when the area has shared intent.
- Compose `ARCHITECTURE.md` from the area summaries + the data-flow across areas.
- Stamp every doc: `last_verified_sha` = current HEAD, `symbols` from the file's exports.

### B4. Coverage assertion (no file left behind)
Assert `documented ∪ skipped == all code files`. Report any file in neither — never silently drop.
```
Bootstrap coverage: 439 files → 31 documented, 408 skipped (mundane), 0 unaccounted.
```
Then run **one A3/A4 pass** so the tree ships with a clean sync-report.

---

## Output

- **Sync:** the `.sync-report.md` contents + one-line verdict.
- **Bootstrap:** the coverage assertion + count of docs created + decisions logged, then the sync
  verdict.

## What NOT to do
- Don't create a `.md` for a file with no non-obvious intent.
- Don't copy a cross-cutting decision into multiple files — define once in `DECISIONS.md`, reference by id.
- Don't let an intent doc override code — on conflict, code wins, flag the doc.
- Don't leave any code file unaccounted in bootstrap (documented or explicitly skipped — never silent).
- Don't restate the code in prose; capture only the *why*, the tradeoff, the landmine.
