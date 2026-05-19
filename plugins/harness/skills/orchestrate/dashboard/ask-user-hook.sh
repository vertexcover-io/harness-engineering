#!/usr/bin/env bash
set -euo pipefail

# Hook script for AskUserQuestion tool calls.
# Pre-hook:  finds the currently running node in the DAG and sets it to "waiting"
# Post-hook: finds the "waiting" node and sets it back to "running"
#
# Usage: ask-user-hook.sh <pre|post>
# Env: Looks for .harness/*/dag.json with outcome "running" in the working directory.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DU="/usr/bin/env bash $SCRIPT_DIR/dag-update.sh"

ACTION="${1:-pre}"

# Read active harness directory from breadcrumb written by dag-update init
[[ -f /tmp/.claude-harness-active ]] || exit 0
export HARNESS_DIR
HARNESS_DIR="$(cat /tmp/.claude-harness-active)"
[[ -d "$HARNESS_DIR" ]] || exit 0

DAG_FILE="$HARNESS_DIR/dag.json"
[[ -f "$DAG_FILE" ]] || exit 0

case "$ACTION" in
  pre)
    # Find the first node with status "running" and set it to "waiting"
    NODE_ID="$(jq -r '[.nodes | to_entries[] | select(.value.status == "running")] | last | .key // empty' "$DAG_FILE")"
    if [[ -n "$NODE_ID" ]]; then
      $DU set-status "$NODE_ID" waiting
      # Desktop notification + focus terminal
      LABEL="$(jq -r ".nodes[\"$NODE_ID\"].label // \"$NODE_ID\"" "$DAG_FILE")"
      if command -v notify-send >/dev/null 2>&1; then
        notify-send -u normal -i dialog-question "Pipeline: Input Required" "$LABEL is waiting for your response" 2>/dev/null || true
        # Focus the terminal window on Linux
        if command -v xdotool >/dev/null 2>&1; then
          # Find the terminal window by walking up from our parent process
          TERM_PID="$(ps -o ppid= -p $PPID 2>/dev/null | tr -d ' ')" || true
          if [[ -n "$TERM_PID" ]]; then
            TERM_WID="$(xdotool search --pid "$TERM_PID" 2>/dev/null | head -1)" || true
            [[ -n "$TERM_WID" ]] && xdotool windowactivate "$TERM_WID" 2>/dev/null || true
          fi
        fi
      elif command -v osascript >/dev/null 2>&1; then
        # On macOS: detect terminal app and activate it
        TERM_APP="${TERM_PROGRAM:-Terminal}"
        osascript -e "
          display notification \"$LABEL is waiting for your response\" with title \"Pipeline: Input Required\"
          tell application \"$TERM_APP\" to activate
        " 2>/dev/null || true
      fi
    fi
    ;;
  post)
    # Find the first node with status "waiting" and set it back to "running"
    NODE_ID="$(jq -r '[.nodes | to_entries[] | select(.value.status == "waiting")] | last | .key // empty' "$DAG_FILE")"
    if [[ -n "$NODE_ID" ]]; then
      $DU set-status "$NODE_ID" running
    fi
    ;;
esac
