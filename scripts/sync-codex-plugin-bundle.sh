#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/plugins/harness"

mkdir -p "$DEST"

for path in \
  .codex-plugin \
  .codex \
  skills \
  hooks \
  assets \
  references \
  README.md
do
  if [[ -e "$ROOT/$path" ]]; then
    rsync -a --delete "$ROOT/$path" "$DEST/"
  fi
done

rm -f "$DEST/AGENTS.md" "$DEST/CLAUDE.md" "$DEST/permission-reviewer.sh" "$DEST/settings.json"
find "$DEST" -name .DS_Store -delete
