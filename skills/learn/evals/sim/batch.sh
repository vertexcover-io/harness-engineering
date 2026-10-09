#!/bin/sh
# Runs "<scenario> <n>" jobs from stdin, 6 at a time, into $SIM_OUT (default: a temp folder).
# Each run writes $SIM_OUT/<scenario>/<n>/result.json and conversation.md; the verdict is printed.
cd "$(dirname "$0")"
out="${SIM_OUT:-${TMPDIR:-/tmp}/learn-sim-results}"
mkdir -p "$out"
xargs -P 6 -L 1 sh -c 'node run.mjs "$0" "'"$out"'/$0/$1" 2>&1 | head -1'
