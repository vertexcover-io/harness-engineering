# Knowledge Contract (shared)

Canonical contract for invoking `knowledge.mjs` — the deterministic mechanics of the
unified `.harness/` store. Consuming skills read this file at `../_shared/knowledge.md`
relative to their own skill directory and MUST NOT restate its rules.

## Zones

| Zone | Git | Lifetime |
|---|---|---|
| `.harness/knowledge/` | committed | forever — lessons + INDEX.md |
| `.harness/features/<spec>/` | committed | frozen once the PR merges |
| `.harness/runtime/<spec>/` | gitignored | scratch; dies with the worktree |

`.gitignore` carries exactly `.harness/runtime/` — never the broad `.harness/`.

## Invocation

```bash
node "<plugin-root>/skills/_shared/knowledge.mjs" <cmd> [flags]
```

JSON envelope on stdout. Exit codes: `0` clean · `1` actions/findings taken · `2` real
error. Host skills treat exit 2 (or non-JSON stdout) as **skip-with-note** —
`knowledge skipped — <reason>` — and continue; the ONE exception is `verify`'s
gitignore error, which must halt the pipeline (committed zones silently ignored =
data loss).

## Commands

### `verify`

```json
{ "ok": true, "created": [".harness/features", "..."], "errors": [] }
```

Bootstraps missing zones, empty `INDEX.md`, and `.harness/README.md` (`created`
lists them, exit 1; nothing missing → exit 0). If `.harness/knowledge` is gitignored:
exit 2, `errors` names the fix.

### `migrate [--dry-run]`

```json
{ "migrated": [{ "from": "docs/context", "to": ".harness/knowledge/context" }],
  "deferred": [{ "path": "docs/spec/foo", "reason": "uncommitted changes:\n M ..." }],
  "gitignore_changed": true }
```

Old-root mapping: `docs/context` → `knowledge/context` · `docs/solutions` →
`knowledge/lessons` · `docs/spec`, `docs/specs`, `docs/superpowers/specs` → `features`
· legacy `.harness/<spec>/` → `runtime/<spec>`. Tracked content moves via `git mv`
(history preserved); ignored content via fs rename. Dirty paths defer (per child).
Commits standalone with explicit pathspecs — never sweeps unrelated changes.
Idempotent; `--dry-run` prints the same envelope, touches nothing.

### `reindex`

```json
{ "entries": 100, "evicted": ["lessons/gotchas/weakest.md"], "stale": ["lessons/..."] }
```

Regenerates `knowledge/INDEX.md` from lesson + standard frontmatter — INDEX is a
derived cache; never hand-edit or hand-merge (conflict resolution: delete both sides,
rerun). Sort: `evidence_count` desc, `last_validated` desc, path asc. Hard cap 100;
eviction = lowest evidence_count, oldest last_validated, lexicographic path (evicted
files stay on disk, grep-able). `stale` = lessons whose `related:` paths no longer
exist. Legacy frontmatter defaults: `evidence_count` 1, missing `applies_to` → tag-only.

## Lesson frontmatter (routing fields)

```yaml
applies_to: ["src/api/**"]   # inline-list syntax REQUIRED (multi-line lists parse as absent)
tags: [auth, retry]
evidence_count: 1
last_validated: 2026-06-04
related: ["src/api/handler.js"]   # staleness probes
source: review-fix@my-spec        # provenance (curator-written lessons)
```
