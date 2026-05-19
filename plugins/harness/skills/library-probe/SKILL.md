---
name: library-probe
description: >
  Pre-flight gate that validates every external library/API named in the design doc
  *before* spec generation and planning. Runs cheap health heuristics, then a use-case
  smoke test against the live service using credentials from project-root `.env.harness` (gitignored).
  Produces `docs/spec/<name>/library-probe.md` with a per-library verdict
  (VERIFIED / FAILED / UNTESTABLE). On FAILED, walks the design doc's declared
  fallback chain; after all alternatives are exhausted, escalates via AskUserQuestion.
  Use after brainstorm, before spec-generation. Also re-invoked by orchestrate when
  the coder stage emits a `LIB_SUSPECT` signal.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, AskUserQuestion
---

# Library Probe: The Trust Gate

A library is a *belief* until you've run it against the real service. This skill
turns belief into evidence before a single line of production code is written.

**Announce at start:** "Using library-probe to validate external dependencies before planning."

---

## When this skill runs

1. **Primary path** — between `brainstorm` and `spec-generation` in the orchestrate
   pipeline. Reads the design doc's `## External Dependencies & Fallback Chain`
   section.
2. **Loopback path** — when `tdd` emits `LIB_SUSPECT` during coding, orchestrate
   re-invokes this skill with `--lib <name>` to re-probe the suspect lib and walk
   the fallback chain.

---

## Inputs

- Design doc: `docs/spec/<SPEC_NAME>/design.md` (or path passed in)
- Spec dir: `docs/spec/<SPEC_NAME>/` (committed — `library-probe.md`, `verification/verification-stubs.md`)
- Harness dir: `.harness/<SPEC_NAME>/` (gitignored — `probes/<lib>/` scripts and logs)
- Optional flag: `--lib <name>` to probe a single library on loopback
- Optional flag: `--auto` to skip AskUserQuestion (CI mode)

---

## Outputs

- `docs/spec/<SPEC_NAME>/library-probe.md` — verdict file, committed (see template below)
- `docs/spec/<SPEC_NAME>/verification/verification-stubs.md` — committed; folded by spec-generation into VS-0 scenarios
- `.harness/<SPEC_NAME>/probes/<lib>/` — gitignored, per-library evidence:
  - `health.json` — health heuristic snapshot
  - `probe.<ext>` — the smoke script (kept for re-run)
  - `probe.log` — actual stdout/stderr
  - `payload.sample.json` — captured response sample (truncated)
- Promotes the verified probe scripts as **VS-0** scenarios in the spec, so
  `functional-verify` re-runs them at the end of the pipeline.

---

## Step 1 — Extract dependency list

Read the design doc's `## External Dependencies & Fallback Chain` section.
Format expected (added by the brainstorm skill — see brainstorm Phase 2.5):

```markdown
## External Dependencies & Fallback Chain

### Primary: <lib-name>
- **Purpose:** <what it does in this feature>
- **Use cases to probe:** <list of distinct flows; e.g. "single tweet, list, thread">
- **Auth:** <none | api-key | oauth | cookies>
- **Required env keys:** TWITTER_BEARER_TOKEN, ... (all loaded from project-root `.env.harness`)

### Fallbacks (in order)
1. <alt-lib-1> — <why this is a fallback>
2. <alt-lib-2> — <why>
3. build-custom — <approach, e.g. "Playwright scraper">
```

If the section is missing, **stop** with: `BLOCKED: design doc missing
'External Dependencies & Fallback Chain' section. Re-run brainstorm Phase 2.5.`

If no external deps are declared (pure-internal feature), write a short
`library-probe.md` with `verdict: NOT_APPLICABLE` and exit 0.

---

## Step 2 — Health heuristics (cheap, deterministic)

For each library, gather these signals. See `references/health-heuristics.md`
for the exact commands per registry (npm / PyPI / Go / Cargo / GitHub).

