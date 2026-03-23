#!/usr/bin/env bash
set -euo pipefail

# ── dag-update.sh ──
# Manages .harness/<SPEC_NAME>/dag.json with atomic, flock-protected writes.
# Usage: dag-update <command> [args...]
# Env: HARNESS_DIR must be set (except for 'init' which creates it)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Prerequisite check ──
check_prereqs() {
  command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required but not installed." >&2; exit 1; }
  command -v flock >/dev/null 2>&1 || { echo "ERROR: flock is required but not installed." >&2; exit 1; }
}

# ── Atomic write with flock ──
atomic_write() {
  local dag_file="$1"
  local jq_filter="$2"
  shift 2
  local lock_file="$(dirname "$dag_file")/dag.lock"
  (
    flock -x 200
    jq "$jq_filter" "$@" "$dag_file" > "$dag_file.tmp" && mv "$dag_file.tmp" "$dag_file"
  ) 200>"$lock_file"
}

# ── Commands ──

cmd_init() {
  local spec_name="$1"
  local task="$2"
  local branch="${3:-unknown}"
  local worktree="${4:-unknown}"

  check_prereqs

  local harness_dir=".harness/$spec_name"

  # Crash recovery: if a previous run exists with a stale server, finalize it first
  if [[ -f "$harness_dir/server.pid" ]]; then
    local old_pid
    old_pid="$(cat "$harness_dir/server.pid")"
    if ! kill -0 "$old_pid" 2>/dev/null; then
      HARNESS_DIR="$harness_dir" cmd_finalize "interrupted"
    fi
  fi

  mkdir -p "$harness_dir/reports"

  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  cat > "$harness_dir/dag.json" <<ENDJSON
{
  "meta": {
    "specName": "$spec_name",
    "task": $(printf '%s' "$task" | jq -Rs .),
    "branch": "$branch",
    "worktree": "$worktree",
    "startedAt": "$now",
    "completedAt": null,
    "outcome": "running"
  },
  "nodes": {},
  "edges": []
}
ENDJSON

  echo "$harness_dir"
}

cmd_add_node() {
  local node_id="$1"
  local label="$2"
  local parent=""
  local depends_on=""
  shift 2

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --parent) parent="$2"; shift 2 ;;
      --depends-on) depends_on="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local dag_file="$HARNESS_DIR/dag.json"
  local jq_filter

  jq_filter='
    .nodes[$id] = {
      "label": $label,
      "status": "pending",
      "startedAt": null,
      "completedAt": null,
      "artifacts": {},
      "children": []
    }
  '

  if [[ -n "$parent" ]]; then
    jq_filter="$jq_filter | .nodes[\$parent].children += [\$id]"
  fi

  local jq_args=(--arg id "$node_id" --arg label "$label")
  if [[ -n "$parent" ]]; then
    jq_args+=(--arg parent "$parent")
  fi

  atomic_write "$dag_file" "$jq_filter" "${jq_args[@]}"

  # Add edges for --depends-on
  if [[ -n "$depends_on" ]]; then
    IFS=',' read -ra deps <<< "$depends_on"
    for dep in "${deps[@]}"; do
      dep="$(echo "$dep" | xargs)"
      atomic_write "$dag_file" '.edges += [[$from, $to]]' --arg from "$dep" --arg to "$node_id"
    done
  fi
}

cmd_add_edge() {
  local from="$1"
  local to="$2"
  local dag_file="$HARNESS_DIR/dag.json"

  atomic_write "$dag_file" '.edges += [[$from, $to]]' --arg from "$from" --arg to "$to"
}

cmd_set_status() {
  local node_id="$1"
  local status="$2"
  local dag_file="$HARNESS_DIR/dag.json"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  local jq_filter='.nodes[$id].status = $status'

  case "$status" in
    running)
      jq_filter="$jq_filter | .nodes[\$id].startedAt = \$now"
      ;;
    done|failed|interrupted|skipped)
      jq_filter="$jq_filter | .nodes[\$id].completedAt = \$now"
      ;;
  esac

  atomic_write "$dag_file" "$jq_filter" --arg id "$node_id" --arg status "$status" --arg now "$now"
}

cmd_set_artifact() {
  local node_id="$1"
  local key="$2"
  local value="$3"
  local dag_file="$HARNESS_DIR/dag.json"

  atomic_write "$dag_file" '.nodes[$id].artifacts[$key] = $val' \
    --arg id "$node_id" --arg key "$key" --arg val "$value"
}

cmd_write_report() {
  local node_id="$1"
  local content="$2"
  local report_file="reports/${node_id}-report.md"
  local report_path="$HARNESS_DIR/$report_file"

  printf '%s' "$content" > "$report_path"

  # Store path relative to HARNESS_DIR (the HTTP server root)
  cmd_set_artifact "$node_id" "report" "$report_file"
}

