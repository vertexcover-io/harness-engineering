#!/usr/bin/env bash
# Stop / SubagentStop hook: block return if an active spec under docs/spec/
# has no verification/proof-report.md. The functional-verify skill produces
# that file; its absence means verification did not happen.
#
# Wired in .claude/settings.json under hooks.Stop AND hooks.SubagentStop.
# SubagentStop is the critical one for orchestrate — it fires when the
# functional-verify sub-agent tries to return, which is the actual choke point.
#
# Bypass: set HARNESS_SKIP_VERIFY_GATE=1 in env when you genuinely don't want
# the gate (e.g. doc-only changes, exploratory sessions). Do not set this by
# default — the whole point is that skipping is detectable.

set -euo pipefail

if [[ "${HARNESS_SKIP_VERIFY_GATE:-0}" == "1" ]]; then
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
SPEC_ROOT="${REPO_ROOT}/docs/spec"

if [[ ! -d "$SPEC_ROOT" ]]; then
  exit 0
fi

# An "active" spec = directory under docs/spec/ that has a spec.md AND was
# touched in the last 24h (created or modified). Avoids blocking on long-dead
# specs while catching anything the current session worked on.
missing=()
while IFS= read -r spec_md; do
  spec_dir="$(dirname "$spec_md")"
  spec_name="$(basename "$spec_dir")"
  if [[ -z "$(find "$spec_dir" -maxdepth 1 -mtime -1 -print -quit 2>/dev/null)" ]]; then
    continue
  fi
  if [[ ! -f "$spec_dir/verification/proof-report.md" ]]; then
    missing+=("$spec_name")
  fi
done < <(find "$SPEC_ROOT" -maxdepth 2 -name spec.md -type f 2>/dev/null)

if (( ${#missing[@]} == 0 )); then
  exit 0
fi

# Exit 2 = block Stop, message goes back to the model.
cat >&2 <<EOF
Verification gate: the following active spec(s) have no proof-report.md:

$(printf '  - %s\n' "${missing[@]}")

Passing unit/e2e tests are NOT verification. Invoke the functional-verify skill
before ending this session — it must produce docs/spec/<name>/verification/proof-report.md
for each active spec. If verification genuinely does not apply to this session,
re-run with HARNESS_SKIP_VERIFY_GATE=1 in env (and say so in the PR).
EOF
exit 2
