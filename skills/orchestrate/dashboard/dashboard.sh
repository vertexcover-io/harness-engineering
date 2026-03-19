#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/index.html"

STAGE_NAMES=("Setup" "Brainstorm" "Planner" "Coder" "Quality Gate" "Sync Docs" "Learnings" "Commit & PR")

dashboard_init() {
  local spec_name="$1" task_summary="$2" branch_name="$3" worktree_path="$4"
  local dashboard_dir="/tmp/orchestrate-${spec_name}"

  mkdir -p "$dashboard_dir"

  # Kill any orphan server from a previous run
  if [ -f "$dashboard_dir/.server-pid" ]; then
    kill "$(cat "$dashboard_dir/.server-pid")" 2>/dev/null || true
  fi

  # Clean up stale state from previous runs
  rm -f "$dashboard_dir/.dashboard-disabled" "$dashboard_dir/.server-log" "$dashboard_dir/.server-pid" "$dashboard_dir/.server-port"

  # Seed status.json with all 8 stages
  local stages="[]"
  for i in "${!STAGE_NAMES[@]}"; do
    stages=$(echo "$stages" | jq --argjson id "$i" --arg name "${STAGE_NAMES[$i]}" \
      '. + [{"id": $id, "name": $name, "status": "waiting", "startedAt": null, "completedAt": null, "error": null, "artifacts": {}}]')
  done

  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  jq -n \
    --arg task "$task_summary" \
    --arg specName "$spec_name" \
    --arg branch "$branch_name" \
    --arg worktree "$worktree_path" \
    --arg startedAt "$now" \
    --argjson stages "$stages" \
    '{
      task: $task,
      specName: $specName,
      branch: $branch,
      worktree: $worktree,
      startedAt: $startedAt,
      completedAt: null,
      outcome: "running",
      currentStage: 0,
      stages: $stages,
      log: [{"time": $startedAt, "stage": "Pipeline", "message": "Pipeline started"}]
    }' > "$dashboard_dir/status.json"

  # Copy HTML template
  cp "$TEMPLATE" "$dashboard_dir/index.html"

  # Start Python HTTP server on random port
  if ! command -v python3 &>/dev/null; then
    echo "WARNING: python3 not found, dashboard disabled"
    touch "$dashboard_dir/.dashboard-disabled"
    return 0
  fi

  # Start server in background (nohup + disown to survive hook exit)
  nohup python3 -m http.server 0 --directory "$dashboard_dir" &>/dev/null &
  disown
  local server_pid=$!
  echo "$server_pid" > "$dashboard_dir/.server-pid"

  # Detect the port via ss (server log is buffered and unreliable)
  local port="" attempts=0
  while [ -z "$port" ] && [ "$attempts" -lt 6 ]; do
    sleep 0.5
    port=$(ss -tlnp 2>/dev/null | grep "pid=${server_pid}," | grep -oP ':\K[0-9]+(?=\s)' | head -1) || true
    attempts=$((attempts + 1))
  done

  if [ -z "$port" ]; then
    echo "WARNING: Could not detect server port, dashboard disabled"
    kill "$server_pid" 2>/dev/null || true
    touch "$dashboard_dir/.dashboard-disabled"
    return 0
  fi

  echo "$port" > "$dashboard_dir/.server-port"

  # Open browser (non-fatal)
  local url="http://localhost:${port}"
  if command -v xdg-open &>/dev/null; then
    xdg-open "$url" 2>/dev/null || true
  elif command -v open &>/dev/null; then
    open "$url" 2>/dev/null || true
  fi

  echo "Dashboard: $url"
}

