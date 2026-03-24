#!/bin/bash
# Borrowed from https://gist.githubusercontent.com/stevenc81/efc7b04f4293f429a57758f871962890/raw/f9ef9f2f9d858d4f8d5da253dacc6abcf81bafd9/permission-reviewer.sh
set -euo pipefail

LOG_FILE="/tmp/permission-reviewer.log"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

REVIEWER_MODEL="claude-opus-4-5-20251101"

# --- Cache config ---
CACHE_DIR="/tmp/permission-reviewer-cache"
CACHE_TTL=3600  # 1 hour
mkdir -p "$CACHE_DIR"

# --- Read stdin ---
HOOK_INPUT=$(cat)
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty')
TOOL_INPUT=$(echo "$HOOK_INPUT" | jq -c '.tool_input // {}')
CWD=$(echo "$HOOK_INPUT" | jq -r '.cwd // empty')

# Malformed input -> passthrough
if [ -z "$TOOL_NAME" ]; then
  log "SKIP: malformed input (no tool_name)"
  exit 0
fi

log "HOOK FIRED: tool=$TOOL_NAME cwd=$CWD"

# --- Always ask user for MCP write operations on external services ---
if echo "$TOOL_NAME" | grep -qE '^mcp__.*(create|update|delete|add_message|write|push|merge|assign|move|duplicate)'; then
  log "SKIP: MCP write operation, falling through to manual approval"
  exit 0
fi

# --- Git push guards: always ask user for confirmation ---
if [ "$TOOL_NAME" = "Bash" ]; then
  CMD=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
  if echo "$CMD" | grep -qE 'git\s+push\s+.*--force|git\s+push\s+-f\b'; then
    log "GUARD: force push detected, asking user"
    exit 0
  fi
  if echo "$CMD" | grep -qE 'git\s+push\s+.*(main|master)\b'; then
    log "GUARD: push to main/master detected, asking user"
    exit 0
  fi
fi

# --- Cache lookup ---
# Build cache key from security-relevant fields only (exclude description, timeout, etc.)
if [ "$TOOL_NAME" = "Bash" ]; then
  CACHE_INPUT=$(echo "$TOOL_INPUT" | jq -r '.command // empty')
else
  CACHE_INPUT=$(echo "$TOOL_INPUT" | jq -c 'del(.description, .timeout, .run_in_background)' 2>/dev/null || echo "$TOOL_INPUT")
fi
CACHE_KEY=$(printf '%s\n%s' "$TOOL_NAME" "$CACHE_INPUT" | shasum -a 256 | cut -d' ' -f1)
CACHE_FILE="$CACHE_DIR/$CACHE_KEY"

if [ -f "$CACHE_FILE" ]; then
  CACHE_AGE=$(( $(date +%s) - $(stat -c%Y "$CACHE_FILE" 2>/dev/null || stat -f%m "$CACHE_FILE" 2>/dev/null || echo 0) ))
  if [ "$CACHE_AGE" -lt "$CACHE_TTL" ]; then
    CACHED_DECISION=$(cat "$CACHE_FILE")
    log "CACHE HIT ($CACHE_AGE s old): $CACHED_DECISION"
    if [ "$CACHED_DECISION" = "ask" ]; then
      exit 0
    fi
    echo "$CACHED_DECISION"
    exit 0
  else
    rm -f "$CACHE_FILE"
    log "CACHE EXPIRED ($CACHE_AGE s old)"
  fi
fi

# --- Truncate large tool input (keep first 4000 chars) ---
TRUNCATED_INPUT=$(echo "$TOOL_INPUT" | head -c 4000)

# --- Build reviewer prompt ---
# NOTE: This hook only fires for tool calls NOT matched by allow/deny rules
# in settings.json. Only grey-area commands reach here.
REVIEWER_PROMPT="You are a security reviewer for an AI coding assistant. Review this tool call and decide: approve, ask, or deny.

TOOL: ${TOOL_NAME}
CWD: ${CWD}
INPUT: ${TRUNCATED_INPUT}

APPROVE if:
- Standard dev commands (npm test/install/build, make, cargo, pip, etc.)
- Package installs, build steps, linters, formatters, type checkers
- git operations that are non-destructive (add specific files, commit, stash, rebase, checkout)
- curl/wget GET requests to public URLs
- General-purpose CLI tools used non-destructively
- 'source .env' or '. .env' (loading env vars into shell is safe)

DENY (hard block) ONLY for truly dangerous operations:
- Accessing or exfiltrating credentials/secrets (~/.ssh, ~/.aws, tokens, API keys)
- Piping secrets to external services
- Mass/recursive deletion outside safe targets (node_modules, dist, build, .cache)
- Obfuscated commands (base64 decode | bash, eval of encoded strings)
- curl | bash patterns (downloading and executing remote scripts)
- Reading/writing .env files directly (cat/grep/sed/echo to .env)
- Blanket git staging: 'git add -A', 'git add --all', 'git add .', 'git add *'

When DENYING .env access, include this in your reasoning:
  Use env-safe CLI instead: env-safe list, env-safe check KEY, env-safe validate.
  To use env vars in commands: source .env && <command>

When DENYING blanket git add, include in your reasoning:
  Stage specific files by name instead of using blanket patterns.

ASK (let user decide) for anything uncertain:
- curl/wget POST/PUT/DELETE requests
- Force push, destructive git operations
- Destructive database operations
- git add of untracked/new files
- Anything not clearly safe but not clearly dangerous

When in doubt, ASK -- never deny.

Respond with ONLY a JSON object: {\"decision\":\"approve\" or \"ask\" or \"deny\", \"reasoning\":\"brief explanation\"}"

# --- Call reviewer ---
REVIEWER_OUTPUT=""
if REVIEWER_OUTPUT=$(env -u CLAUDECODE "$HOME/.claude/local/claude" -p \
  --output-format json \
  --model "$REVIEWER_MODEL" \
  --tools "" \
  --no-session-persistence \
  --dangerously-skip-permissions \
  "$REVIEWER_PROMPT" 2>/dev/null); then
  :
else
  log "REVIEWER CALL FAILED, falling through to manual approval"
  exit 0
fi

# --- Parse response ---
RESULT_TEXT=$(echo "$REVIEWER_OUTPUT" | jq -r '.result // empty' 2>/dev/null)
if [ -z "$RESULT_TEXT" ]; then
  RESULT_TEXT="$REVIEWER_OUTPUT"
fi

CLEAN_JSON="$RESULT_TEXT"
if ! echo "$CLEAN_JSON" | jq -e '.decision' >/dev/null 2>&1; then
  CLEAN_JSON=$(echo "$RESULT_TEXT" | sed '/^```/d')
fi

DECISION=$(echo "$CLEAN_JSON" | jq -r '.decision // empty' 2>/dev/null)
REASONING=$(echo "$CLEAN_JSON" | jq -r '.reasoning // "No reasoning provided"' 2>/dev/null)

# --- Emit hook decision ---
log "DECISION: $DECISION | REASONING: $REASONING"

OUTPUT=""
if [ "$DECISION" = "approve" ]; then
  OUTPUT='{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
elif [ "$DECISION" = "deny" ]; then
  OUTPUT=$(jq -n --arg reason "$REASONING" \
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":$reason}}}')
else
  echo "ask" > "$CACHE_FILE"
  log "CACHED: $CACHE_KEY -> ask"
  exit 0
fi

echo "$OUTPUT" > "$CACHE_FILE"
log "CACHED: $CACHE_KEY -> $DECISION"
echo "$OUTPUT"
exit 0
