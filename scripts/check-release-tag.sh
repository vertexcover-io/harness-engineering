#!/usr/bin/env bash
# Checks that a release tag agrees with the files it points at: every manifest (root, both plugin
# manifests and each packages/*/package.json) carries its version, and both marketplaces pin it.
# Prints every mismatch, not just the first.
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
for manifest in package.json .claude-plugin/plugin.json .codex-plugin/plugin.json packages/*/package.json; do
  declared=$(jq -r .version "$manifest")
  if [ "$declared" != "$version" ]; then
    echo "$manifest has version $declared, not $version" >&2
    status=1
  fi
done

# `yok plugin install` reads the marketplace at the binary's own tag, so each must pin it.
for marketplace in .claude-plugin/marketplace.json .agents/plugins/marketplace.json; do
  pinned=$(jq -r '.plugins[] | select(.name == "yok") | .source.ref' "$marketplace")
  if [ "$pinned" != "$tag" ]; then
    echo "$marketplace pins $pinned, not $tag" >&2
    status=1
  fi
done

exit "$status"