| Signal | Source | Threshold for `suspicious` |
|---|---|---|
| Last commit | GitHub API | > 12 months |
| Open issues / total | GitHub API | > 0.4 ratio with > 50 open |
| Weekly downloads | npm/PyPI | < 1000 |
| Is fork without parent activity | GitHub API | parent commit in last 3mo and ahead |
| Deprecated flag | registry metadata | any |

Score:
- `trusted` → 0 thresholds tripped → smoke test still runs (cheap), but on
  failure we trust the user's choice and don't auto-pivot until 2 strikes.
- `suspicious` → 1–2 thresholds tripped → smoke test must pass; one strike pivots.
- `dead` → 3+ thresholds tripped or `deprecated` flag → skip smoke, mark FAILED,
  pivot immediately.

Write `.harness/<SPEC_NAME>/probes/<lib>/health.json`.

---

## Step 3 — Credential loading

All credentials live in a single project-level dotenv file: `.env.harness` at
the project root. Each entry is service-prefixed to keep the namespace clean:

```bash
# <project-root>/.env.harness
TWITTER_BEARER_TOKEN=xxx
TWITTER_API_KEY=yyy
OPENAI_API_KEY=zzz
SENDGRID_API_KEY=...
```

**File discovery (worktree-safe):** orchestrate runs in a fresh worktree where
`.env.harness` won't exist. Resolve the main repo path with:

```bash
COMMON_DIR=$(git rev-parse --git-common-dir)
MAIN_REPO=$(dirname "$COMMON_DIR")
ENV_FILE="$MAIN_REPO/.env.harness"
```

The design doc declares **which keys** a probe needs, not a file path. Load via
`set -a; source "$ENV_FILE"; set +a` in the probe script, then verify the
declared keys are present and non-empty.

**File missing** → mark all libraries needing creds `UNTESTABLE` with reason
`.env.harness not found at <MAIN_REPO>`. Use AskUserQuestion (unless `--auto`)
asking the user to create it. In `--auto`, fail the gate.

**Required keys missing from file** → mark that specific library `UNTESTABLE`
with reason `missing keys: KEY1, KEY2`. Same escalation flow.

**One-time setup** the user does manually (surface this in the verdict file's
"Setup needed" section whenever any keys are missing):

```bash
# from project root
touch .env.harness && chmod 600 .env.harness
echo '.env.harness' >> .gitignore   # if not already there
# then add KEY=value lines to .env.harness
```

**Critical:** `.env.harness` MUST be in `.gitignore`. The skill verifies this
on first read — if `.env.harness` exists but is not gitignored, fail with
`BLOCKED:env-not-gitignored` and refuse to proceed. Committing creds is the
worst possible outcome and the harness must prevent it.

The skill **never** writes to `.env.harness`. It only reads.

---

## Step 4 — Use-case smoke test

For each `Use cases to probe` entry, generate a minimal throwaway script that
exercises *exactly* that flow. The script lives at
`.harness/<SPEC_NAME>/probes/<lib>/probe-<usecase>.<ext>`.

Generation rules:

- Smallest viable script: import lib, auth, hit the one endpoint, print one
  payload field, exit 0/1.
- No project deps. Run from a `/tmp/probe-<lib>-<rand>/` venv or `node --eval`-style
  isolation so it can't pollute the worktree.
- Hard timeout: 60s per probe (`timeout 60s ...`). If it hangs, that's a FAIL
  with reason `timeout`.
- Capture stdout+stderr to `probe.log`. Capture one payload sample (≤2KB,
  redact any token-shaped strings) to `payload.sample.json`.

Run each probe. Classify the result:

