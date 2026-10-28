#!/bin/bash
set -u

inbox="${PI_SHELL_RESUME_HISTORY_DIR:-}"
[ -d "$inbox" ] || exit 0

sid=$(jq -r '.session_id // empty')
[[ "$sid" =~ ^[A-Za-z0-9_-]+$ ]] || exit 0

name="$(date +%s)-$$-${RANDOM}.command"
tmp="$inbox/.$name.tmp"
printf 'claude --resume %s\n' "$sid" >"$tmp" || exit 0
mv "$tmp" "$inbox/$name"
