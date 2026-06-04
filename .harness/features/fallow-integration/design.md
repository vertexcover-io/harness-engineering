# Fallow Integration (tech-debt-finder + code-review) — Design

## Problem Statement

The harness has two analysis skills that lean on LLM judgment or Python-only tooling
for structural code facts:

- **`tech-debt-finder`** is effectively **Python-only**. It uses `radon` (Python),
  `pip-audit` (Python), reads `pyproject.toml`, applies Python rules (bare except,
  mutable defaults, async blocking), and **stops outright if the scope has no Python
  files**. TS/JS repos get nothing.
- **`code-review`** is LLM-only. It reasons about correctness from the diff but has no
  deterministic ground truth for structural facts (unused exports introduced by the
  change, new circular dependencies, architecture-boundary violations, substantial new
  duplication), so it can both miss them and hallucinate them.

We want to add **fallow** — a fast, deterministic Rust CLI for TS/JS codebase
intelligence — as a backend that grounds both skills for TS/JS code, without disturbing
their current behavior on other languages.

## Context

`fallow` (npm `fallow`, v2.86.0, MIT static layer) analyzes the TS/JS module graph in a
single sub-second pass and emits machine-readable JSON/SARIF. Relevant surface:

- `fallow dead-code` — unused files/exports/types/deps, circular deps, re-export cycles,
  **boundary violations**
- `fallow dupes` — copy-paste + structural duplication
- `fallow health` — cyclomatic/cognitive complexity, CRAP, hotspots
- `fallow audit --base <ref>` — **purpose-built for reviewing AI-generated diffs**:
  scopes dead-code + complexity + duplication to changed files, returns a
  `pass | warn | fail` verdict, and attributes each finding `introduced: true|false`
  (new vs. inherited).

Agent contract (from the official `fallow-rs/fallow-skills` plugin):
`fallow <cmd> --format json --quiet 2>/dev/null || true`. Exit **0** = clean,
**1** = issues found (normal), **2** = real error (invalid config / parse failure, which
in JSON mode is emitted as `{"error": true, ...}` on stdout). Output is keyed by a root
`kind` field; every finding carries an `actions[]` array (some `auto_fixable`).

There is also an official Claude Code plugin, an MCP server (`fallow-mcp`), and NAPI
bindings (`@fallow-cli/fallow-node` + `fallow/types`). MCP/NAPI are **deferred to phase
2** — this design uses the CLI only.

This brainstorm was triggered by a request to integrate fallow into the harness; the
chosen scope is **A + B**: (B) vendor fallow's CLI/JSON knowledge into the two skills,
and (A) document the standalone plugin install for ad-hoc use.

## Requirements

### Functional Requirements

- **F1** — `tech-debt-finder` SHALL detect TS/JS dead code, duplication, and complexity
  via fallow, merging those findings into its existing report alongside the Python
  scanners (polyglot merge).
- **F2** — `tech-debt-finder` SHALL map each fallow finding into its existing finding
  shape `{category, rule, item, severity, detail, fix_hint, file, line}`, where `rule` is a
  registered hyphenated name from `references/suppression-rules.md` (reusing existing names
  where semantics match; new fallow-only names — `unused-export`, `unused-file`,
  `unused-type`, `boundary-violation`, `re-export-cycle` — SHALL be added to that file so
  the `tech-debt-ignore.md` suppression flow matches them), using fallow's `actions[]`
  description for `fix_hint`. Every fallow finding used by tech-debt-finder MUST carry a
  `file` and `line` so the Step-5a code-snippet extraction does not degrade.
- **F3** — `code-review` SHALL, for TS/JS diffs, run `fallow audit --base <ref>` and use
  the JSON as **grounding context** to reduce hallucination of structural claims.
- **F4** — `code-review` SHALL raise as defects ONLY high-signal **introduced** (`introduced: true`)
  structural findings — new circular dependencies, new boundary violations, and
  substantial new duplication — and SHALL NOT raise unused-export/unused-file/lint-tier
  nits as defects (respecting "not a linter"). Promoted structural defects SHALL be raised
  at **`Important`** (→ `APPROVE WITH SUGGESTIONS`), never `Critical`, so they never
  hard-block the orchestrate two-pass loop on their own; they carry no `S-VIOLATION` token.
  The fallow `verdict` is surfaced as a one-line context note, not as an automatic verdict
  override.
- **F5** — Both skills SHALL acquire fallow via `npx fallow@<PINNED>` and, when fallow is
  unavailable (offline, npx failure, exit 2), SHALL skip the fallow pass and note the skip
  in their output — never failing the run.
- **F6** — Both skills SHALL run the fallow pass only when the relevant scope contains
  TS/JS (`package.json` / `tsconfig.json` / `*.ts|*.tsx|*.js|*.jsx` present); otherwise
  behave exactly as today.
