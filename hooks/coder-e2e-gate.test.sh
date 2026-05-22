#!/usr/bin/env bash
# Test harness for coder-e2e-gate.sh.
# Pure bash, no external test framework. Each test sets up an isolated tmp
# git repo with a fake worktree and breadcrumb, runs the hook, asserts on
# exit code and stdout token.

set -uo pipefail

HOOK="$(cd "$(dirname "$0")" && pwd)/coder-e2e-gate.sh"
PASS=0
FAIL=0
FAILED_NAMES=()

# ── helpers ────────────────────────────────────────────────────────────────

make_sandbox() {
  local dir
  dir="$(mktemp -d -t coder-e2e-gate-XXXXXX)"
  (
    cd "$dir"
    git init -q
    git config user.email t@t
    git config user.name t
    git commit --allow-empty -q -m initial
  )
  echo "$dir"
}

write_breadcrumb() {
  local dir="$1" spec="$2" phase="$3" sha="$4"
  mkdir -p "$dir/.harness"
  cat > "$dir/.harness/current-phase" <<EOF
SPEC_NAME=$spec
PHASE_N=$phase
START_SHA=$sha
EOF
}

write_claims() {
  local dir="$1" spec="$2" phase="$3" body="$4"
  mkdir -p "$dir/.harness/$spec"
  printf '%s' "$body" > "$dir/.harness/$spec/phase-$phase-claims.json"
}

run_hook() {
  local dir="$1"
  (cd "$dir" && bash "$HOOK" 2>&1)
}

assert() {
  local name="$1" expected_code="$2" expected_token="$3"
  local actual_out actual_code
  actual_out="$4"
  actual_code="$5"

  local ok=1
  if [ "$actual_code" != "$expected_code" ]; then
    ok=0
  fi
  if [ -n "$expected_token" ] && ! grep -F -q "$expected_token" <<< "$actual_out"; then
    ok=0
  fi

  if [ $ok -eq 1 ]; then
    PASS=$((PASS + 1))
    printf '  ✓ %s\n' "$name"
  else
    FAIL=$((FAIL + 1))
    FAILED_NAMES+=("$name")
    printf '  ✗ %s\n' "$name"
    printf '    expected_code=%s expected_token=%q\n' "$expected_code" "$expected_token"
    printf '    actual_code=%s\n' "$actual_code"
    printf '    actual_out:\n'
    sed 's/^/      /' <<< "$actual_out"
  fi
}

