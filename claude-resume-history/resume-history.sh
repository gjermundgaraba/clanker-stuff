#!/bin/bash
# Claude Code SessionEnd hook: enqueue a resume command into the invoking
# shell's history inbox (see shell-resume-history/shell/ for the drain side).
set -u

inbox="${PI_SHELL_RESUME_HISTORY_DIR:-}"
[ -n "$inbox" ] && [ -d "$inbox" ] || exit 0

json=$(cat)
reason=$(jq -r '.reason // empty' <<<"$json")
case "$reason" in
  prompt_input_exit | other) ;;
  *) exit 0 ;;
esac

sid=$(jq -r '.session_id // empty' <<<"$json")
[ -n "$sid" ] || exit 0

name="$(date +%s)-$$-${RANDOM}.command"
tmp="$inbox/.$name.tmp"
printf 'claude --resume %s\n' "$sid" >"$tmp" || exit 0
mv "$tmp" "$inbox/$name"
