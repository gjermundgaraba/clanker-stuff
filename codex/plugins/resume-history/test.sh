#!/bin/bash
# Self-check for the SessionEnd hook. Run: bash test.sh
set -eu
cd "$(dirname "$0")"

inbox=$(mktemp -d)
trap 'rm -rf "$inbox"' EXIT

printf '{"session_id":"abc-123","reason":"other"}' |
  PI_SHELL_RESUME_HISTORY_DIR="$inbox" bash scripts/resume-history.sh
[ "$(cat "$inbox"/*.command)" = "codex resume abc-123" ]
rm "$inbox"/*.command

printf '{"session_id":"bad; command","reason":"other"}' |
  PI_SHELL_RESUME_HISTORY_DIR="$inbox" bash scripts/resume-history.sh
if find "$inbox" -name '*.command' -print -quit | grep -q .; then
  echo "FAIL: unsafe session ID was enqueued" >&2
  exit 1
fi

echo OK
