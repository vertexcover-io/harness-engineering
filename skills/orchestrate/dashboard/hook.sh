#!/usr/bin/env bash
# Orchestrate dashboard hook — maps Claude Code tool events to pipeline stages.
# Called by PreToolUse/PostToolUse hooks for Skill and Agent tools.
#
# Usage: hook.sh pre|post  (reads hook event JSON from stdin)
#
# Requires /tmp/orchestrate-session.json to exist (written by orchestrate SKILL.md).
# If missing, the hook no-ops (not an orchestrate run).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD="$SCRIPT_DIR/dashboard.sh"
SESSION_FILE="/tmp/orchestrate-session.json"

# ── Handle cleanup (SessionEnd) ──
if [ "${1:-}" = "cleanup" ]; then
  if [ -f "$SESSION_FILE" ]; then
    SPEC_NAME=$(jq -r '.specName' "$SESSION_FILE")
    DASHBOARD_DIR="/tmp/orchestrate-${SPEC_NAME}"
    if [ -f "$DASHBOARD_DIR/.server-pid" ]; then
      kill "$(cat "$DASHBOARD_DIR/.server-pid")" 2>/dev/null || true
    fi
    rm -f "$SESSION_FILE"
  fi
  exit 0
fi

# ── Gate: only run during orchestrate ──
[ -f "$SESSION_FILE" ] || exit 0

# ── Read inputs ──
PHASE="${1:-}"  # "pre" or "post"
INPUT=$(cat)

SPEC_NAME=$(jq -r '.specName' "$SESSION_FILE")
DASHBOARD_DIR="/tmp/orchestrate-${SPEC_NAME}"

# ── Extract tool info from hook event ──
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty')
[ -z "$TOOL_NAME" ] && exit 0

# ── Map tool events to pipeline stages ──
# Returns stage ID (0-7) or empty if not a pipeline event
map_stage() {
  local tool="$1"

  if [ "$tool" = "Skill" ]; then
    local skill
    skill=$(echo "$INPUT" | jq -r '.tool_input.skill // empty')
    case "$skill" in
      pipeline-setup)      echo 0 ;;
      brainstorm)          echo 1 ;;
      spec-generation)     echo 1 ;;  # part of brainstorm stage
      planning)            echo 2 ;;
      *)                   echo "" ;;
    esac
  elif [ "$tool" = "Agent" ]; then
    local prompt
    prompt=$(echo "$INPUT" | jq -r '.tool_input.prompt // empty' | tr '[:upper:]' '[:lower:]')
    [ -z "$prompt" ] && return

    # Match by skill name mentioned in the agent prompt
    if echo "$prompt" | grep -q "tdd skill\|invoke the tdd"; then
      echo 3
    elif echo "$prompt" | grep -q "quality-gate skill\|invoke the quality-gate"; then
      echo 4
    elif echo "$prompt" | grep -q "sync-docs skill\|invoke the sync-docs"; then
      echo 5
    elif echo "$prompt" | grep -q "learn skill\|invoke the learn"; then
      echo 6
    elif echo "$prompt" | grep -q "git-commit skill\|invoke the git-commit"; then
      echo 7
    else
      echo ""
    fi
  fi
}

STAGE_ID=$(map_stage "$TOOL_NAME")
[ -z "$STAGE_ID" ] && exit 0

# ── Stage names for log messages ──
STAGE_NAMES=("Setup" "Brainstorm" "Planner" "Coder" "Quality Gate" "Sync Docs" "Learnings" "Commit & PR")
STAGE_NAME="${STAGE_NAMES[$STAGE_ID]}"

# ── Handle pre/post ──
case "$PHASE" in
  pre)
    # Special case: first event (pipeline-setup) triggers dashboard init
    if [ "$STAGE_ID" = "0" ] && [ ! -f "$DASHBOARD_DIR/status.json" ]; then
      TASK=$(jq -r '.task' "$SESSION_FILE")
      BRANCH=$(jq -r '.branch' "$SESSION_FILE")
      WORKTREE=$(jq -r '.worktree' "$SESSION_FILE")
      INIT_OUTPUT=$(bash "$DASHBOARD" init "$SPEC_NAME" "$TASK" "$BRANCH" "$WORKTREE" 2>/dev/null) || true
      # Print dashboard URL to stderr so it appears in Claude Code conversation
      if echo "$INIT_OUTPUT" | grep -q "Dashboard:"; then
        echo "$INIT_OUTPUT" >&2
      fi
    fi
    bash "$DASHBOARD" update "$SPEC_NAME" "$STAGE_ID" running --log "$STAGE_NAME started" 2>/dev/null || true
    ;;
  post)
    # Check if the tool failed
    is_error=$(echo "$INPUT" | jq -r '.tool_response.is_error // false') 2>/dev/null || is_error="false"
    if [ "$is_error" = "true" ]; then
      bash "$DASHBOARD" update "$SPEC_NAME" "$STAGE_ID" failed --log "$STAGE_NAME failed" 2>/dev/null || true
    else
      bash "$DASHBOARD" update "$SPEC_NAME" "$STAGE_ID" done --log "$STAGE_NAME complete" 2>/dev/null || true
    fi

    # Auto-finalize after last stage (Commit & PR)
    if [ "$STAGE_ID" = "7" ] && [ "$is_error" != "true" ]; then
      bash "$DASHBOARD" finalize "$SPEC_NAME" success --log "Pipeline complete" 2>/dev/null || true
      rm -f "$SESSION_FILE"
    fi

    # Finalize on failure if quality gate fails
    if [ "$STAGE_ID" = "4" ] && [ "$is_error" = "true" ]; then
      bash "$DASHBOARD" finalize "$SPEC_NAME" blocked --log "Pipeline blocked at Quality Gate" 2>/dev/null || true
      rm -f "$SESSION_FILE"
    fi
    ;;
esac

exit 0