# ── Test 1: no breadcrumb → no-op, exit 0 ──────────────────────────────────
test_no_breadcrumb() {
  local dir; dir="$(make_sandbox)"
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "no breadcrumb is no-op" 0 "" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 2: missing claims file ────────────────────────────────────────────
test_missing_claims() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "missing claims file blocks" 2 "MISSING_PHASE_CLAIMS" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 3: claims file is invalid JSON ────────────────────────────────────
test_unparseable_claims() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  write_claims "$dir" myspec 1 "this is not json"
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "unparseable claims blocks" 2 "PHASE_CLAIMS_UNPARSEABLE" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 4: not_applicable escape hatch ────────────────────────────────────
test_not_applicable() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  write_claims "$dir" myspec 1 '{"not_applicable": true}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "not_applicable=true skips gate" 0 "not_applicable" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 5: missing e2e_run.report_path ────────────────────────────────────
test_missing_report_path() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  write_claims "$dir" myspec 1 '{"executed":1,"passed":1,"failed":0,"claims":[]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "missing report_path blocks" 2 "MISSING_E2E_REPORT_PATH" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 6: report_path declared but file missing ──────────────────────────
test_missing_report_file() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  write_claims "$dir" myspec 1 '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/missing.json"},"claims":[]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "missing report file blocks" 2 "MISSING_E2E_REPORT" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 7: report shows zero executed ─────────────────────────────────────
test_zero_executed() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  mkdir -p "$dir/.harness/myspec"
  echo '{"executed":0,"passed":0,"failed":0}' > "$dir/.harness/myspec/run.json"
  write_claims "$dir" myspec 1 '{"executed":0,"passed":0,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "zero executed blocks" 2 "E2E_NOT_EXECUTED" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 8: report shows failures ──────────────────────────────────────────
test_failures() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  mkdir -p "$dir/.harness/myspec"
  echo '{"executed":3,"passed":2,"failed":1}' > "$dir/.harness/myspec/run.json"
  write_claims "$dir" myspec 1 '{"executed":3,"passed":2,"failed":1,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "failures block" 2 "E2E_FAILED" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 9: tampered counts ────────────────────────────────────────────────
test_tampered_counts() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  mkdir -p "$dir/.harness/myspec"
  echo '{"executed":2,"passed":2,"failed":0}' > "$dir/.harness/myspec/run.json"
  write_claims "$dir" myspec 1 '{"executed":99,"passed":99,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "tampered counts block" 2 "E2E_COUNTS_TAMPERED" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 10: passing case, no code touched ─────────────────────────────────
test_pass_no_code_touched() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  mkdir -p "$dir/.harness/myspec"
  echo '{"executed":1,"passed":1,"failed":0}' > "$dir/.harness/myspec/run.json"
  write_claims "$dir" myspec 1 '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"api","surface":"/api","behavior":"x","proven_by":"x.spec.ts::y"}]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "passing with no code touched" 0 "e2e gate OK" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 11: touched code file with no coverage → block ────────────────────
test_uncovered_code_file() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  # Touch a code file after the start sha.
  (cd "$dir" && mkdir -p src && echo "export const foo = 1" > src/widget.ts && git add -A && git commit -q -m "add widget")
  mkdir -p "$dir/.harness/myspec"
  echo '{"executed":1,"passed":1,"failed":0}' > "$dir/.harness/myspec/run.json"
  write_claims "$dir" myspec 1 '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"api","surface":"/api","behavior":"other","proven_by":"unrelated.spec.ts::x"}]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "uncovered code file blocks" 2 "UNCOVERED_FILES" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 12: touched code file IS covered → pass ───────────────────────────
test_covered_code_file() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  (cd "$dir" && mkdir -p src && echo "export const widget = 1" > src/widget.ts && git add -A && git commit -q -m "add widget")
  mkdir -p "$dir/.harness/myspec"
  echo '{"executed":1,"passed":1,"failed":0}' > "$dir/.harness/myspec/run.json"
  write_claims "$dir" myspec 1 '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"ui","surface":"/x","behavior":"widget works","proven_by":"widget.spec.ts::renders"}]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "covered code file passes" 0 "e2e gate OK" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 13: touched config file is ignored ────────────────────────────────
test_config_file_ignored() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  (cd "$dir" && echo '{"a":1}' > settings.json && git add -A && git commit -q -m "edit config")
  mkdir -p "$dir/.harness/myspec"
  echo '{"executed":1,"passed":1,"failed":0}' > "$dir/.harness/myspec/run.json"
  write_claims "$dir" myspec 1 '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"api","surface":"/x","behavior":"x","proven_by":"x.spec.ts::y"}]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "config file ignored" 0 "e2e gate OK" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 14: touched test file is ignored ──────────────────────────────────
test_test_file_ignored() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  (cd "$dir" && mkdir -p src && echo "test" > src/widget.spec.ts && git add -A && git commit -q -m "add only test")
  mkdir -p "$dir/.harness/myspec"
  echo '{"executed":1,"passed":1,"failed":0}' > "$dir/.harness/myspec/run.json"
  write_claims "$dir" myspec 1 '{"executed":1,"passed":1,"failed":0,"e2e_run":{"runner":"generic","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"api","surface":"/x","behavior":"x","proven_by":"unrelated.spec.ts::y"}]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "test-only file ignored" 0 "e2e gate OK" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 15: vitest report shape parsed correctly ──────────────────────────
test_vitest_runner() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  mkdir -p "$dir/.harness/myspec"
  echo '{"numTotalTests":5,"numPassedTests":5,"numFailedTests":0}' > "$dir/.harness/myspec/run.json"
  write_claims "$dir" myspec 1 '{"executed":5,"passed":5,"failed":0,"e2e_run":{"runner":"vitest","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"api","surface":"/x","behavior":"x","proven_by":"x.spec.ts::y"}]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "vitest runner shape parsed" 0 "e2e gate OK" "$out" "$code"
  rm -rf "$dir"
}

# ── Test 16: playwright report shape parsed correctly ──────────────────────
test_playwright_runner() {
  local dir; dir="$(make_sandbox)"
  local sha; sha="$(cd "$dir" && git rev-parse HEAD)"
  write_breadcrumb "$dir" myspec 1 "$sha"
  mkdir -p "$dir/.harness/myspec"
  cat > "$dir/.harness/myspec/run.json" <<'EOF'
{
  "suites": [{
    "specs": [{
      "tests": [
        {"results":[{"status":"passed"}]},
        {"results":[{"status":"passed"}]}
      ]
    }]
  }]
}
EOF
  write_claims "$dir" myspec 1 '{"executed":2,"passed":2,"failed":0,"e2e_run":{"runner":"playwright","report_path":".harness/myspec/run.json"},"claims":[{"id":"P1-C1","type":"ui","surface":"/x","behavior":"x","proven_by":"x.spec.ts::y"}]}'
  local out code
  out="$(run_hook "$dir")"; code=$?
  assert "playwright runner shape parsed" 0 "e2e gate OK" "$out" "$code"
  rm -rf "$dir"
}

# ── run all ───────────────────────────────────────────────────────────────
echo "Running coder-e2e-gate.sh tests..."
test_no_breadcrumb
test_missing_claims
test_unparseable_claims
test_not_applicable
test_missing_report_path
test_missing_report_file
test_zero_executed
test_failures
test_tampered_counts
test_pass_no_code_touched
test_uncovered_code_file
test_covered_code_file
test_config_file_ignored
test_test_file_ignored
test_vitest_runner
test_playwright_runner

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf 'Failed tests:\n'
  printf '  - %s\n' "${FAILED_NAMES[@]}"
  exit 1
fi
