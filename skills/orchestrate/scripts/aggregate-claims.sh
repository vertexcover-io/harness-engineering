#!/usr/bin/env bash
# Aggregate every phase-<N>-claims.json for a spec into one claims.json.
# Usage: aggregate-claims.sh <WORKTREE_PATH> <SPEC_NAME>
#
# Output shape and the downstream `executed > 0` / `failed = 0` check:
#   skills/orchestrate/references/claims-aggregation-format.md
#
# Exits 1 with MISSING_PHASE_CLAIMS when the coder produced no phase reports —
# orchestrate stops the pipeline on that token.

WORKTREE_PATH="${1:?usage: aggregate-claims.sh <WORKTREE_PATH> <SPEC_NAME>}"
SPEC_NAME="${2:?usage: aggregate-claims.sh <WORKTREE_PATH> <SPEC_NAME>}"

cd "$WORKTREE_PATH" || exit 1
HARNESS_SPEC_DIR=".harness/$SPEC_NAME"
shopt -s nullglob
PHASE_FILES=( "$HARNESS_SPEC_DIR"/phase-*-claims.json )
if [ ${#PHASE_FILES[@]} -eq 0 ]; then
  echo 'MISSING_PHASE_CLAIMS — coder produced no phase-*-claims.json files'; exit 1
fi
jq -s --arg spec "$SPEC_NAME" '{
  spec: $spec,
  aggregated_at: (now | todate),
  executed: (map(.executed // 0) | add),
  passed:   (map(.passed   // 0) | add),
  failed:   (map(.failed   // 0) | add),
  phases:   (map(.phase)),
  e2e_runs: (map(select(.e2e_run != null) | {
              phase: .phase,
              runner: .e2e_run.runner,
              report_path: .e2e_run.report_path,
              command: .e2e_run.command,
              executed: .executed,
              passed:   .passed,
              failed:   .failed,
              started_at:  .e2e_run.started_at,
              finished_at: .e2e_run.finished_at
            })),
  claims:   (map(.claims // []) | add)
}' "${PHASE_FILES[@]}" > "$HARNESS_SPEC_DIR/claims.json"
