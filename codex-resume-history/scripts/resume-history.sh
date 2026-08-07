#!/bin/bash
# Codex SessionEnd hook: enqueue a resume command for the invoking shell.
set -u

inbox="${PI_SHELL_RESUME_HISTORY_DIR:-}"
[ -n "$inbox" ] && [ -d "$inbox" ] || exit 0

sid=$(jq -r '.session_id // empty')
case "$sid" in
  "" | *[!a-zA-Z0-9_-]*) exit 0 ;;
esac

name="$(date +%s)-$$-${RANDOM}.command"
tmp="$inbox/.$name.tmp"
printf 'codex resume %s\n' "$sid" >"$tmp" || exit 0
mv "$tmp" "$inbox/$name" || rm -f "$tmp"
