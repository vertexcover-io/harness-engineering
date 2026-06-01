# Context map — doc format templates

Literal templates for every `docs/context/` doc. **Read this before writing or updating any context-map
doc, and copy the matching block.** The rules and the full procedure live in `SKILL.md`; this file is just
the structure to copy. (The flow-trace grammar referenced by the `## Data flows` sections is specified in
SKILL.md — keep it open alongside this.)

## Root `PACKAGE.md` (per package)
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

## Sub-package `PACKAGE.md` (the workhorse — richest tier)
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
## Data flows               # one flow-trace-grammar trace per flow-bearing fn (grammar in SKILL.md); must match flow_fns
## Gotchas / landmines      # INLINE the relevant decision (don't force a DECISIONS.md fetch), keep D-* ref for depth
## Decisions
```

## `files/<mirrored/path>.md` (exception only)
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

## `DATAFLOW.md` — named cross-package flows, traced end-to-end
Each named flow is a **function-level trace in the flow-trace grammar**, following the data from its
entry function across every package hop to its terminal output — branching where the system branches.
Name the actual functions and stores at each hop (`route → service::fn → repo::fn → table → queue →
(other package) worker::fn`). Put deciding `D-*` inline on the branch. End each flow with a `Detail:`
line linking the sub-package traces (`routes/PACKAGE.md § Data flows`, …) for the per-hop depth — link,
don't duplicate. The cross-package trace shows the SPINE; the sub-package trace shows the inside of a hop.

## `ARCHITECTURE.md` — shape + boundaries + module-level traces
- One small, stable system-shape block is fine (the only place ASCII boxes are allowed).
- **Boundaries & contracts** as text.
- **Module-level traces** in the flow-trace grammar: how a request descends the layers, e.g.
  `request → app.ts gate → route handler → service::fn → repository::fn → Postgres → response`,
  branching on the gate / public-vs-admin / live-vs-terminal splits. Function granularity, not prose.

## `DECISIONS.md` + distributed `D-*` entries (tiered, like PACKAGE.md)
A single growing log bloats. Decisions are tiered, routed by `Governs` span (longest-prefix, like
`resolveOwningDoc`): **cross-package / system-wide** → full body in root `DECISIONS.md`; **single-package**
→ full body in that package's `PACKAGE.md ## Decisions`, co-located with its code. Each body: **Why /
Tradeoff / Governs**. IDs are **global + stable** (`D-001`… repo-wide, never per-package; a decision that
changes scope keeps its id — move the body, keep the id).

Root `DECISIONS.md` = a `D-* → file` **index for ALL ids** (so any `(D-xx)` resolves to its home) + the
cross-package bodies:
```markdown
# Decisions index
| id | title | lives in |
|----|-------|----------|
| D-001 | Auth = session cookie + cipher KEK | DECISIONS.md (cross-package) |
| D-014 | Routes delegate to services | packages/api/PACKAGE.md |

# Cross-package decisions (full bodies)
## D-001 — Auth = session cookie + cipher KEK
**Why:** ...  **Tradeoff:** ...  **Governs:** packages/api/src/auth, packages/web/src/lib
```
SessionStart injects this root file; package-local bodies arrive with their `PACKAGE.md` at dispatch.

## `standards/<shard>.md` — `S-*` prescriptive, self-routing rules
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

## `INDEX.md`, `GLOSSARY.md`
Read-order + package map; domain vocab. See the tier table in SKILL.md.
