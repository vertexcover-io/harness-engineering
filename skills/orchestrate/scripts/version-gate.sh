#!/usr/bin/env bash
# Compares the installed harness plugin version against the one published on main.
# Prints: VERSION_GATE=OK|UNKNOWN|STALE local=<x> remote=<y>
# Exits 0 for OK and UNKNOWN, 1 for STALE.
set -u

REMOTE_URL="https://raw.githubusercontent.com/vertexcover-io/harness-engineering/main/.claude-plugin/plugin.json"

# Rejects empty, non-numeric, leading-dot and trailing-dot strings, so only a
# dotted numeric ever reaches the comparison. Anything else degrades to UNKNOWN
# rather than being compared as garbage — a proxy or rate-limit page that
# happens to be JSON must not read as a version.
semver() { case "$1" in ''|*[!0-9.]*|.*|*.) return 1 ;; esac; }

# A plugin runtime exports one of these roots. Standalone invocation exports
# neither, so walk up from this script to the checkout that contains it.
manifest_path() {
  local root dir
  root="${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
  if [ -n "$root" ]; then
    printf '%s\n' "$root/.claude-plugin/plugin.json"
    return 0
  fi
  dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
  while [ "$dir" != "/" ]; do
    if [ -f "$dir/.claude-plugin/plugin.json" ]; then
      printf '%s\n' "$dir/.claude-plugin/plugin.json"
      return 0
    fi
    dir=$(dirname -- "$dir")
  done
  return 1
}

MANIFEST=$(manifest_path) || MANIFEST=/dev/null
LOCAL=$(jq -er '.version // empty' "$MANIFEST" 2>/dev/null) || LOCAL=''

# 10s covers a cold DNS + TLS handshake on a slow link, and caps what a hung
# network can cost a caller that only wanted a pre-flight check. An unreachable
# remote is UNKNOWN, which never blocks — so failing fast is the cheap side.
REMOTE=$(curl -fsSL --max-time 10 "$REMOTE_URL" 2>/dev/null | jq -er '.version // empty' 2>/dev/null) || REMOTE=''

semver "$LOCAL" || LOCAL=''
semver "$REMOTE" || REMOTE=''

if [ -z "$LOCAL" ] || [ -z "$REMOTE" ]; then
  echo "VERSION_GATE=UNKNOWN local=${LOCAL:-?} remote=${REMOTE:-?}"
  exit 0
fi

# Field-wise numeric sort rather than `sort -V`, which is absent on some BSD
# userlands. Highest sorts last, so local winning the tail means local >= remote
# — equal versions, and a dev checkout ahead of main, both land on OK.
if [ "$(printf '%s\n%s\n' "$LOCAL" "$REMOTE" | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)" = "$LOCAL" ]; then
  echo "VERSION_GATE=OK local=$LOCAL remote=$REMOTE"
  exit 0
fi

echo "VERSION_GATE=STALE local=$LOCAL remote=$REMOTE"
exit 1