cmd_serve() {
  local harness_dir="${HARNESS_DIR:?HARNESS_DIR must be set}"

  # Copy HTML template
  cp "$SCRIPT_DIR/index.html" "$harness_dir/index.html"

  # Start Python HTTP server on random port with unbuffered output
  python3 -u -m http.server 0 --directory "$harness_dir" > "$harness_dir/server.log" 2>&1 &
  local server_pid=$!
  echo "$server_pid" > "$harness_dir/server.pid"

  # Wait for server to print its port (retry up to 3 seconds)
  local port=""
  for i in 1 2 3 4 5 6; do
    sleep 0.5
    port="$(grep -oP 'port \K[0-9]+' "$harness_dir/server.log" 2>/dev/null || true)"
    if [[ -n "$port" ]]; then
      break
    fi
  done

  # Fallback: read port from the process's listening socket
  if [[ -z "$port" ]]; then
    port="$(ss -tlnp 2>/dev/null | grep "pid=$server_pid" | grep -oP ':(\d+)' | head -1 | tr -d ':' || true)"
  fi

  if [[ -n "$port" ]]; then
    echo "$port" > "$harness_dir/server.port"
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "http://localhost:$port" 2>/dev/null &
    elif command -v open >/dev/null 2>&1; then
      open "http://localhost:$port" 2>/dev/null &
    fi
    echo "http://localhost:$port"
  else
    echo "WARNING: Could not determine server port. Check $harness_dir/server.log" >&2
  fi
}

cmd_finalize() {
  local outcome="${1:-interrupted}"

  # Find HARNESS_DIR if not set — look for any active run
  if [[ -z "${HARNESS_DIR:-}" ]]; then
    local active_dir
    active_dir="$(find .harness/ -name dag.json -exec grep -l '"outcome": "running"' {} \; 2>/dev/null | head -1 || true)"
    if [[ -z "$active_dir" ]]; then
      exit 0
    fi
    HARNESS_DIR="$(dirname "$active_dir")"
  fi

  local dag_file="$HARNESS_DIR/dag.json"
  [[ -f "$dag_file" ]] || exit 0

  # Check if already finalized — idempotent
  local current_outcome
  current_outcome="$(jq -r '.meta.outcome' "$dag_file")"
  if [[ "$current_outcome" != "running" ]]; then
    exit 0
  fi

  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Set outcome and mark any running nodes as the outcome status
  atomic_write "$dag_file" '
    .meta.outcome = $outcome |
    .meta.completedAt = $now |
    (.nodes | to_entries | map(
      if .value.status == "running" then .value.status = $outcome | .value.completedAt = $now
      else . end
    ) | from_entries) as $updated_nodes |
    .nodes = $updated_nodes
  ' --arg outcome "$outcome" --arg now "$now"

  # Inline data into HTML
  if [[ -f "$HARNESS_DIR/index.html" ]]; then
    local dag_data reports_data

    dag_data="$(cat "$dag_file")"

    # Collect all reports
    reports_data="{}"
    while IFS= read -r node_id; do
      local report_path
      report_path="$(jq -r ".nodes[\"$node_id\"].artifacts.report // empty" "$dag_file")"
      # Resolve relative paths against HARNESS_DIR
      local resolved_path="$report_path"
      if [[ -n "$report_path" && ! "$report_path" = /* && -f "$HARNESS_DIR/$report_path" ]]; then
        resolved_path="$HARNESS_DIR/$report_path"
      fi
      if [[ -n "$report_path" && -f "$resolved_path" ]]; then
        local content
        content="$(jq -Rs . "$resolved_path")"
        reports_data="$(echo "$reports_data" | jq --arg k "$node_id" --argjson v "$content" '. + {($k): $v}')"
      fi
    done < <(jq -r '.nodes | keys[]' "$dag_file")

    # Write reports to temp file for safe Python ingestion
    echo "$reports_data" > "$HARNESS_DIR/reports-data.tmp"

    # Inject into HTML
    python3 - "$HARNESS_DIR" "$dag_file" <<'PYEOF'
import sys, re, os
harness_dir = sys.argv[1]
dag_file = sys.argv[2]
html_path = os.path.join(harness_dir, "index.html")
reports_path = os.path.join(harness_dir, "reports-data.tmp")

html = open(html_path).read()
dag = open(dag_file).read()
reports = open(reports_path).read()

# Escape </script> in data to prevent breaking the HTML
dag_safe = dag.replace('</script>', '<\\/script>')
reports_safe = reports.replace('</script>', '<\\/script>')

html = re.sub(
    r'(<script type="application/json" id="dag-data">)(.*?)(</script>)',
    lambda m: m.group(1) + dag_safe + m.group(3), html, count=1, flags=re.DOTALL)
html = re.sub(
    r'(<script type="application/json" id="reports-data">)(.*?)(</script>)',
    lambda m: m.group(1) + reports_safe + m.group(3), html, count=1, flags=re.DOTALL)
open(html_path, 'w').write(html)
PYEOF
    rm -f "$HARNESS_DIR/reports-data.tmp"
  fi

  # Kill server
  if [[ -f "$HARNESS_DIR/server.pid" ]]; then
    kill "$(cat "$HARNESS_DIR/server.pid")" 2>/dev/null || true
    rm -f "$HARNESS_DIR/server.pid" "$HARNESS_DIR/server.port"
  fi
}

# ── Dispatch ──

case "${1:-}" in
  init)         shift; cmd_init "$@" ;;
  add-node)     shift; cmd_add_node "$@" ;;
  add-edge)     shift; cmd_add_edge "$@" ;;
  set-status)   shift; cmd_set_status "$@" ;;
  set-artifact) shift; cmd_set_artifact "$@" ;;
  write-report) shift; cmd_write_report "$@" ;;
  serve)        shift; cmd_serve "$@" ;;
  finalize)     shift; cmd_finalize "$@" ;;
  *)
    echo "Usage: dag-update <init|add-node|add-edge|set-status|set-artifact|write-report|serve|finalize> [args...]" >&2
    exit 1
    ;;
esac
