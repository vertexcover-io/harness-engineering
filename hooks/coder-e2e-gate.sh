#!/usr/bin/env bash
# ── coder-e2e-gate.sh ──
# SubagentStop hook. Verifies that the coder phase that just finished:
#   1. Wrote .harness/<SPEC>/phase-<N>-claims.json
#   2. Declared an e2e_run with a real runner-output report_path
#   3. Actually executed (executed > 0) with no failures (failed = 0)
#   4. Self-reported counts match the re-parsed runner output
#   5. Every touched *code* file is covered by at least one `proven_by` test
#
# Activation: no-ops unless .harness/current-phase exists (orchestrate writes
# this breadcrumb before dispatching a coder subagent and clears it after).
#
# Exit codes:
#   0  → all checks pass (or no active phase → not our concern)
#   2  → block: blocking message printed to stdout, prefixed with a token the
#        orchestrate skill greps for.
#
# All blocking output is prefixed with `CODER_E2E_GATE:` so orchestrate (and
# humans reading the transcript) can locate the verdict deterministically.

set -uo pipefail

BREADCRUMB_DEFAULT=".harness/current-phase"
BREADCRUMB="${HARNESS_CURRENT_PHASE_FILE:-$BREADCRUMB_DEFAULT}"

emit_block() {
  echo "CODER_E2E_GATE:BLOCK $*"
}

emit_info() {
  echo "CODER_E2E_GATE:INFO $*"
}

# ── 0. Active phase breadcrumb ─────────────────────────────────────────────
if [ ! -f "$BREADCRUMB" ]; then
  # No active coder phase → not our concern.
  exit 0
fi

# Breadcrumb format: shell-sourceable KEY=VALUE lines.
#   SPEC_NAME=<name>
#   PHASE_N=<int>
#   START_SHA=<git sha>
# shellcheck disable=SC1090
. "$BREADCRUMB"

: "${SPEC_NAME:?CODER_E2E_GATE:BLOCK breadcrumb missing SPEC_NAME}"
: "${PHASE_N:?CODER_E2E_GATE:BLOCK breadcrumb missing PHASE_N}"
: "${START_SHA:?CODER_E2E_GATE:BLOCK breadcrumb missing START_SHA}"

HARNESS_DIR=".harness/$SPEC_NAME"
CLAIMS_FILE="$HARNESS_DIR/phase-$PHASE_N-claims.json"

# ── 1. jq must be available ────────────────────────────────────────────────
if ! command -v jq >/dev/null 2>&1; then
  emit_block "jq is required but not installed"
  exit 2
fi

# ── 2. Phase claims file must exist ────────────────────────────────────────
if [ ! -f "$CLAIMS_FILE" ]; then
  emit_block "MISSING_PHASE_CLAIMS expected $CLAIMS_FILE"
  exit 2
fi

# Escape hatch: explicit not_applicable flag (narrow — same as today's contract).
not_applicable="$(jq -r '.not_applicable // false' "$CLAIMS_FILE" 2>/dev/null || echo "parse_error")"
if [ "$not_applicable" = "parse_error" ]; then
  emit_block "PHASE_CLAIMS_UNPARSEABLE $CLAIMS_FILE is not valid JSON"
  exit 2
fi
if [ "$not_applicable" = "true" ]; then
  emit_info "phase $PHASE_N flagged not_applicable — skipping e2e gate"
  exit 0
fi

# ── 3. e2e_run block must declare a real report_path ───────────────────────
report_path="$(jq -r '.e2e_run.report_path // empty' "$CLAIMS_FILE")"
if [ -z "$report_path" ]; then
  emit_block "MISSING_E2E_REPORT_PATH .e2e_run.report_path missing in $CLAIMS_FILE"
  exit 2
fi
if [ ! -f "$report_path" ]; then
  emit_block "MISSING_E2E_REPORT file $report_path does not exist on disk"
  exit 2
fi

runner="$(jq -r '.e2e_run.runner // empty' "$CLAIMS_FILE")"
if [ -z "$runner" ]; then
  emit_block "MISSING_E2E_RUNNER .e2e_run.runner missing in $CLAIMS_FILE"
  exit 2
fi

# ── 4. Re-derive executed/passed/failed from the raw runner JSON ───────────
# Supported runner shapes (best-effort):
#   playwright JSON reporter → .stats.expected / .stats.unexpected / .stats.skipped
#                           and recursive .suites[].specs[].tests[].results[].status
#   vitest JSON reporter    → .numTotalTests / .numPassedTests / .numFailedTests
#   generic                  → top-level executed/passed/failed numeric fields
case "$runner" in
  playwright)
    re_executed="$(jq '
      [ ..|.tests? // empty | .[]? | .results[]? | select(.status != "skipped") ] | length
    ' "$report_path" 2>/dev/null || echo 0)"
    re_failed="$(jq '
      [ ..|.tests? // empty | .[]? | .results[]? | select(.status == "failed" or .status == "timedOut" or .status == "interrupted") ] | length
    ' "$report_path" 2>/dev/null || echo 0)"
    re_passed=$(( re_executed - re_failed ))
    ;;
  vitest|jest)
    re_executed="$(jq '.numTotalTests // 0' "$report_path" 2>/dev/null || echo 0)"
    re_passed="$(jq '.numPassedTests // 0' "$report_path" 2>/dev/null || echo 0)"
    re_failed="$(jq '.numFailedTests // 0' "$report_path" 2>/dev/null || echo 0)"
    ;;
  *)
    re_executed="$(jq '.executed // 0' "$report_path" 2>/dev/null || echo 0)"
    re_passed="$(jq '.passed // 0' "$report_path" 2>/dev/null || echo 0)"
    re_failed="$(jq '.failed // 0' "$report_path" 2>/dev/null || echo 0)"
    ;;