dashboard_update() {
  local spec_name="$1" stage_id="$2" status="$3"
  shift 3
  local dashboard_dir="/tmp/orchestrate-${spec_name}"

  # No-op if dashboard is disabled
  [ -f "$dashboard_dir/.dashboard-disabled" ] && return 0
  [ ! -f "$dashboard_dir/status.json" ] && return 0

  local now log_msg="" artifacts=()
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Parse optional flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --log) log_msg="$2"; shift 2 ;;
      --artifact) artifacts+=("$2"); shift 2 ;;
      *) shift ;;
    esac
  done

  local tmp_file="$dashboard_dir/status.json.tmp"

  # Update stage status and timestamps
  jq --argjson id "$stage_id" --arg status "$status" --arg now "$now" '
    .stages[$id].status = $status |
    if $status == "running" then
      .stages[$id].startedAt = $now |
      .currentStage = $id
    elif $status == "done" then
      .stages[$id].completedAt = $now
    elif $status == "failed" then
      .stages[$id].completedAt = $now
    else . end
  ' "$dashboard_dir/status.json" > "$tmp_file"

  # Add error message for failed status
  if [ "$status" = "failed" ] && [ -n "$log_msg" ]; then
    jq --argjson id "$stage_id" --arg err "$log_msg" \
      '.stages[$id].error = $err' "$tmp_file" > "$tmp_file.2"
    mv "$tmp_file.2" "$tmp_file"
  fi

  # Add artifacts (guard against empty array under set -u)
  if [ ${#artifacts[@]} -gt 0 ]; then
    for art in "${artifacts[@]}"; do
      local key="${art%%=*}" val="${art#*=}"
      jq --argjson id "$stage_id" --arg k "$key" --arg v "$val" \
        '.stages[$id].artifacts[$k] = $v' "$tmp_file" > "$tmp_file.2"
      mv "$tmp_file.2" "$tmp_file"
    done
  fi

  # Append log entry
  if [ -n "$log_msg" ]; then
    local stage_name
    stage_name=$(jq -r --argjson id "$stage_id" '.stages[$id].name' "$tmp_file")
    jq --arg time "$now" --arg stage "$stage_name" --arg msg "$log_msg" \
      '.log += [{"time": $time, "stage": $stage, "message": $msg}]' "$tmp_file" > "$tmp_file.2"
    mv "$tmp_file.2" "$tmp_file"
  fi

  mv "$tmp_file" "$dashboard_dir/status.json"
}

dashboard_finalize() {
  local spec_name="$1" outcome="$2"
  shift 2
  local dashboard_dir="/tmp/orchestrate-${spec_name}"
  local log_msg=""

  # Parse optional flags
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --log) log_msg="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  [ -f "$dashboard_dir/.dashboard-disabled" ] && return 0
  [ ! -f "$dashboard_dir/status.json" ] && return 0

  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Update outcome and completedAt
  local tmp_file="$dashboard_dir/status.json.tmp"
  jq --arg outcome "$outcome" --arg now "$now" \
    '.outcome = $outcome | .completedAt = $now' \
    "$dashboard_dir/status.json" > "$tmp_file"

  # Append final log entry
  if [ -n "$log_msg" ]; then
    jq --arg time "$now" --arg msg "$log_msg" \
      '.log += [{"time": $time, "stage": "Pipeline", "message": $msg}]' \
      "$tmp_file" > "$tmp_file.2"
    mv "$tmp_file.2" "$tmp_file"
  fi

  mv "$tmp_file" "$dashboard_dir/status.json"

  # Inline data into HTML for self-contained final report
  # Use Python for safe JSON insertion (sed breaks on newlines/special chars in JSON)
  python3 -c "
import sys, json
html_path = sys.argv[1]
json_path = sys.argv[2]
with open(json_path) as f:
    data = json.dumps(json.load(f))
with open(html_path) as f:
    html = f.read()
html = html.replace('// __INLINE_DATA_PLACEHOLDER__', 'const INLINE_DATA = ' + data + ';')
with open(html_path, 'w') as f:
    f.write(html)
" "$dashboard_dir/index.html" "$dashboard_dir/status.json"

  # Kill server
  if [ -f "$dashboard_dir/.server-pid" ]; then
    kill "$(cat "$dashboard_dir/.server-pid")" 2>/dev/null || true
    rm -f "$dashboard_dir/.server-pid" "$dashboard_dir/.server-port"
  fi

  echo "Dashboard finalized: $dashboard_dir/index.html"
}

# Main dispatch
cmd="${1:-}"
shift || true

case "$cmd" in
  init) dashboard_init "$@" ;;
  update) dashboard_update "$@" ;;
  finalize) dashboard_finalize "$@" ;;
  *) echo "Usage: dashboard.sh {init|update|finalize} ..." >&2; exit 1 ;;
esac