| Outcome | Verdict | Pivot? |
|---|---|---|
| Exit 0, payload matches expected shape | `VERIFIED` | No |
| 401/403 / auth error | `FAILED:auth` | No — ask user to fix creds |
| 429 / rate limit | `FAILED:rate-limit` | Record limits in verdict; mark `VERIFIED_WITH_RATE_LIMIT`, plan must respect |
| Timeout | `FAILED:timeout` | Yes |
| Schema mismatch (lib returns shape we didn't expect) | `FAILED:schema` | Yes |
| Module-not-found / import error | `FAILED:install` | Yes |
| Any other non-zero exit | `FAILED:other` | Yes |

---

## Step 5 — Walk the fallback chain on failure

If any required library lands in a `Pivot? Yes` state:

1. Pick the next entry from the design doc's fallback list.
2. Re-run Steps 2–4 for the new lib.
3. After each failed alternative, append to `library-probe.md` under `## Pivot Log`.
4. Cap at **3 pivots**. After exhaustion → escalate.

**Escalation** (non-`--auto`): use `AskUserQuestion` with structured options:

```
Question: All declared libraries failed for <use case>. How should I proceed?
Options:
  A) Use paid API: <name from design doc, if present>
  B) Build custom: <approach declared in design doc fallback>
  C) Drop this requirement from scope
  D) I'll add a new library to the design doc and retry
```

Record the user's choice in `library-probe.md` under `## Resolution`.

In `--auto` mode: pick option B (build custom) if declared in the design doc,
else fail the gate with verdict `BLOCKED:no-viable-library`.

---

## Step 6 — Promote probes to verification scenarios

For every library that landed `VERIFIED`, write a stub VS entry that
`spec-generation` will fold into `spec.md`:

```markdown
### VS-0-<lib>-<usecase>: Library probe — <lib> <usecase>
**Type:** api
**Run:** bash .harness/<SPEC_NAME>/probes/<lib>/probe-<usecase>.sh
**Expected:** exit 0, payload.sample.json non-empty
```

Save as `docs/spec/<SPEC_NAME>/verification/verification-stubs.md` (committed — reviewers see which probe scenarios will be re-run during verification). Spec-generation
appends these to the spec's `## Verification Scenarios` section.

This way `functional-verify` re-runs the same probes at the end of the
pipeline — if the lib died between probe and PR, we catch it.

---

## Step 7 — Write `library-probe.md`

```markdown
# Library Probe — <feature-name>

> **Run at:** YYYY-MM-DD HH:MM
> **Verdict:** PASS | BLOCKED | NOT_APPLICABLE

## Summary
| Library | Health | Smoke | Final |
|---|---|---|---|
| tweepy | trusted | FAILED:auth | NEEDS_CREDS |
| snscrape-v2 | suspicious | FAILED:schema | PIVOTED |
| twitterapi.io | trusted | VERIFIED | SELECTED |

## Selected
- **<lib>** for <use case>. Evidence: `.harness/<SPEC_NAME>/probes/<lib>/probe.log`

## Pivot Log
1. <lib-1> failed: <reason>. Tried next.
2. <lib-2> failed: <reason>. Tried next.

## Setup Needed (if any)
- Add keys to project-root `.env.harness` (gitignored): <list>

## Resolution (if escalated)
- User selected: <option>
- Followed up by: <action>

<!-- LP:VERDICT:PASS -->  <!-- or BLOCKED -->
```

---

## Loopback mode (`--lib <name>`)

When orchestrate re-invokes with `--lib <name>` (because tdd flagged a
`LIB_SUSPECT`):

1. Skip libraries already marked `VERIFIED` in the existing `library-probe.md`.
2. Re-probe only `<name>` and walk its fallback subtree.
3. If the resolution selects a different library, append a `## Re-plan Required`
   section listing which phase files reference the old lib. Orchestrate uses
   this to dispatch a planner update.

Cap loopbacks at 2. After that, escalate with the original `BLOCKED` verdict —
something is structurally wrong and humans need to look.

---

## Anti-patterns

- **Probing without creds because mocks "are easier"** — defeats the purpose.
  An `UNTESTABLE` mark is honest; a passing mock-probe is a lie.
- **Burying a `FAILED:rate-limit` as `VERIFIED`** — the rate limit must be
  declared in the verdict and the spec, so planning sizes batch sizes correctly.
- **Picking the next fallback silently** — every pivot must appear in
  `## Pivot Log` so humans can audit later.
- **Skipping the smoke test for `trusted` libs** — the registry says it's
  alive; the API says whether it works *for our use case*. Run the probe.
