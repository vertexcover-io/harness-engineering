#!/usr/bin/env bash
# Runs orchestrate Initialization Step 1 — input detection plus the plugin
# version gate — in one invocation, so the pair costs one agent round-trip.
# Prints exactly four lines:
#   AUTO_MODE=true|false
#   INPUT_KIND=prompt|file|findings
#   INPUT_PATH=<absolute path, empty when INPUT_KIND=prompt>
#   VERSION_GATE=OK|UNKNOWN|STALE local=<x> remote=<y>
# Exits 0 for OK and UNKNOWN, 1 for STALE — same contract as version-gate.sh.
set -u

if [ "$#" -gt 0 ]; then RAW="$*"; else RAW=""; fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

# --- Step 1.1: --auto detection and stripping --------------------------------
# Matched on token boundaries so a path that merely contains the substring
# (e.g. ./docs/--auto-notes.md) is neither flagged nor mangled.
AUTO_MODE=false
case " $RAW " in *" --auto "*) AUTO_MODE=true ;; esac
ARG=$(printf '%s' "$RAW" | sed -E \
  -e 's/(^|[[:space:]])--auto([[:space:]]|$)/\1/g' \
  -e 's/^[[:space:]]+//' -e 's/[[:space:]]+$//')

# --- Step 1.2/1.3: file vs inline prompt -------------------------------------
abs_path() {
  local dir base
  dir=$(dirname -- "$1")
  base=$(basename -- "$1")
  printf '%s/%s\n' "$(CDPATH= cd -- "$dir" && pwd -P)" "$base"
}

# A tech-debt-finder manifest is identified by shape, not by filename: a
# non-empty `findings` array whose every entry carries the `auto_fixable` flag
# that the auto-fix hand-off contract dispositions on. `all` over an empty array
# is vacuously true, hence the explicit length check.
is_findings_manifest() {
  command -v jq >/dev/null 2>&1 || return 1
  jq -e '
    (.findings? | type) == "array"
    and (.findings | length) > 0
    and (all(.findings[]; type == "object" and has("auto_fixable")))
  ' "$1" >/dev/null 2>&1
}

INPUT_KIND=prompt
INPUT_PATH=""
if [ -n "$ARG" ] && [ -f "$ARG" ]; then
  INPUT_PATH=$(abs_path "$ARG")
  if is_findings_manifest "$INPUT_PATH"; then
    INPUT_KIND=findings
  else
    INPUT_KIND=file
  fi
fi

# --- Step 2: plugin version gate ---------------------------------------------
# Delegated to version-gate.sh — single source of truth for the verdict.
version_gate_path() {
  local root dir
  root="${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
  if [ -n "$root" ] && [ -f "$root/skills/orchestrate/scripts/version-gate.sh" ]; then
    printf '%s\n' "$root/skills/orchestrate/scripts/version-gate.sh"
    return 0
  fi
  if [ -f "$SCRIPT_DIR/version-gate.sh" ]; then
    printf '%s\n' "$SCRIPT_DIR/version-gate.sh"
    return 0
  fi
  dir="$SCRIPT_DIR"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/skills/orchestrate/scripts/version-gate.sh" ]; then
      printf '%s\n' "$dir/skills/orchestrate/scripts/version-gate.sh"
      return 0
    fi
    dir=$(dirname -- "$dir")
  done
  return 1
}

GATE_SCRIPT=$(version_gate_path) || GATE_SCRIPT=""
if [ -n "$GATE_SCRIPT" ]; then
  GATE_LINE=$(bash "$GATE_SCRIPT")
  GATE_STATUS=$?
else
  # A gate that cannot be found is UNKNOWN, never STALE: an unreadable version
  # is never grounds to block a ticket.
  GATE_LINE="VERSION_GATE=UNKNOWN local=? remote=?"
  GATE_STATUS=0
fi

# --- Step 3: environment preflight -------------------------------------------
# Runs before the worktree exists, so a red environment halts with nothing to
# clean up. Prints PREFLIGHT=OK, PREFLIGHT=FAIL <names>, or PREFLIGHT=UNKNOWN.
# The failing names index the fix steps preflight.ts prints on its own stderr/stdout;
# this line never carries them.
preflight_path() {
  local root dir
  root="${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
  if [ -n "$root" ] && [ -f "$root/skills/_shared/preflight.ts" ]; then
    printf '%s\n' "$root/skills/_shared/preflight.ts"
    return 0
  fi
  dir="$SCRIPT_DIR"
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/skills/_shared/preflight.ts" ]; then
      printf '%s\n' "$dir/skills/_shared/preflight.ts"
      return 0
    fi
    dir=$(dirname -- "$dir")
  done
  return 1
}

PREFLIGHT_SCRIPT=$(preflight_path) || PREFLIGHT_SCRIPT=""
if [ -z "$PREFLIGHT_SCRIPT" ] || ! command -v node >/dev/null 2>&1; then
  # No script or no node to run it: report UNKNOWN rather than inventing a
  # verdict. A check that could not run is not a check that passed.
  PREFLIGHT_LINE="PREFLIGHT=UNKNOWN"
else
  PREFLIGHT_JSON=$(node --experimental-strip-types "$PREFLIGHT_SCRIPT" --json 2>/dev/null)
  if [ -z "$PREFLIGHT_JSON" ] || ! command -v jq >/dev/null 2>&1; then
    PREFLIGHT_LINE="PREFLIGHT=UNKNOWN"
  else
    FAILED=$(printf '%s' "$PREFLIGHT_JSON" \
      | jq -r '[.results[] | select(.status != "ok") | .name] | join(",")' 2>/dev/null)
    if [ -z "$FAILED" ]; then
      PREFLIGHT_LINE="PREFLIGHT=OK"
    else
      PREFLIGHT_LINE="PREFLIGHT=FAIL $FAILED"
    fi
  fi
fi

printf 'AUTO_MODE=%s\n' "$AUTO_MODE"
printf 'INPUT_KIND=%s\n' "$INPUT_KIND"
printf 'INPUT_PATH=%s\n' "$INPUT_PATH"
printf '%s\n' "$GATE_LINE"
printf '%s\n' "$PREFLIGHT_LINE"

exit "$GATE_STATUS"