esac

if ! [[ "$re_executed" =~ ^[0-9]+$ ]]; then re_executed=0; fi
if ! [[ "$re_failed"   =~ ^[0-9]+$ ]]; then re_failed=0; fi
if ! [[ "$re_passed"   =~ ^[0-9]+$ ]]; then re_passed=0; fi

if [ "$re_executed" -eq 0 ]; then
  emit_block "E2E_NOT_EXECUTED report $report_path shows 0 executed tests"
  exit 2
fi
if [ "$re_failed" -gt 0 ]; then
  emit_block "E2E_FAILED report $report_path shows $re_failed failed test(s)"
  exit 2
fi

# Cross-check self-reported counts against the re-parsed runner truth.
claimed_executed="$(jq -r '.executed // 0' "$CLAIMS_FILE")"
claimed_failed="$(jq -r '.failed // 0' "$CLAIMS_FILE")"
if [ "$claimed_executed" != "$re_executed" ] || [ "$claimed_failed" != "$re_failed" ]; then
  emit_block "E2E_COUNTS_TAMPERED claims.json says executed=$claimed_executed failed=$claimed_failed but $report_path says executed=$re_executed failed=$re_failed"
  exit 2
fi

# ── 5. Every touched code file must appear in some `proven_by` reference ──
# Touched = changed since START_SHA in the current worktree.
if ! command -v git >/dev/null 2>&1; then
  emit_block "git not available — cannot determine touched files"
  exit 2
fi

touched_raw="$(git diff --name-only "$START_SHA"..HEAD 2>/dev/null; git diff --name-only "$START_SHA" 2>/dev/null)"
# de-dup
touched="$(printf '%s\n' "$touched_raw" | awk 'NF && !seen[$0]++')"

# Code-file extensions. Configs / docs / locks / env files are excluded.
is_code_file() {
  case "$1" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) return 0 ;;
    *.py) return 0 ;;
    *.go) return 0 ;;
    *.rs) return 0 ;;
    *.java|*.kt|*.scala) return 0 ;;
    *.swift|*.m|*.mm) return 0 ;;
    *.rb) return 0 ;;
    *.c|*.cc|*.cpp|*.h|*.hpp) return 0 ;;
    *.vue|*.svelte) return 0 ;;
    *) return 1 ;;
  esac
}

# Exclude test files themselves from the "needs coverage" list.
is_test_file() {
  case "$1" in
    *.spec.*|*.test.*|*_test.go|*_test.py|tests/*|*/tests/*|test/*|*/test/*|e2e/*|*/e2e/*) return 0 ;;
    *) return 1 ;;
  esac
}

code_touched=()
while IFS= read -r f; do
  [ -z "$f" ] && continue
  [ -f "$f" ] || continue            # skip deletions
  is_code_file "$f" || continue
  is_test_file "$f" && continue
  code_touched+=("$f")
done <<< "$touched"

if [ "${#code_touched[@]}" -eq 0 ]; then
  emit_info "no production code files touched since $START_SHA — coverage check skipped"
  emit_info "phase $PHASE_N e2e gate OK (executed=$re_executed passed=$re_passed failed=$re_failed)"
  exit 0
fi

# Build a flat list of proven_by strings for grep matching.
proven_by_list="$(jq -r '.claims[]? | .proven_by // empty' "$CLAIMS_FILE")"
if [ -z "$proven_by_list" ]; then
  emit_block "NO_PROVEN_BY claims.json has no proven_by references but ${#code_touched[@]} code file(s) were touched"
  exit 2
fi

uncovered=()
for f in "${code_touched[@]}"; do
  base="$(basename "$f")"
  stem="${base%.*}"
  # Match if the file basename or stem appears anywhere in proven_by, OR if a
  # sibling spec file (same stem with .spec/.test) is referenced.
  if printf '%s\n' "$proven_by_list" | grep -F -q -e "$base" -e "$stem"; then
    continue
  fi
  uncovered+=("$f")
done

if [ "${#uncovered[@]}" -gt 0 ]; then
  emit_block "UNCOVERED_FILES no e2e proven_by reference found for: ${uncovered[*]}"
  exit 2
fi

emit_info "phase $PHASE_N e2e gate OK (executed=$re_executed passed=$re_passed failed=$re_failed, code files covered: ${#code_touched[@]})"
exit 0