- **F7** — A single shared reference SHALL hold the canonical invocation contract,
  JSON-envelope→finding field mapping, base-ref derivation, severity table, and rule-name
  mapping, so the two skills cannot drift apart. (Implementation detail for planning: one
  file referenced by both skills, e.g. `skills/_shared/fallow.md`, or a copy kept identical
  in each skill's `references/` — planning picks the mechanism the plugin loader supports.)
- **F8** — The repo SHALL document the recommended standalone install of
  `fallow-rs/fallow-skills` (`/install fallow-rs/fallow-skills`) for ad-hoc use, without
  vendoring the third-party source into our `marketplace.json`.
- **F9 (Graceful degradation for other languages)** — `tech-debt-finder` SHALL NOT hard-stop
  when the scope contains no Python and no TS/JS. Deterministic backends remain Python
  (radon/pip-audit) and TS/JS (fallow); for any other language (Go, Rust, Java, Ruby, C#, …)
  the skill SHALL still run the language-agnostic LLM pattern scanner as best-effort and
  SHALL label, in the report, what was **deterministically scanned** vs. **pattern-only**
  vs. **skipped (empty scope)**. Only a genuinely empty/non-existent scope stops the run.

### Non-Functional Requirements

- **NF1 (Pure mapping)** — the skill's emitted findings list SHALL be a pure function of
  the fallow JSON envelope (same envelope → same findings), so the deterministic backend is
  not re-randomized by our parsing layer.
- **NF2 (Latency)** — fallow analysis is sub-second; the only added cost is a possible
  one-time `npx` cold download. Acceptable for both an on-demand audit and a review stage.
- **NF3 (Context economy)** — skills MUST parse fallow JSON into counts + scoped findings;
  they MUST NOT dump raw JSON into the agent transcript (large monorepos produce large
  envelopes).
- **NF4 (Non-regression)** — on non-TS/JS repos and when fallow is absent, both skills
  produce the same output they do today.
- **NF5 (Supply-chain safety)** — pin the fallow version (guards JSON `schema_version`
  drift and pins the executed binary); treat any project `.fallowrc` `extends:` remote
  URL as untrusted and never follow it.
- **NF6 (Attribution)** — set `FALLOW_AGENT_SOURCE=claude_code` on invocations (does not
  enable telemetry; only attributes if the user already opted in).

### Edge Cases and Boundary Conditions

- **Mixed repo (Python + TS/JS)** — run both backends, merge; dedup by `file:line` keeping
  highest severity (existing tech-debt-finder rule extends to fallow findings).
- **Unsupported-language repo (Go/Rust/Java/…)** — no deterministic backend engages;
  tech-debt-finder still runs the language-agnostic LLM pattern scanner and reports the
  coverage label (F9) instead of hard-stopping. code-review is unaffected — it reviews these
  languages via its generic LLM patterns exactly as today.
- **Mixed repo incl. an unsupported language** — Python/TS-JS parts scanned deterministically,
  the unsupported parts pattern-only; one merged report, coverage label notes the split.
- **No git base for `audit`** — fallow exits 2 with "could not detect base branch". The
  base-ref derivation (below) always supplies `--base`, so this is avoided; if it still
  occurs, skip-with-note.
- **Syntactic false positives** — fallow has no TS compiler, so `import(variable)` dynamic
  imports may mark a used export as unused. Mitigated for code-review by F4 (unused-export
  never raised as a defect); for tech-debt-finder these land at Low severity and are
  suppressible via `tech-debt-ignore.md`.
- **Empty diff / no changed TS/JS in code-review** — no audit run; proceed as today.
- **fallow exit 2 with JSON error envelope** — detect `{"error": true}` on stdout, skip
  the pass, note the message.
- **Huge JSON envelope** — use filter flags / summary fields; cap the number of findings
  surfaced (parse counts always; list top findings per category).

## Key Insights

- **`tech-debt-finder` is not "Python-biased", it is Python-gated** — it halts with "no
  files to scan" on a pure TS/JS repo. Fallow is therefore *additive capability*, not a
  swap, which raises the value of this integration above a simple tooling upgrade.
- **`code-review`'s "not a linter" stance is a hard constraint, not a preference** — the
  right integration uses fallow mostly to *ground* the LLM (stop it inventing/ missing
  structural facts) and only promotes a narrow, high-signal subset to defects. Dumping
  fallow's full finding set would convert a bug-hunting reviewer into a linter and erode
  its signal.
- **`audit`'s `introduced` flag is the linchpin** — it lets the reviewer ignore inherited
  debt and speak only to what *this change* added, which is exactly the noise filter
  reviewers usually lack.

## Architectural Challenges

**Boundaries & ownership.** The two skills stay the orchestration owners; fallow is a
stateless backend invoked per-run. The invocation+parse contract is the only shared
surface and lives in one reference (F7) to prevent divergence.

**Base-ref derivation (code-review).** code-review has three scope modes; fallow `audit`
needs one `--base`:

| code-review scope | `--base` for fallow audit |
|---|---|
| `--pr N` | merge-base of the PR branch with its target (`git merge-base`) |
| `--commits A..B` (or `A...B`) | `A` (the range's start ref) |
| working tree (default) | `HEAD` |

**Severity mapping (tech-debt-finder).** fallow envelopes → existing finding shape. This
**reuses tech-debt-finder's existing categories and severity tiers verbatim** so the merged
report's Summary table stays coherent; only the starred `rule` names are new and must be
registered in `references/suppression-rules.md`.

| fallow source | `rule` | category | severity |
|---|---|---|---|
| `dead-code` boundary violation | `boundary-violation` * | architecture | High |
| `dead-code` circular dependency | `circular-dependency` | dependency | Medium |
| `dead-code` re-export cycle | `re-export-cycle` * | architecture | Medium |
| `health` cyclomatic ≥ 16 | `high-cyclomatic-complexity` | complexity | High |
| `health` cyclomatic 11–15 | `moderate-cyclomatic-complexity` | complexity | Medium |
| `dupes` clone group (substantial) | `code-duplication` | duplication | Medium |
| `dead-code` unused export | `unused-export` * | code-smell | Low |
| `dead-code` unused file | `unused-file` * | code-smell | Low |
| `dead-code` unused type | `unused-type` * | code-smell | Low |
| `dead-code` unused dependency | `unused-dependency` | dependency | Low |

**Envelope → field extraction.** From each fallow finding object: `path` → `file`,
`line` → `line`, the symbol/identifier (e.g. `export_name`, file basename) → `item`, a
human sentence built from the issue type → `detail`, `actions[].description` → `fix_hint`.
The exact JSON key per envelope `kind` is verified by the `library-probe` smoke test before
coding (it captures real `dead-code`/`dupes`/`health`/`audit` envelopes); planning pins the
final key paths from that output.

**Failure isolation.** Every fallow call is best-effort (`|| true`, exit-2 detection,
TS/JS gate, npx fallback). No fallow failure path can fail or block the host skill.

## High-Level Design

```mermaid
graph TB
  subgraph shared[references/fallow.md - shared contract]
    C1[invocation: npx fallow@PINNED --format json --quiet 2>/dev/null || true]
    C2[TS/JS detection gate]
    C3[envelope -> finding mapping + severity table]
    C4[base-ref derivation]
  end

  subgraph TDF[tech-debt-finder]
    T1[Step1 resolve scope] --> T2{TS/JS present?}
    T2 -- yes --> T3[fallow dead-code + dupes + health]
    T2 -- no/absent --> T4[skip fallow, note]
    T3 --> T5[map -> findings]
    PY[Python scanners: radon/pip-audit/patterns] --> T6
    T5 --> T6[merge + dedup + suppress + report]
  end

  subgraph CR[code-review]
    R1[gather diff] --> R2{TS/JS in diff?}
    R2 -- yes --> R3[fallow audit --base ref]
    R2 -- no/absent --> R4[skip, review as today]
    R3 --> R5[grounding context + introduced:true filter]
    R5 --> R6[LLM defect analysis: raise only high-signal structural]
    R6 --> R7[REVIEW.md]
  end

  C1 -.-> T3
  C1 -.-> R3
  C3 -.-> T5
  C4 -.-> R3
```

```mermaid
sequenceDiagram
  participant Orc as orchestrate (2-pass)
  participant CR as code-review
  participant FB as fallow CLI
  participant LLM as reviewer reasoning
  Orc->>CR: --commits A..B --output pass-1.md
  CR->>CR: collect diff, detect TS/JS, derive base=A
  alt TS/JS changed files present
    CR->>FB: fallow audit --base A --format json --quiet 2>/dev/null || true
    FB-->>CR: {verdict, attribution, findings[introduced]}
    CR->>CR: keep introduced:true; classify high-signal vs nit
  else none / fallow absent
    CR->>CR: skip-with-note
  end
  CR->>LLM: diff + fallow grounding
  LLM-->>CR: defects (incl. high-signal structural)
  CR->>Orc: REVIEW.md (verdict, defects, fallow note)
```

**Language support matrix** (after this change)

| Language | tech-debt-finder | code-review |
|---|---|---|
| Python | radon + pip-audit + LLM patterns (deterministic) | full LLM + Python checklist |
| TS/JS | **fallow** + LLM patterns (deterministic) | full LLM + **fallow grounding** |
| Go / Rust / Java / Ruby / … | LLM pattern scanner only (best-effort, labeled — F9) | full LLM, generic patterns (unchanged) |

**Component summary**
- **Shared contract** (`references/fallow.md`): one source of truth for invocation, the
  TS/JS gate, the envelope→finding mapping + severity table, base-ref derivation, and the
  skip-with-note protocol.
- **tech-debt-finder**: adds a fallow pass parallel to the Python scanners; merges into the
  existing collect→dedup→suppress→report pipeline; GitHub-issue creation unchanged.
- **code-review**: adds an `audit` grounding step before LLM analysis; existing REVIEW.md
  format unchanged except an optional one-line "Structural grounding: fallow verdict=…"
  note and any promoted high-signal defects flowing through the normal Defects table.
- **Plugin (A)**: a short README/docs note recommending `/install fallow-rs/fallow-skills`.

## External Dependencies & Fallback Chain

### Primary: fallow (npm `fallow`)
- **Purpose:** deterministic TS/JS dead-code, duplication, complexity, and changed-file
  audit backing both skills.
- **Use cases to probe:** (1) `dead-code --format json` on a TS project; (2) `dupes
  --format json`; (3) `health --format json`; (4) `audit --base <ref> --format json` on a
  dirty branch (verdict + `introduced` attribution); (5) exit-2 / error-envelope behavior;
  (6) offline / npx-unavailable skip path.
- **Maturity:** v2.86.0 published 2026-06-02 (actively released via GitHub Actions); MIT
  static layer; official Claude Code plugin + MCP + NAPI bindings. No bad signals.
- **Auth:** none (static layer). Runtime/cloud layer is paid and out of scope.
- **Required env keys:** none. (`FALLOW_AGENT_SOURCE=claude_code` set for attribution only.)

### Fallbacks (in order)
1. **Skip fallow, keep existing behavior** — tech-debt-finder falls back to radon/Python
   scanners; code-review falls back to pure-LLM review. Output notes the skip. (This is the
   designed degradation path, not a hard failure.)
2. **`knip` + `jscpd`** — if a deterministic TS/JS backend is later required and fallow is
   unviable, these are the closest OSS equivalents (fallow even ships a `migrate` from
   them). Not adopted now; recorded as the build-out alternative.

## Open Questions

- Exact "substantial duplication" threshold for promoting a `dupes` clone group to a
  code-review defect — start with fallow's default `mild` mode and only promote clone
  groups spanning the changed files; tune empirically.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| JSON `schema_version` bump breaks parsing | Pin `fallow@<PINNED>` (NF5); parsing keys off documented top-level fields; skip-with-note on shape mismatch. |
| `npx` cold-download latency / offline CI | Detect-or-skip (F5); note the skip; phase-2 NAPI/global-install removes npx cost. |
| Syntactic false positives (dynamic imports) | code-review never raises unused-export defects (F4); tech-debt-finder lands them Low + suppressible. |
| Reviewer turns into a linter | F4 hard-limits promoted findings to high-signal structural; verdict is context only. |
| Large-repo JSON floods context | Parse to counts + capped top findings; use filter/summary flags (NF3). |
| Untrusted project `.fallowrc extends:` URL | Never follow remote config; report domain only (NF5). |
| Two skills drift in how they call/parse fallow | Single shared `references/fallow.md` contract (F7). |

## Assumptions

- We assume target JS/TS repos have an entry graph fallow can discover without a custom
  `.fallowrc`. Invalidated if common targets need hand-written config to produce non-empty
  results — then config bootstrapping comes back into scope.
- `npx` (Node) is available in environments where TS/JS analysis is wanted — a safe
  assumption for JS/TS repos.

## What This Does NOT Do

- No MCP server (`fallow-mcp`) or NAPI bindings (`@fallow-cli/fallow-node`) wiring —
  explicitly phase 2.
- No `fallow fix` / auto-remediation from either skill (tech-debt-finder stays
  report-only; remediation remains `/refactor` and `/orchestrate`).
- No SARIF/PR-comment posting pipeline or GitHub Action adoption.
- No changes to `quality-gate`, the coder e2e-gate, or other skills (separate future
  integration points identified during research).
- **No deterministic backends for Go/Rust/Java/Ruby/etc.** — these get best-effort LLM
  pattern scanning only (F9), not tool-backed dead-code/complexity/duplication. Adding such
  backends (e.g. `gocyclo`, `clippy`) is future work; this design does not build a
  per-language backend registry for them now (YAGNI).
- No vendoring of the third-party `fallow-rs/fallow-skills` source into our
  `marketplace.json` — install is documented, not bundled.
```
