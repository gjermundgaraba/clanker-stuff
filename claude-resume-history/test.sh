#!/bin/bash
# Self-check for resume-history.sh. Run: bash test.sh
set -eu
cd "$(dirname "$0")"

inbox=$(mktemp -d)
trap 'rm -rf "$inbox"' EXIT

run() {
  printf '{"session_id":"%s","reason":"%s"}' "$2" "$1" |
    PI_SHELL_RESUME_HISTORY_DIR="$inbox" bash resume-history.sh
}

run prompt_input_exit abc-123
[ "$(cat "$inbox"/*.command)" = "claude --resume abc-123" ] ||
  { echo "FAIL: expected resume command in inbox"; exit 1; }
rm "$inbox"/*.command

run clear abc-123
ls "$inbox"/*.command >/dev/null 2>&1 &&
  { echo "FAIL: clear must not enqueue"; exit 1; }

printf '{"session_id":"x","reason":"prompt_input_exit"}' |
  PI_SHELL_RESUME_HISTORY_DIR="" bash resume-history.sh ||
  { echo "FAIL: missing inbox must exit 0"; exit 1; }

echo OK
