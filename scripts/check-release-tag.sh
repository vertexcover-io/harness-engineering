#!/usr/bin/env bash
# Checks that a release tag agrees with the files it points at: both manifests carry its
# version, and each marketplace that should pin it does. Prints every mismatch, not just the first.
# Usage: check-release-tag.sh vX.Y.Z[-rc.N]
set -euo pipefail

tag="${1:-}"
if [ -z "$tag" ]; then
  echo "usage: check-release-tag.sh vX.Y.Z[-rc.N]" >&2
  exit 2
fi
cd "$(dirname "$0")/.."

version="${tag#v}"
status=0

# An install reports plugin.json's version, so a tag that disagrees installs as something it is not.
for manifest in package.json .claude-plugin/plugin.json; do
  declared=$(jq -r .version "$manifest")
  if [ "$declared" != "$version" ]; then
    echo "$manifest has version $declared, not $version" >&2
    status=1
  fi
done

# Users get only what a marketplace pins. A pre-release must not move stable users.
marketplaces=(.claude-plugin/pre-release/marketplace.json)
case "$tag" in *-*) ;; *) marketplaces+=(.claude-plugin/marketplace.json) ;; esac
for marketplace in "${marketplaces[@]}"; do
  pinned=$(jq -r '.plugins[] | select(.name == "harness") | .source.ref' "$marketplace")
  if [ "$pinned" != "$tag" ]; then
    echo "$marketplace pins $pinned, not $tag" >&2
    status=1
  fi
done

exit "$status"
