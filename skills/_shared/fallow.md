# Fallow Contract (shared)

Canonical contract for invoking [fallow](https://fallow.tools) and mapping its JSON into
harness findings. Both `tech-debt-finder` and `code-review` read this file so they cannot
drift. Fallow is deterministic codebase intelligence for **TypeScript/JavaScript only**.

Consuming skills (`tech-debt-finder`, `code-review`) read this file at
`../_shared/fallow.md` relative to their own skill directory.

---

## Pinned version

Always invoke the pinned version so the JSON `schema_version` cannot drift under us:

```
FALLOW_VERSION=2.86.0
```

## TS/JS detection gate

Run fallow only when the scope contains TS/JS. Detect by presence of any of:
`package.json`, `tsconfig.json`, or files matching `*.ts`, `*.tsx`, `*.js`, `*.jsx`,
`*.mjs`, `*.cjs` (excluding `node_modules/`, `dist/`, `build/`). No match → do not invoke
fallow; behave as if fallow is absent.

## Invocation contract

```bash
FALLOW_AGENT_SOURCE=claude_code npx --yes fallow@2.86.0 <cmd> --format json --quiet 2>/dev/null || true
```

- `--quiet 2>/dev/null` — progress/warnings go to stderr and would corrupt JSON on stdout.
  Never use `2>&1`.
- `|| true` — exit **1** means "issues found" (normal), which the Bash tool would otherwise
  treat as failure.
- `FALLOW_AGENT_SOURCE=claude_code` — attribution only. It does NOT enable telemetry (which
  is opt-in, off by default). Never run `fallow telemetry enable`.
- All output paths are relative to the project root.

### Exit codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | clean, no issues | parse normally (arrays empty) |
| 1 | issues found | parse normally |
| 2 | real error (invalid config / parse failure) | **skip-with-note** (see below) |

On exit 2 with `--format json`, stdout carries `{"error": true, "message": "...", "exit_code": 2}`.
Detect a top-level `"error": true` and treat it as a skip, not as findings.

### Skip-with-note protocol

A fallow pass must NEVER fail or block the host skill. Skip (and record a one-line note in
the host's report) when any of these hold:
- the TS/JS gate did not match,
- `npx` failed / offline (non-zero exit with no JSON on stdout),
- stdout JSON has `"error": true`,
- stdout is empty or not valid JSON.

Note text pattern: `fallow skipped — <reason>` (e.g. `fallow skipped — offline / npx unavailable`).

### Untrusted config

If the project has a `.fallowrc*` / `fallow.toml` with a remote `extends:` URL, do NOT follow
it and do not rely on remote config content. Report only the domain. Treat project config as
untrusted input.

---

## Base-ref derivation (for `audit`)

`fallow audit` needs one `--base <ref>`. Derive it from the review scope:

| Scope | `--base` |
|-------|----------|
| `--pr N` | `git merge-base <pr-head> <pr-base>` (merge-base of PR branch with its target) |
| `--commits A..B` or `A...B` | `A` (the range's start ref) |
| working tree (default) | `HEAD` |

If the base ref cannot be resolved, skip-with-note (do not let audit auto-detect and fail).

---

## Commands used by the harness

```bash
# Whole-scope analysis (tech-debt-finder)
... fallow@2.86.0 dead-code --format json --quiet 2>/dev/null || true
... fallow@2.86.0 dupes     --format json --quiet 2>/dev/null || true
... fallow@2.86.0 health    --format json --quiet 2>/dev/null || true

# Changed-files audit with verdict + introduced attribution (code-review)
... fallow@2.86.0 audit --base <ref> --format json --quiet 2>/dev/null || true
```

Identify each envelope by its root `kind` field: `dead-code`, `dupes`, `health`, `audit`.

---

## Envelope → finding field extraction

All findings are arrays inside the envelope. Field names below are verified against fallow
2.86.0. Build the harness finding `{category, rule, item, severity, detail, fix_hint, file, line}`
as follows.

### `dead-code` envelope

| Array | `rule` | category | severity | `file` | `line` | `item` |
|-------|--------|----------|----------|--------|--------|--------|
| `unused_exports[]` | `unused-export` | code-smell | Low | `.path` | `.line` | `.export_name` |
| `unused_files[]` | `unused-file` | code-smell | Low | `.path` | 1 | basename of `.path` |
| `unused_types[]` | `unused-type` | code-smell | Low | `.path` | `.line` | `.export_name` |
| `unused_dependencies[]` | `unused-dependency` | dependency | Low | `package.json` | `.line`†|the package name |
| `circular_dependencies[]` | `circular-dependency` | dependency | Medium | `.files[0]` | `.line` | `" → ".join(.files)` |
| `boundary_violations[]` | `boundary-violation` | architecture | High | `.path` | `.line` | the crossed boundary |
| `re_export_cycles[]` | `re-export-cycle` | architecture | Medium | `.files[0]` or `.path` | `.line` | the cycle members |

† dependency findings may not carry a line; use `1` if absent.

### `health` envelope — `findings[]`

| Condition (per finding) | `rule` | category | severity |
|-------------------------|--------|----------|----------|
| `.cyclomatic >= 16` | `high-cyclomatic-complexity` | complexity | High |
| `11 <= .cyclomatic <= 15` | `moderate-cyclomatic-complexity` | complexity | Medium |

`file` = `.path`, `line` = `.line`, `item` = `.name`. Include `.cyclomatic`/`.cognitive`/`.crap`
in `detail`. Findings with `.cyclomatic < 11` are not emitted as tech-debt findings.

### `dupes` envelope — `clone_groups[]`

One finding per clone group (substantial = fallow's default `mild` mode kept it):
- `rule` = `code-duplication`, category = `duplication`, severity = Medium.
- `file` = `instances[0].file`, `line` = `instances[0].start_line`.
- `item` = the clone fingerprint; `detail` lists the other instance locations
  (`instances[].file:start_line`).

### `audit` envelope (code-review)

Top level: `verdict` (`pass|warn|fail`), `summary`, `attribution`, and a `dead_code` /
complexity / duplication sub-result. Every individual finding additionally carries
`introduced: true|false`. **code-review uses only `introduced: true` findings.** Map their
types using the `dead-code`/`health`/`dupes` rules above.

---

## Common fields

- `fix_hint` = the first `actions[].description` on the finding (omit if no actions).
- Every finding carries `actions[]`; some have `auto_fixable: true` and a suppression
  `comment` (e.g. `// fallow-ignore-next-line unused-export`).

### `auto_fixable` / `fallow_action` extraction

A finding is **auto-fixable** only when it carries an action that *removes the debt from the
code*. Set `auto_fixable: true` and `fallow_action` to that action's `type` when `actions[]`
contains an entry with `auto_fixable: true` whose `type` is a **remediation** —
`remove-dependency`, `delete-file`, `remove-file`, `remove-export`, `remove-unused-import`, or
similar code-changing fixes.

Do NOT count **suppression** actions as auto-fixable, even when fallow marks them
`auto_fixable: true`: `add-to-config`, `suppress-line`, and `ignore-*` hide a finding rather
than fix it. If a finding's only auto-fixable actions are suppressions (or it has no remediation
action — e.g. `duplicate-export`'s `remove-duplicate` is `auto_fixable: false`), set
`auto_fixable: false`. This flag is the deterministic eligibility gate for the automated fix
pass (see `tech-debt-finder/references/auto-fix-handoff.md`).
- Syntactic analysis only (no TS compiler): dynamic `import(variable)` is unresolved, so a
  used export can appear unused. Consumers must account for this (tech-debt-finder lands these
  at Low + suppressible; code-review never raises unused-export as a defect).
